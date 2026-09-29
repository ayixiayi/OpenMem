import asyncio
import time
import math
from typing import List, Dict, Optional, Any, Tuple
import numpy as np
import httpx

from ..core.config import env
from ..core.models import get_model
from ..core.db import q
from ..core.embedding_contract import validate_vector
from ..core.constants import SECTOR_CONFIGS, SEC_WTS
from ..utils.text import canonical_tokens_from_text, synonyms_for, canonicalize_token
from ..utils.vectors import vec_to_buf, buf_to_vec

from ..ai.openai import OpenAIAdapter
from ..ai.ollama import OllamaAdapter
from ..ai.gemini import GeminiAdapter
from ..ai.aws import AwsAdapter
from ..ai.synthetic import SyntheticAdapter
from ..ai.minimax import MiniMaxAdapter

async def emb_dispatch(provider: str, t: str, s: str) -> List[float]:
    return (await embed_with_provenance(provider, t, s))["vector"]


async def embed_with_provenance(provider: str, t: str, s: str) -> Dict[str, Any]:
    transform = "identity-v1"
    if provider == "openai":
        adapter, model = OpenAIAdapter(), env.openai_model or "text-embedding-3-small"
    elif provider == "ollama":
        adapter, model = OllamaAdapter(), env.ollama_embedding_model or "nomic-embed-text"
    elif provider == "gemini":
        adapter, model = GeminiAdapter(), env.gemini_embedding_model or "models/text-embedding-004"
        if "models/" not in model:
            model = f"models/{model}"
        transform = "identity-v1:SEMANTIC_SIMILARITY"
    elif provider == "aws":
        adapter, model = AwsAdapter(), env.aws_embedding_model or "amazon.titan-embed-text-v2:0"
        transform = "provider-normalize-v1"
    elif provider == "minimax":
        adapter, model = MiniMaxAdapter(), env.minimax_embedding_model or "embo-01"
        transform = "identity-v1:query"
    else:
        # Preserve the legacy unknown-provider fallback, recording what ran.
        provider, model = "synthetic", "openmemory-py-synthetic-v1"
        adapter = SyntheticAdapter(env.vec_dim or 768)
    vector = await adapter.embed(t, model=s if provider == "synthetic" else model)
    validate_vector(vector, len(vector) if vector is not None else 0)
    return {
        "vector": vector,
        "provenance": {
            "schema_version": 1,
            "provider": provider,
            "model": model,
            "sector": s,
            "dimensions": len(vector),
            "transform": transform,
        },
    }

async def embed_for_sector(t: str, s: str) -> List[float]:
    if s not in SECTOR_CONFIGS: raise Exception(f"Unknown sector: {s}")

    return await emb_dispatch(env.emb_kind or "synthetic", t, s)

async def embed_multi_sector(id: str, txt: str, secs: List[str], chunks: Optional[List[dict]] = None) -> List[Dict[str, Any]]:
    q.ins_log(id=id, model="multi-sector", status="pending", ts=int(time.time()*1000), err=None)

    res = []
    try:
        for s in secs:
            if s not in SECTOR_CONFIGS:
                raise ValueError(f"Unknown sector: {s}")
            result = await embed_with_provenance(env.emb_kind or "synthetic", txt, s)
            res.append({"sector": s, **result, "dim": len(result["vector"])})

        q.upd_log(id=id, status="completed", err=None)
        return res
    except Exception as e:
        q.upd_log(id=id, status="failed", err=str(e))
        raise e
def calc_mean_vec(emb_res: List[Dict[str, Any]], all_sectors: List[str]) -> List[float]:
    if not emb_res: return []
    d = emb_res[0]["dim"]
    mean = np.zeros(d, dtype=np.float32)
    for r in emb_res:
         mean += np.array(r["vector"], dtype=np.float32)
    mean /= len(emb_res)
    return mean.tolist()
