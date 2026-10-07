import assert from "node:assert/strict";

async function main() {
    const { q, vector_store } = await import("../src/core/db");
    const { add_hsg_memory, hsg_query, fts_terms } = await import(
        "../src/memory/hsg"
    );

    assert.deepEqual(fts_terms(`What's the "ECONNRESET" fix in db_pool.ts? (AND OR *)`), [
        "econnreset",
        "fix",
        "db",
        "pool",
        "ts",
    ]);
    assert.deepEqual(fts_terms("the of ? !"), []);

    const target = await add_hsg_memory(
        "Retry ECONNRESET from the pg pool by recycling idle clients after 30s",
        "[]",
        {},
        "alice",
        "alpha",
    );
    await add_hsg_memory(
        "Use pnpm workspaces for the monorepo build",
        "[]",
        {},
        "alice",
        "alpha",
    );
    const foreign_project = await add_hsg_memory(
        "Beta also hit ECONNRESET on its redis client",
        "[]",
        {},
        "alice",
        "beta",
    );
    const foreign_user = await add_hsg_memory(
        "Bob saw ECONNRESET in the alpha load balancer",
        "[]",
        {},
        "bob",
        "alpha",
    );

    // Lexical hits are scoped before ranking, never leak across project/user.
    const scoped = await q.fts_search.all(["econnreset"], 10, {
        user_id: "alice",
        project: "alpha",
    });
    assert.deepEqual(
        scoped.map((r) => r.id),
        [target.id],
    );
    assert.deepEqual(await q.fts_search.all([], 10), []);

    // A keyword-only hit is recalled even when vector search returns nothing.
    const search = vector_store.searchSimilar.bind(vector_store);
    vector_store.searchSimilar = async () => [];
    try {
        const hits = await hsg_query("what's the ECONNRESET fix?", 5, {
            user_id: "alice",
            project: "alpha",
        });
        assert.equal(hits[0]?.id, target.id);
        const ids = hits.map((h) => h.id);
        assert.ok(!ids.includes(foreign_project.id));
        assert.ok(!ids.includes(foreign_user.id));
    } finally {
        vector_store.searchSimilar = search;
    }

    // Scores are bounded so min_score thresholds are meaningful.
    const ranked = await hsg_query("ECONNRESET pg pool", 5, {
        user_id: "alice",
        project: "alpha",
    });
    assert.equal(ranked[0].id, target.id);
    for (const r of ranked) assert.ok(r.score >= 0 && r.score < 1, `${r.score}`);

    // The FTS index follows content edits but ignores salience bookkeeping.
    await q.upd_mem.run("Recycle idle clients on socket hangup", "[]", "{}", Date.now(), target.id);
    assert.deepEqual(await q.fts_search.all(["econnreset"], 10, { user_id: "alice", project: "alpha" }), []);
    assert.deepEqual(
        (await q.fts_search.all(["hangup"], 10, { project: "alpha" })).map((r) => r.id),
        [target.id],
    );

    console.log("[HYBRID] Scoped lexical recall, safe query parsing, bounded scores and index sync passed");
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
