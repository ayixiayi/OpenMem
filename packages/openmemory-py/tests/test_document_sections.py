"""Document membership regressions against disposable databases."""

import json
import sqlite3
from importlib import resources

import pytest

from openmemory.core.db import db, q
from openmemory.ops.ingest import ingest_document, link


@pytest.fixture
def connection(monkeypatch):
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    monkeypatch.setattr(db, "conn", conn)
    yield conn
    conn.close()


def test_conservative_backfill(connection):
    migrations = resources.files("openmemory.migrations")
    connection.executescript(migrations.joinpath("001_initial.sql").read_text())
    for mid, user, meta in [
        ("root", "alice", {"is_root": True}),
        ("child", "alice", {"is_child": True, "parent_id": "root", "section_index": 0}),
        ("a", "alice", {"is_child": True, "parent_id": "root", "section_index": 1}),
        ("b", "alice", {"is_child": True, "parent_id": "root", "section_index": 1}),
        ("foreign", "bob", {"is_child": True, "parent_id": "root", "section_index": 2}),
    ]:
        connection.execute(
            "INSERT INTO memories(id,user_id,meta) VALUES (?,?,?)",
            (mid, user, json.dumps(meta)),
        )
    connection.execute("INSERT INTO memories(id,meta) VALUES ('bad','invalid-json')")
    before = list(connection.execute("SELECT * FROM memories ORDER BY id"))
    connection.executescript(
        migrations.joinpath("003_document_sections.sql").read_text()
    )
    assert [
        tuple(r) for r in connection.execute("SELECT * FROM document_sections")
    ] == [("root", 0, "child")]
    assert list(connection.execute("SELECT * FROM memories ORDER BY id")) == before


@pytest.mark.asyncio
async def test_reimport_ownership_and_metadata(connection):
    db.run_migrations()
    metadata = {"source": "fixture"}
    text = "Oranges grow in a warm orchard.\n\nSatellites orbit distant planets."
    cfg = {"force_root": True, "sec_sz": 40}
    first = await ingest_document("text", text, metadata, cfg, "alice")
    second = await ingest_document("text", text, metadata, cfg, "alice")
    foreign = await ingest_document("text", text, metadata, cfg, "bob")
    assert metadata == {"source": "fixture"}
    roots = [r["root_memory_id"] for r in (first, second, foreign)]
    children = [[dict(c) for c in q.get_document_sections(root)] for root in roots]
    assert [r["child_count"] for r in (first, second, foreign)] == [2, 2, 2]
    assert [c["id"] for c in children[0]] == [c["id"] for c in children[1]]
    assert set(c["id"] for c in children[0]).isdisjoint(c["id"] for c in children[2])
    assert [c["section_index"] for c in children[1]] == [0, 1]
    assert all(json.loads(c["meta"])["parent_id"] == roots[0] for c in children[1])
    assert "2 sections" in q.get_mem(roots[0])["content"]
    q.del_mem(roots[0])
    assert q.get_document_sections(roots[0]) == []
    assert len(q.get_document_sections(roots[1])) == 2
    assert all(q.get_mem(c["id"]) for c in children[0])


@pytest.mark.asyncio
async def test_link_failure_rolls_back_membership(connection):
    db.run_migrations()
    connection.execute(
        "CREATE TRIGGER fail_waypoint BEFORE INSERT ON waypoints BEGIN SELECT RAISE(ABORT,'injected'); END"
    )
    with pytest.raises(sqlite3.IntegrityError, match="injected"):
        await link("root", "child", 0, "alice")
    assert list(connection.execute("SELECT * FROM document_sections")) == []
    assert not connection.in_transaction
