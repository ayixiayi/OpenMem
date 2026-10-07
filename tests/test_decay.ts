import assert from "node:assert/strict";

async function main() {
    const { q, run_async, all_async, vector_store } = await import(
        "../src/core/db"
    );
    const { env } = await import("../src/core/cfg");
    const { apply_decay } = await import("../src/memory/decay");
    env.decay_ratio = 1;
    const old = Date.now() - 90 * 86400000;
    for (const [id, salience, timestamp] of [
        ["cold", 0.4, old],
        ["zero", 0, Date.now()],
    ]) {
        await run_async(
            "INSERT INTO memories(id,user_id,content,primary_sector,salience,last_seen_at,updated_at) VALUES (?,'alice',?,'semantic',?,?,?)",
            [id, id, salience, timestamp, timestamp],
        );
    }
    const vector = Array.from({ length: 128 }, (_, i) => (i % 2 ? -0.5 : 0.25));
    await vector_store.storeVector("cold", "semantic", vector, 128, "alice", {
        schema_version: 1,
        provider: "synthetic",
        model: "fixture",
        sector: "semantic",
        dimensions: 128,
        transform: "identity-v1",
    });
    const before = await all_async("SELECT * FROM vectors WHERE id='cold'", []);
    await apply_decay();
    assert.deepEqual(
        await all_async("SELECT * FROM vectors WHERE id='cold'", []),
        before,
    );
    const cold = await q.get_mem.get("cold");
    assert.equal(cold.content, "cold");
    assert.ok(cold.salience < 0.4);
    assert.ok(
        cold.compressed_vec.length > 0 && cold.compressed_vec.length < 128 * 4,
    );
    assert.equal((await q.get_mem.get("zero")).salience, 0);
    assert.equal(
        (await vector_store.searchSimilar("semantic", vector, 1, "alice"))[0]
            .id,
        "cold",
    );
    await vector_store.storeVector("cold", "emotional", [1, 0, 0], 3, "alice");
    const { calc_multi_vec_fusion_score } = await import("../src/memory/hsg");
    const fusion = await calc_multi_vec_fusion_score(
        "cold",
        { semantic: vector, emotional: vector },
        {
            semantic_dimension_weight: 1,
            emotional_dimension_weight: 1,
            procedural_dimension_weight: 1,
            temporal_dimension_weight: 1,
            reflective_dimension_weight: 1,
        },
    );
    assert.ok(
        Math.abs(fusion - 1) < 1e-6,
        "wrong-dimensional sectors must not dilute fusion",
    );
    console.log(
        "[DECAY] Cold maintenance preserves source vectors, ownership, provenance and searchability",
    );
}
main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
