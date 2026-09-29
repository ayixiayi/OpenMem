"""Opt-in integration tests: disposable local services only, unique owned namespaces."""

import asyncio
import os
import struct
from uuid import uuid4

import pytest


async def exercise(store):
    provenance = {
        "schema_version": 1,
        "provider": "fixture",
        "model": "model-a",
        "sector": "semantic",
        "dimensions": 3,
        "transform": "identity-v1",
    }
    await store.storeVector(
        "owned", "semantic", [0.25, -0.75, 1.5], 3, "alice", provenance
    )
    await store.storeVector("owned", "reflective", [1, 0, 0], 3, "alice")
    await store.storeVector("wrong-dimension", "semantic", [1, 0], 2, "alice")
    await store.storeVector("foreign", "semantic", [0.25, -0.75, 1.5], 3, "bob")
    assert len(await store.getVectorsById("owned")) == 2
    row = await store.getVector("owned", "semantic")
    assert row.vector == [0.25, -0.75, 1.5] and row.provenance == provenance
    hits = await store.search([-0.25, 0.75, -1.5], "semantic", 3, {"user_id": "alice"})
    assert [r["id"] for r in hits] == ["owned"]
    assert hits[0]["similarity"] == pytest.approx(-1)
    await store.storeVector("owned", "semantic", [3, 2, 1], 3, "alice")
    assert (await store.getVector("owned", "semantic")).provenance is None
    for mid in ("owned", "wrong-dimension", "foreign"):
        await store.deleteVectors(mid)
        assert await store.getVectorsById(mid) == []


@pytest.mark.asyncio
async def test_postgres_legacy_upgrade_and_multi_sector():
    socket = os.environ.get("OM_TEST_PG_SOCKET")
    if not socket or not socket.startswith("/"):
        pytest.skip("Set OM_TEST_PG_SOCKET to a disposable local PostgreSQL socket")
    import asyncpg
    from openmemory.core.vector.postgres import PostgresVectorStore

    connection = await asyncpg.connect(
        host=socket, port=55439, user="om_test", database="postgres"
    )
    schema = "py_vector_" + uuid4().hex
    dsn = f"postgresql://om_test@/postgres?host={socket}&port=55439"
    stores = [PostgresVectorStore(dsn, f"{schema}.vectors") for _ in range(2)]
    try:
        await connection.execute(f"CREATE SCHEMA {schema}")
        await connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await connection.execute(
            f"CREATE TABLE {schema}.vectors(id TEXT PRIMARY KEY,sector TEXT NOT NULL,user_id TEXT,v vector,dim integer)"
        )
        await connection.execute(
            f"INSERT INTO {schema}.vectors VALUES ('old','semantic','legacy','[1,2,3]',3)"
        )
        await asyncio.gather(*(store._get_pool() for store in stores))
        old = await stores[0].getVector("old", "semantic")
        assert old.vector == [1, 2, 3] and old.provenance is None
        await exercise(stores[0])
        assert (await stores[1].getVector("old", "semantic")).vector == [1, 2, 3]
    finally:
        for store in stores:
            if store.pool:
                await store.pool.close()
        await connection.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
        await connection.close()


@pytest.mark.asyncio
async def test_redis_legacy_read_and_multi_sector():
    if os.environ.get("OM_TEST_REDIS_PORT") != "56379":
        pytest.skip("Set OM_TEST_REDIS_PORT=56379 for a disposable Redis server")
    from openmemory.core.vector.valkey import ValkeyVectorStore

    prefix = "py_vector_" + uuid4().hex + ":"
    store = ValkeyVectorStore("redis://127.0.0.1:56379/0", prefix)
    client = await store._get_client()
    try:
        # Old layout is not rewritten. A new-format value wins for the same sector.
        await client.hset(
            store._key("owned"),
            mapping={
                "id": "owned",
                "sector": "semantic",
                "user_id": "alice",
                "dim": 3,
                "v": struct.pack("3f", 1, 2, 3),
            },
        )
        old = await store.getVector("owned", "semantic")
        assert old.vector == [1, 2, 3] and old.provenance is None
        await exercise(store)
        assert not await client.exists(store._key("owned"))
    finally:
        keys = [key async for key in client.scan_iter(match=f"{prefix}*")]
        if keys:
            await client.delete(*keys)
        await client.aclose()
