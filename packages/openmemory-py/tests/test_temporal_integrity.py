"""Offline temporal regressions using disposable SQLite connections only."""

import json
import sqlite3
from contextlib import asynccontextmanager
from importlib import resources
from types import SimpleNamespace

import pytest

from openmemory.core.db import db
from openmemory.temporal_graph import query, store


@pytest.fixture
def connection(monkeypatch):
    conn = sqlite3.connect(":memory:", isolation_level=None)
    conn.row_factory = sqlite3.Row
    monkeypatch.setattr(db, "conn", conn)
    yield conn
    conn.close()


def test_legacy_upgrade_preserves_data_and_is_repeatable(connection):
    initial = (
        resources.files("openmemory.migrations").joinpath("001_initial.sql").read_text()
    )
    connection.executescript(initial)
    connection.execute(
        "CREATE TABLE _migrations(name TEXT PRIMARY KEY, applied_at INTEGER)"
    )
    connection.execute("INSERT INTO _migrations VALUES ('001_initial.sql', 1)")
    connection.execute(
        "INSERT INTO temporal_facts VALUES ('old', 'Alice', 'city', 'Paris', 1000, 1999, 0.7, ?)",
        ('{"source":"legacy"}',),
    )
    connection.execute(
        "INSERT INTO temporal_edges VALUES ('old', 'old', 'supports', 1000, NULL, 0.4, NULL)"
    )
    db.run_migrations()
    fact = query.format_fact(db.fetchone("SELECT * FROM temporal_facts WHERE id='old'"))
    assert fact == {
        "id": "old",
        "user_id": None,
        "subject": "Alice",
        "predicate": "city",
        "object": "Paris",
        "valid_from": 1000,
        "valid_to": 1999,
        "confidence": 0.7,
        "last_updated": None,
        "metadata": {"source": "legacy"},
    }
    edge = dict(db.fetchone("SELECT * FROM temporal_edges"))
    assert edge["id"] and edge["relation_type"] == "supports"
    assert (edge["source_id"], edge["target_id"], edge["weight"]) == ("old", "old", 0.4)
    db.run_migrations()
    assert dict(db.fetchone("SELECT * FROM temporal_edges")) == edge
    assert db.fetchone("SELECT count(*) AS n FROM _migrations")["n"] == 4


def test_migration_failure_rolls_back_schema_and_marker(
    connection, monkeypatch, tmp_path
):
    db.run_migrations()
    # Inject a migration that fails after DDL: neither the DDL nor its marker may survive.
    (tmp_path / "003_failure.sql").write_text(
        "ALTER TABLE temporal_facts ADD COLUMN partial TEXT;\nSELECT * FROM absent_table;"
    )
    monkeypatch.setattr(resources, "files", lambda package: tmp_path)
    with pytest.raises(sqlite3.OperationalError, match="absent_table"):
        db.run_migrations()
    assert "partial" not in {
        r["name"] for r in connection.execute("PRAGMA table_info(temporal_facts)")
    }
    assert db.fetchone("SELECT 1 FROM _migrations WHERE name='003_failure.sql'") is None
    assert not connection.in_transaction


@pytest.mark.asyncio
async def test_new_database_scope_queries_and_edges(connection):
    db.run_migrations()
    a = await store.insert_fact(
        "person", "city", "Paris", 1000, metadata={"source": "a"}, user_id="alice"
    )
    b = await store.insert_fact("person", "city", "Berlin", 1100, user_id="bob")
    anonymous = await store.insert_fact("person", "city", "Oslo", 1200)
    await store.insert_fact("person", "city", "Rome", 2000)
    assert (
        db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (a,))["valid_to"]
        is None
    )
    assert (
        db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (b,))["valid_to"]
        is None
    )
    assert (
        db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (anonymous,))[
            "valid_to"
        ]
        == 1999
    )
    facts = await query.query_facts_at_time(
        subject="person", subject_object="Paris", at=2500, user_id="alice"
    )
    assert [f["id"] for f in facts] == [a]
    assert facts[0]["metadata"] == {"source": "a"}
    assert (await query.get_current_fact("person", "city"))["object"] == "Rome"
    edge = await store.insert_edge(a, b, "supports", 1300, 0.6)
    related = await query.get_related_facts(a, at=2500)
    assert related[0]["fact"]["id"] == b
    assert related[0]["relation"] == "supports"
    await store.invalidate_edge(edge, 2400)
    assert await query.get_related_facts(a, at=2500) == []


