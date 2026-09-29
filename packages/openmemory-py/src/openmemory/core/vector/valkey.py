
from typing import List, Optional, Dict, Any
import json
import logging
import asyncio
import numpy as np
from urllib.parse import quote
from ..vector_store import VectorStore, VectorRow
from ..embedding_contract import validate_vector, validate_provenance

logger = logging.getLogger("vector_store.valkey")

class ValkeyVectorStore(VectorStore):
    def __init__(self, url: str, prefix: str = "om:vec:"):
        self.url = url
        self.prefix = prefix
        self.client = None

    async def _get_client(self):
        import redis.asyncio as redis
        if not self.client:
            self.client = redis.from_url(self.url)
        return self.client

    def _key(self, id: str, sector: Optional[str] = None) -> str:
        if sector is None:
            return f"{self.prefix}{id}"  # Legacy single-sector key remains readable.
        return f"{self.prefix}v2:{quote(id, safe='')}:{quote(sector, safe='')}"

    async def _keys(self, id: str):
        client = await self._get_client()
        keys = [self._key(id)]
        async for key in client.scan_iter(match=f"{self.prefix}v2:{quote(id, safe='')}:*", count=100):
            keys.append(key)
        return keys

    async def storeVector(self, id: str, sector: str, vector: List[float], dim: int, user_id: Optional[str] = None, provenance: Optional[Dict[str, Any]] = None):
        validate_vector(vector, dim)
        validate_provenance(provenance, sector, dim)
        client = await self._get_client()
        key = self._key(id, sector)
        vec_bytes = np.array(vector, dtype=np.float32).tobytes()

        mapping = {
            "id": id,
            "sector": sector,
            "dim": dim,
            "v": vec_bytes,
            "user_id": user_id or "",
            "provenance": json.dumps(provenance)
        }
        await client.hset(key, mapping=mapping)

    async def getVectorsById(self, id: str) -> List[VectorRow]:
        client = await self._get_client()
        rows = {}
        # Legacy first; a new-format sector replaces it without deleting history.
        for key in await self._keys(id):
            data = await client.hgetall(key)
            if not data: continue
            def dec(x): return x.decode('utf-8') if isinstance(x, bytes) else str(x)
            if dec(data.get(b'id') or data.get('id')) != id: continue
            sector = dec(data.get(b'sector') or data.get('sector'))
            vec = np.frombuffer(data.get(b'v') or data.get('v'), dtype=np.float32).tolist()
            rows[sector] = VectorRow(id, sector, vec,
                int(dec(data.get(b'dim') or data.get('dim'))),
                json.loads(data.get(b'provenance') or data.get('provenance') or "null"))
        return list(rows.values())

    async def getVector(self, id: str, sector: str) -> Optional[VectorRow]:
        rows = await self.getVectorsById(id)
        for r in rows:
            if r.sector == sector:
                return r
        return None

    async def deleteVectors(self, id: str):
        client = await self._get_client()
        await client.delete(*(await self._keys(id)))

    async def search(self, vector: List[float], sector: str, k: int, filter: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
        validate_vector(vector, len(vector))
        client = await self._get_client()
        query_vec = np.array(vector, dtype=np.float32)
        q_norm = np.linalg.norm(query_vec)

        cursor = 0
        results = {}

        while True:
            cursor, keys = await client.scan(cursor, match=f"{self.prefix}*", count=100)
            if keys:
                pipe = client.pipeline()
                for key in keys:
                    pipe.hgetall(key)
                items = await pipe.execute()

                for key, item in zip(keys, items):
                    if not item: continue
                    def dec(x): return x.decode('utf-8') if isinstance(x, bytes) else str(x)

                    i_sector = dec(item.get(b'sector') or item.get('sector'))
                    if i_sector != sector: continue
                    mid = dec(item.get(b'id') or item.get('id'))
                    canonical = self._key(mid, i_sector)
                    if dec(key) != canonical and await client.exists(canonical): continue

                    if filter and filter.get("user_id"):
                        i_uid = dec(item.get(b'user_id') or item.get('user_id'))
                        if i_uid != filter["user_id"]: continue

                    v_bytes = item.get(b'v') or item.get('v')
                    v = np.frombuffer(v_bytes, dtype=np.float32)
                    if len(v) != len(vector): continue

                    dot = np.dot(query_vec, v)
                    norm = np.linalg.norm(v)
                    sim = dot / (q_norm * norm) if (q_norm * norm) > 0 else 0

                    results[mid] = {
                        "id": mid,
                        "similarity": float(sim)
                    }

            if cursor == 0: break

        return sorted(results.values(), key=lambda x: x["similarity"], reverse=True)[:k]
