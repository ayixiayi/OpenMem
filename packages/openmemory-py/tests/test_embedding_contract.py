"""Generation and persistence contracts without provider credentials or network."""

import sqlite3
import struct
from importlib import resources

import pytest

from openmemory.core.db import db
from openmemory.core.embedding_contract import validate_vector
from openmemory.core.vector_store import SQLiteVectorStore
from openmemory.memory import embed


@pytest.fixture
def connection(monkeypatch):
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    monkeypatch.setattr(db, "conn", conn)
    yield conn
    conn.close()


def test_legacy_vectors_stay_unknown(connection):
    files = resources.files("openmemory.migrations")
    connection.executescript(files.joinpath("001_initial.sql").read_text())
    raw = struct.pack("3f", 0.25, -0.75, 1.5)
    connection.execute(
        "INSERT INTO vectors(id,sector,v,dim) VALUES ('old','semantic',?,3)", (raw,)
    )
    connection.executescript(files.joinpath("004_embedding_provenance.sql").read_text())
    row = connection.execute("SELECT * FROM vectors").fetchone()
    assert row["v"] == raw and row["provenance"] is None


@pytest.mark.asyncio
async def test_generation_and_storage(connection, monkeypatch):
    db.run_migrations()
    calls = []

    class Adapter:
        async def embed(self, text, model):
            calls.append(model)
            return [0.25, -0.75, 1.5]

    monkeypatch.setattr(embed, "OpenAIAdapter", Adapter)
    monkeypatch.setattr(embed.env, "openai_model", "fixture-model-a")
    first = await embed.embed_with_provenance("openai", "alpha", "semantic")
    assert first["provenance"]["model"] == "fixture-model-a"
    assert first["provenance"]["dimensions"] == 3
    monkeypatch.setattr(embed.env, "openai_model", "fixture-model-b")
    second = await embed.embed_with_provenance("openai", "beta", "semantic")
    assert second["provenance"]["model"] == "fixture-model-b"
    assert calls == ["fixture-model-a", "fixture-model-b"]
    assert await embed.emb_dispatch("openai", "alpha", "semantic") == first["vector"]
    fallback = await embed.embed_with_provenance(
        "unknown-provider", "alpha", "semantic"
    )
    assert fallback["provenance"]["provider"] == "synthetic"
    assert fallback["provenance"]["model"] == "openmemory-py-synthetic-v1"

    store = SQLiteVectorStore()
    await store.storeVector(
        "stored", "semantic", first["vector"], 3, "alice", first["provenance"]
    )
    assert (await store.getVector("stored", "semantic")).provenance == first[
        "provenance"
    ]
    assert (await store.getVectorsById("stored"))[0].provenance == first["provenance"]
    with pytest.raises(ValueError, match="provenance"):
        await store.storeVector(
            "stored", "semantic", [1, 2], 2, "alice", first["provenance"]
        )
    assert (await store.getVector("stored", "semantic")).vector == first["vector"]
    await store.storeVector("stored", "semantic", [2, 3, 4], 3, "alice")
    assert (await store.getVector("stored", "semantic")).provenance is None
    connection.execute(
        "INSERT INTO memories(id,user_id,content,primary_sector) VALUES ('stored','alice','original content','semantic')"
    )
    from openmemory.memory.decay import on_query_hit

    async def regenerate(text):
        return first

    await on_query_hit("stored", "semantic", regenerate)
    assert (
        connection.execute("SELECT user_id FROM vectors WHERE id='stored'").fetchone()[
            "user_id"
        ]
        == "alice"
    )
    assert (await store.getVector("stored", "semantic")).provenance == first[
        "provenance"
    ]

    monkeypatch.setattr(embed.env, "emb_kind", "openai")
    batch = await embed.embed_multi_sector(
        "batch", "content", ["semantic", "reflective"]
    )
    assert [r["provenance"]["sector"] for r in batch] == ["semantic", "reflective"]


@pytest.mark.parametrize(
    "vector,dim",
    [
        ([], 0),
        ([float("nan")], 1),
        ([float("inf")], 1),
        ([1e100], 1),
        ([True], 1),
        ([1, 2], 3),
    ],
)
def test_invalid_vectors(vector, dim):
    with pytest.raises(ValueError, match="finite vector"):
        validate_vector(vector, dim)


@pytest.mark.asyncio
async def test_redis_scan_duplicate_keys(monkeypatch):
    from unittest.mock import AsyncMock, MagicMock
    from openmemory.core.vector.valkey import ValkeyVectorStore

    store = ValkeyVectorStore("unused")
    key = store._key("owned", "semantic").encode()
    item = {
        b"id": b"owned",
        b"sector": b"semantic",
        b"user_id": b"alice",
        b"v": struct.pack("3f", 1, 2, 3),
    }
    client = MagicMock()
    client.scan = AsyncMock(side_effect=[(1, [key]), (0, [key])])
    client.pipeline.return_value.execute = AsyncMock(return_value=[item])
    monkeypatch.setattr(store, "_get_client", AsyncMock(return_value=client))
    hits = await store.search([1, 2, 3], "semantic", 3, {"user_id": "alice"})
    assert [r["id"] for r in hits] == ["owned"]
