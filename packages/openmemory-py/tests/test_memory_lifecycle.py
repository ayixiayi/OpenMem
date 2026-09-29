"""Public deletion, fresh reads and graph ownership regressions."""

import sqlite3
import time
from unittest.mock import AsyncMock

import pytest

from openmemory.core.db import db, q
from openmemory.main import Memory
from openmemory.memory import hsg
from openmemory import main


@pytest.fixture
def connection(monkeypatch):
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    monkeypatch.setattr(db, "conn", conn)
    db.run_migrations()
    yield conn
    conn.close()


def seed(conn, mid, user):
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO memories(id,user_id,content,primary_sector,salience,last_seen_at,tags,meta) VALUES (?,?,?,'semantic',0.4,?,'[]','{}')",
        (mid, user, mid, now),
    )


@pytest.mark.asyncio
async def test_delete_external_failure_and_paging(connection, monkeypatch):
    memory = Memory.__new__(Memory)
    memory.default_user = "alice"
    for i in range(103):
        seed(connection, f"a{i}", "alice")
    seed(connection, "bob", "bob")
    external_delete = AsyncMock(side_effect=RuntimeError("offline"))
    monkeypatch.setattr(main.vector_store, "deleteVectors", external_delete)
    with pytest.raises(RuntimeError, match="offline"):
        await memory.delete("a0")
    assert q.get_mem("a0") is not None
    external_delete.reset_mock(side_effect=True)
    await memory.delete_all()
    assert q.all_mem_by_user("alice", 1000) == []
    assert q.get_mem("bob") is not None
    assert {call.args[0] for call in external_delete.await_args_list} == {
        f"a{i}" for i in range(103)
    }


@pytest.mark.asyncio
async def test_graph_scope_budget_and_reinforcement(connection, monkeypatch):
    for mid, user in [("a", "alice"), ("b", "alice"), ("c", "bob"), ("d", "alice")]:
        seed(connection, mid, user)
    for src, dst, weight in [
        ("a", "a", 1),
        ("a", "c", 1),
        ("a", "b", 0.8),
        ("b", "c", 1),
        ("c", "d", 1),
    ]:
        connection.execute(
            "INSERT INTO waypoints(src_id,dst_id,weight) VALUES (?,?,?)",
            (src, dst, weight),
        )
    assert [r["id"] for r in await hsg.expand_via_waypoints(["a"], 1)] == ["b"]
    assert [r["id"] for r in await hsg.expand_via_waypoints(["a"], 10)] == ["b"]
    before = dict(q.get_mem("c"))
    monkeypatch.setattr(
        hsg.store, "search", AsyncMock(return_value=[{"id": "a", "similarity": 0.1}])
    )
    monkeypatch.setattr(hsg, "on_query_hit", AsyncMock())
    results = await hsg.hsg_query("b", 2, {"user_id": "alice", "sectors": ["semantic"]})
    assert {r["id"] for r in results} == {"a", "b"}
    assert next(r for r in results if r["id"] == "b")["path"] == ["a", "b"]
    assert dict(q.get_mem("c")) == before


@pytest.mark.asyncio
async def test_queries_read_current_content_without_filters(connection, monkeypatch):
    seed(connection, "live", "alice")
    monkeypatch.setattr(
        hsg.store, "search", AsyncMock(return_value=[{"id": "live", "similarity": 0.9}])
    )
    monkeypatch.setattr(hsg, "on_query_hit", AsyncMock())
    assert (await hsg.hsg_query("fresh"))[0]["content"] == "live"
    connection.execute("UPDATE memories SET content='changed' WHERE id='live'")
    assert (await hsg.hsg_query("fresh"))[0]["content"] == "changed"
    q.del_mem("live")
    assert await hsg.hsg_query("fresh") == []


@pytest.mark.asyncio
async def test_cold_decay_preserves_search_vectors(connection, monkeypatch):
    from openmemory.memory import decay

    monkeypatch.setattr(decay, "last_decay", 0)
    monkeypatch.setattr(decay.env, "decay_ratio", 1)
    seed(connection, "cold", "alice")
    seed(connection, "zero", "alice")
    old = int(time.time() * 1000) - 90 * 86400000
    connection.execute(
        "UPDATE memories SET last_seen_at=?,updated_at=? WHERE id='cold'", (old, old)
    )
    connection.execute("UPDATE memories SET salience=0 WHERE id='zero'")
    vector = [0.25, -0.5] * 64
    provenance = {
        "schema_version": 1,
        "provider": "synthetic",
        "model": "fixture",
        "sector": "semantic",
        "dimensions": 128,
        "transform": "identity-v1",
    }
    await decay.store.storeVector("cold", "semantic", vector, 128, "alice", provenance)
    before = dict(
        connection.execute("SELECT * FROM vectors WHERE id='cold'").fetchone()
    )
    await decay.apply_decay()
    assert (
        dict(connection.execute("SELECT * FROM vectors WHERE id='cold'").fetchone())
        == before
    )
    cold = q.get_mem("cold")
    assert cold["content"] == "cold" and cold["salience"] < 0.4
    assert 0 < len(cold["compressed_vec"]) < 128 * 4
    assert q.get_mem("zero")["salience"] == 0
    assert (await decay.store.search(vector, "semantic", 1, {"user_id": "alice"}))[0][
        "id"
    ] == "cold"
    await decay.store.storeVector("cold", "emotional", [1, 0, 0], 3, "alice")
    fusion = await hsg.calc_multi_vec_fusion_score(
        "cold",
        {"semantic": vector, "emotional": vector},
        {"semantic_dimension_weight": 1, "emotional_dimension_weight": 1},
    )
    assert fusion == pytest.approx(1)
