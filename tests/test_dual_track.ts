import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "openmem-dual-track-"));
process.env.OM_DB_PATH = ":memory:";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";
process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_TIER = "hybrid";

const day = (d: string) => new Date(`${d}T00:00:00Z`);

async function main() {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { create_mcp_srv } = await import("../src/ai/mcp");
    const { all_async, q } = await import("../src/core/db");
    const { insert_fact, retract_fact } = await import("../src/temporal_graph/store");
    const { query_facts_at_time } = await import("../src/temporal_graph/query");
    const { add_hsg_memory, delete_memory } = await import("../src/memory/hsg");

    const server = create_mcp_srv();
    const client = new Client({ name: "dual-track", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => {
        const r: any = await client.callTool({ name, arguments: args });
        return { r, text: r.content[0].text as string, json: () => JSON.parse(r.content[1].text) };
    };
    const current = (subject: string, predicate: string, project?: string, at = new Date()) =>
        query_facts_at_time(subject, predicate, undefined, at, 0, "alice", { project }).then((f) =>
            f.map((x) => x.object).sort(),
        );

    // --- 1. CJK text is tokenised, so distinct Chinese memories are not merged.
    const zh1 = await add_hsg_memory("用户偏好中文回答", "[]", {}, "alice", "zh");
    const zh2 = await add_hsg_memory("项目禁止自动部署", "[]", {}, "alice", "zh");
    assert.notEqual(zh1.id, zh2.id);
    assert.ok(!zh2.deduplicated);
    const zh_dup = await add_hsg_memory("用户偏好中文回答", "[]", {}, "alice", "zh");
    assert.equal(zh_dup.id, zh1.id, "an exact repeat is still deduplicated");
    const empty1 = await add_hsg_memory("!!!", "[]", {}, "alice", "zh");
    const empty2 = await add_hsg_memory("???", "[]", {}, "alice", "zh");
    assert.notEqual(empty1.id, empty2.id, "token-less texts only merge when identical");

    // --- 2. Facts are scoped by project; global facts are visible everywhere.
    await insert_fact("Backend", "Database", "SQLite", day("2026-01-01"), 1, undefined, "alice", { project: "api" });
    await insert_fact("backend", "database", "MongoDB", day("2026-02-01"), 1, undefined, "alice", { project: "web" });
    assert.deepEqual(await current("backend", "database", "api"), ["SQLite"], "web's write must not close api's fact");
    assert.deepEqual(await current("backend", "database", "web"), ["MongoDB"]);
    await insert_fact("user", "answer_language", "Chinese", day("2026-01-01"), 1, undefined, "alice", { project: null });
    assert.deepEqual(await current("user", "answer_language", "api"), ["Chinese"]);
    assert.deepEqual(await current("user", "answer_language", "web"), ["Chinese"]);

    // --- 3. The review's scenario through MCP: an observation that changes a fact.
    const stored = await call("openmemory_store", {
        type: "both",
        project: "api",
        user_id: "alice",
        observation_type: "decision",
        content: "Moved from SQLite to PostgreSQL: several workers write concurrently and SQLite locked under load.",
        facts: [{ subject: "backend", predicate: "database", object: "PostgreSQL", valid_from: "2026-06-01T00:00:00Z" }],
    });
    const decision_id = stored.json().hsg.id;
    assert.equal(stored.json().temporal[0].source_memory_id, decision_id);
    assert.deepEqual(await current("backend", "database", "api"), ["PostgreSQL"]);
    assert.deepEqual(await current("backend", "database", "api", day("2026-03-01")), ["SQLite"], "history is kept");

    // An older observation whose fact the decision replaced is flagged as historical.
    const old = await call("openmemory_store", {
        type: "both",
        project: "api",
        user_id: "alice",
        content: "Chose SQLite for the API backend because it needs no server.",
        facts: [{ subject: "backend", predicate: "database", object: "SQLite", valid_from: "2026-01-01T00:00:00Z" }],
    });
    // Same value, same start: the existing fact is reused rather than duplicated.
    assert.equal(
        (await all_async("select count(*) as n from temporal_facts where project='api' and object='SQLite'"))[0].n,
        1,
    );
    assert.equal(old.json().temporal[0].source_memory_id, old.json().hsg.id, "a reused fact gains the source link");

    const unified = await call("openmemory_query", {
        type: "unified",
        query: "SQLite database backend",
        project: "api",
        user_id: "alice",
    });
    const u = unified.json();
    assert.deepEqual(u.factual.map((f: any) => f.object), ["PostgreSQL"], "only the current value is a fact");
    const old_hit = u.contextual.find((m: any) => m.id === old.json().hsg.id);
    assert.ok(old_hit, "the old observation is still recalled for its reasoning");
    assert.equal(old_hit.linked_facts[0].status, "ended");
    assert.equal(old_hit.linked_facts[0].replaced_by.object, "PostgreSQL");
    assert.match(unified.text, /HISTORICAL: backend · database: SQLite — now PostgreSQL \(since 2026-06-01\)/);
    const new_hit = u.contextual.find((m: any) => m.id === decision_id);
    assert.equal(new_hit.linked_facts[0].status, "current");

    // --- 4. Factual queries match natural language, respect scope and limits.
    const nl = await call("openmemory_query", { type: "factual", query: "which database?", project: "api", user_id: "alice" });
    assert.deepEqual(nl.json().factual.map((f: any) => f.object), ["PostgreSQL"]);
    const zh_q = await call("openmemory_query", { type: "factual", query: "回答语言", project: "api", user_id: "alice" });
    assert.equal(zh_q.json().factual.length, 0, "no false matches across scripts");
    for (let i = 0; i < 5; i++)
        await insert_fact("ci", "runner", `r${i}`, day("2026-01-01"), 1, undefined, "alice", { project: "api", kind: "set" });
    const limited = await call("openmemory_query", { type: "factual", query: "runner", project: "api", user_id: "alice", fact_limit: 3 });
    assert.equal(limited.json().factual.length, 3);
    const other = await call("openmemory_query", { type: "factual", query: "database", project: "web", user_id: "alice" });
    assert.deepEqual(other.json().factual.map((f: any) => f.object), ["MongoDB"]);

    // --- 5. Kinds: sets coexist, events never replace, backfill and corrections.
    await insert_fact("app", "supported_platform", "Linux", day("2026-01-01"), 1, undefined, "alice", { project: "api", kind: "set" });
    await insert_fact("app", "supported_platform", "Windows", day("2026-02-01"), 1, undefined, "alice", { project: "api", kind: "set" });
    assert.deepEqual(await current("app", "supported_platform", "api"), ["Linux", "Windows"]);
    assert.equal(await retract_fact({ subject: "app", predicate: "supported_platform", object: "Windows" }, new Date(), "alice", "api"), 1);
    assert.deepEqual(await current("app", "supported_platform", "api"), ["Linux"]);

    await insert_fact("api", "deployed", "v1", day("2026-03-01"), 1, undefined, "alice", { project: "api", kind: "event" });
    await insert_fact("api", "deployed", "v2", day("2026-04-01"), 1, undefined, "alice", { project: "api", kind: "event" });
    const deploys = await all_async("select object from temporal_facts where predicate='deployed' and valid_to=valid_from order by valid_from");
    assert.deepEqual(deploys.map((r: any) => r.object), ["v1", "v2"], "events are instants and both survive");
    assert.deepEqual(await current("api", "deployed", "api"), [], "events are not current state");

    // Kinds don't interact: an event on the same subject/predicate leaves the state alone.
    await insert_fact("api", "version", "1.0", day("2026-01-01"), 1, undefined, "alice", { project: "api" });
    await insert_fact("api", "version", "1.1-rc", day("2026-08-01"), 1, undefined, "alice", { project: "api", kind: "event" });
    assert.deepEqual(await current("api", "version", "api"), ["1.0"]);
    await insert_fact("api", "version", "1.2", day("2026-05-01"), 1, undefined, "alice", { project: "api" });
    assert.deepEqual(await current("api", "version", "api"), ["1.2"], "a later event must not end the new state");

    // Backfill: learning later that Redis was used between SQLite and PostgreSQL.
    await insert_fact("cache", "engine", "Valkey", day("2026-06-01"), 1, undefined, "alice", { project: "api" });
    await insert_fact("cache", "engine", "Redis", day("2026-03-01"), 1, undefined, "alice", { project: "api" });
    assert.deepEqual(await current("cache", "engine", "api"), ["Valkey"], "a backfilled value does not become current");
    assert.deepEqual(await current("cache", "engine", "api", day("2026-04-01")), ["Redis"]);
    assert.deepEqual(await current("cache", "engine", "api", day("2026-07-01")), ["Valkey"]);

    // Correction: a different value for the same start time replaces the mistake.
    await insert_fact("cache", "ttl", "60s", day("2026-05-01"), 1, undefined, "alice", { project: "api" });
    await insert_fact("cache", "ttl", "600s", day("2026-05-01"), 1, undefined, "alice", { project: "api" });
    assert.deepEqual(await current("cache", "ttl", "api"), ["600s"]);
    assert.equal((await all_async("select count(*) as n from temporal_facts where predicate='ttl'"))[0].n, 2, "the mistake is kept for audit");

    // --- 6. 'both' is atomic: a failing fact rolls back the observation too.
    const before = (await q.all_mem.all(1000, 0, { project: "api" })).length;
    const failed: any = await client.callTool({
        name: "openmemory_store",
        arguments: {
            type: "both",
            project: "api",
            user_id: "alice",
            content: "Atomicity probe: this observation must not survive a bad fact.",
            facts: [{ subject: "x", predicate: "y", object: "z", valid_from: "not a date" }],
        },
    });
    assert.ok(failed.isError);
    assert.equal((await q.all_mem.all(1000, 0, { project: "api" })).length, before);
    assert.equal((await all_async("select count(*) as n from temporal_facts where subject='x'"))[0].n, 0);

    // --- 7. Wakeup includes current facts; deleting a memory keeps its facts.
    const wake = await call("openmemory_wakeup", { project: "api", user_id: "alice" });
    assert.match(wake.text, /## Current Facts/);
    assert.match(wake.text, /backend · database: PostgreSQL/);
    assert.match(wake.text, /user · answer_language: Chinese \(global\)/);
    assert.doesNotMatch(wake.text, /backend · database: SQLite/);
    assert.doesNotMatch(wake.text, /MongoDB/, "other projects' facts stay out");
    await delete_memory(decision_id);
    const kept = await all_async("select source_memory_id from temporal_facts where object='PostgreSQL'");
    assert.deepEqual(kept, [{ source_memory_id: null }]);

    console.log("[DUAL TRACK] CJK dedup, project-scoped facts, kinds, backfill, linked history, atomic writes and wakeup passed");
    await client.close();
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