@pytest.mark.asyncio
async def test_single_and_batch_insert_rollback(connection):
    db.run_migrations()
    old = await store.insert_fact("person", "city", "Paris", 1000, user_id="alice")
    before = [dict(r) for r in db.fetchall("SELECT * FROM temporal_facts")]
    # NOT NULL rejects the new record after the old one has been closed.
    with pytest.raises(sqlite3.IntegrityError):
        await store.insert_fact("person", "city", None, 2000, user_id="alice")
    assert [dict(r) for r in db.fetchall("SELECT * FROM temporal_facts")] == before
    with pytest.raises(sqlite3.IntegrityError):
        await store.batch_insert_facts(
            [
                {
                    "subject": "person",
                    "predicate": "city",
                    "object": "Rome",
                    "valid_from": 2000,
                },
                {
                    "subject": "person",
                    "predicate": "city",
                    "object": None,
                    "valid_from": 3000,
                },
            ],
            user_id="alice",
        )
    assert [dict(r) for r in db.fetchall("SELECT * FROM temporal_facts")] == before
    ids = await store.batch_insert_facts(
        [
            {
                "subject": "person",
                "predicate": "city",
                "object": "Rome",
                "valid_from": 2000,
            },
            {
                "subject": "person",
                "predicate": "city",
                "object": "Lima",
                "valid_from": 3000,
            },
        ],
        user_id="alice",
    )
    assert (
        db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (old,))[
            "valid_to"
        ]
        == 1999
    )
    assert (
        db.fetchone("SELECT valid_to FROM temporal_facts WHERE id=?", (ids[0],))[
            "valid_to"
        ]
        == 2999
    )
    assert [
        f["id"] for f in await query.query_facts_at_time(at=3000, user_id="alice")
    ] == [ids[1]]


@pytest.mark.asyncio
async def test_mcp_factual_query_uses_runtime_contract(connection, monkeypatch):
    from openmemory.ai import mcp

    db.run_migrations()
    fact_id = await store.insert_fact("Alice", "city", "Paris", 1000, user_id="alice")
    responses = []

    class FakeServer:
        def __init__(self, name):
            pass

        def list_tools(self):
            return lambda handler: handler

        def call_tool(self):
            def register(handler):
                self.handler = handler
                return handler

            return register

        async def run(self, *args, **kwargs):
            responses.extend(
                await self.handler(
                    "openmemory_query",
                    {
                        "query": "city",
                        "type": "factual",
                        "user_id": "alice",
                        "fact_pattern": {"subject": "Alice", "object": "Paris"},
                        "at": "1970-01-01T00:00:02+00:00",
                    },
                )
            )

    @asynccontextmanager
    async def fake_stdio():
        yield None, None

    monkeypatch.setattr(mcp, "Server", FakeServer)
    for name in (
        "Tool",
        "TextContent",
        "ImageContent",
        "EmbeddedResource",
        "NotificationOptions",
    ):
        monkeypatch.setattr(mcp, name, SimpleNamespace, raising=False)
    monkeypatch.setattr(mcp, "stdio_server", fake_stdio, raising=False)
    await mcp.run_mcp_server()
    assert not any(r.text.startswith("Error:") for r in responses)
    data = json.loads(responses[-1].text)
    assert [f["id"] for f in data["factual"]] == [fact_id]
