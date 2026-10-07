import assert from "node:assert/strict";

async function main() {
    process.env.OM_TIER = "deep";
    process.env.OM_DB_PATH = ":memory:";
    process.env.OM_EMBEDDINGS = "synthetic";
    const { env } = await import("../src/core/cfg");
    const {
        embedForSector,
        embedForSectorWithProvenance,
        embedMultiSector,
        aggregateEmbeddings,
    } = await import("../src/memory/embed");
    const { q, vector_store, all_async, run_async } = await import(
        "../src/core/db"
    );
    const { validateVector } = await import("../src/core/embedding_contract");
    const fetch = globalThis.fetch;
    const updateLog = q.upd_log.run;
    try {
        const syn = await embedForSectorWithProvenance(
            "unique orchard",
            "semantic",
        );
        assert.equal(syn.provenance.provider, "synthetic");
        assert.deepEqual(
            await embedForSector("unique orchard", "semantic"),
            syn.vector,
        );

        env.emb_kind = "openai";
        env.openai_key = "offline-fixture";
        env.openai_model = "fixture-model-a";
        env.embedding_fallback = ["synthetic"];
        globalThis.fetch = async () =>
            new Response(
                JSON.stringify({ data: [{ embedding: [0.25, -0.75, 1.5] }] }),
                { status: 200 },
            );
        const first = await embedForSectorWithProvenance("alpha", "semantic");
        assert.equal(first.provenance.model, "fixture-model-a");
        assert.equal(first.provenance.dimensions, 3);
        env.openai_model = "fixture-model-b";
        const second = await embedForSectorWithProvenance("beta", "semantic");
        assert.throws(
            () => aggregateEmbeddings([first, second], "semantic"),
            /different embedding spaces/,
        );
        const average = aggregateEmbeddings(
            [first, { ...first, vector: [1.25, 0.25, -0.5] }],
            "semantic",
        );
        assert.deepEqual(average.vector, [0.75, -0.25, 0.5]);
        assert.equal(average.provenance.transform, "arithmetic-mean-v1");

        globalThis.fetch = async () =>
            new Response("unavailable", { status: 503 });
        const fallback = await embedForSectorWithProvenance(
            "alpha",
            "semantic",
        );
        assert.equal(fallback.provenance.provider, "synthetic");
        assert.equal(fallback.provenance.model, "openmemory-js-synthetic-v1");

        env.emb_kind = "local";
        env.local_model_path = "/not-loaded-fixture";
        const local = await embedForSectorWithProvenance("alpha", "semantic");
        assert.equal(
            local.provenance.model,
            "openmemory-js-sha256-placeholder-v1",
        );
        assert.equal(local.provenance.provider, "synthetic");

        env.emb_kind = "openai";
        env.embed_mode = "simple";
        globalThis.fetch = async () =>
            new Response(
                JSON.stringify({
                    data: [{ embedding: [1, 2, 3] }, { embedding: [3, 1, 2] }],
                }),
                { status: 200 },
            );
        const batch = await embedMultiSector("batch", "text", [
            "semantic",
            "reflective",
        ]);
        assert.deepEqual(
            batch.map((r) => r.provenance.model),
            ["fixture-model-b", "fixture-model-b"],
        );
        let failed = false;
        q.upd_log.run = async (...args) => {
            if (!failed) {
                failed = true;
                throw new Error("injected completion failure");
            }
            return updateLog(...args);
        };
        const retried = await embedMultiSector("retry", "text", [
            "semantic",
            "reflective",
        ]);
        assert.deepEqual(
            retried.map((r) => r.sector),
            ["semantic", "reflective"],
        );

        await vector_store.storeVector(
            "stored",
            "semantic",
            first.vector,
            3,
            "alice",
            first.provenance,
        );
        assert.deepEqual(
            (await vector_store.getVector("stored", "semantic"))?.provenance,
            first.provenance,
        );
        assert.deepEqual(
            (await vector_store.getVectorsById("stored"))[0].provenance,
            first.provenance,
        );
        assert.deepEqual(
            (await vector_store.getVectorsBySector("semantic"))[0].provenance,
            first.provenance,
        );
        // Legacy callers overwriting a vector must clear obsolete provenance.
        await vector_store.storeVector(
            "stored",
            "semantic",
            [2, 3, 4],
            3,
            "alice",
        );
        assert.equal(
            (await vector_store.getVector("stored", "semantic"))?.provenance,
            null,
        );
        await assert.rejects(
            vector_store.storeVector(
                "stored",
                "semantic",
                [2, 3],
                2,
                "alice",
                first.provenance,
            ),
            /provenance/,
        );
        assert.deepEqual(
            (await vector_store.getVector("stored", "semantic"))?.vector,
            [2, 3, 4],
        );
        for (const vector of [[], [NaN], [Infinity], [1e100], new Array(2)])
            assert.throws(
                () => validateVector(vector, vector.length),
                /finite vector/,
            );
        assert.throws(() => validateVector([1, 2], 3), /dimension/);
        assert.equal(
            (
                await all_async(
                    "select provenance from vectors where id='stored'",
                )
            )[0].provenance,
            null,
        );
        await run_async(
            "insert into memories(id,user_id,content,primary_sector) values('stored','alice','original content','semantic')",
        );
        const { on_query_hit } = await import("../src/memory/decay");
        await on_query_hit("stored", "semantic", async () => first);
        assert.equal(
            (
                await all_async("select user_id from vectors where id='stored'")
            )[0].user_id,
            "alice",
        );
        assert.deepEqual(
            (await vector_store.getVector("stored", "semantic"))?.provenance,
            first.provenance,
        );
        console.log(
            "[EMBEDDING] actual fallback, model identity, local placeholder, chunk spaces, retries and persistence passed",
        );
    } finally {
        globalThis.fetch = fetch;
        q.upd_log.run = updateLog;
    }
}
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
