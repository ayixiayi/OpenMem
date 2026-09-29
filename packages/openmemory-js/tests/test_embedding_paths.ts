import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

async function main() {
    const tier = process.argv[2];
    if (!tier) {
        for (const mode of ["fast", "hybrid", "smart", "deep"]) {
            const child = spawnSync(
                process.execPath,
                [require.resolve("tsx/cli"), __filename, mode],
                { env: process.env, stdio: "inherit", timeout: 30000 },
            );
            assert.equal(
                child.status,
                0,
                `${mode}: ${child.error || child.signal || "failed"}`,
            );
        }
        return;
    }
    process.env.OM_TIER = tier;
    process.env.OM_VEC_DIM = "8";
    const { env } = await import("../src/core/cfg");
    const { embedMultiSector, embedQueryWithProvenance } = await import(
        "../src/memory/embed"
    );
    env.emb_kind = "openai";
    env.openai_key = "offline-fixture";
    env.openai_model = "";
    env.embedding_fallback = ["synthetic"];
    env.embed_delay_ms = 0;
    let calls = 0;
    globalThis.fetch = async (_url, request) => {
        calls++;
        const body = JSON.parse(request!.body as string);
        const data = Array.isArray(body.input)
            ? [
                  { index: 1, embedding: [3, 1, 2] },
                  { index: 0, embedding: [1, 2, 3] },
              ]
            : [
                  {
                      embedding: body.model.includes("large")
                          ? [3, 1, 2]
                          : [1, 2, 3],
                  },
              ];
        return new Response(JSON.stringify({ data }), { status: 200 });
    };
    const sectors = ["semantic", "reflective"];
    for (const mode of ["simple", "advanced"]) {
        env.embed_mode = mode;
        const document = await embedMultiSector(
            `${tier}-${mode}`,
            "same text",
            sectors,
        );
        const before = calls;
        const query = await embedQueryWithProvenance("same text", sectors);
        assert.deepEqual(
            document.map((r) => r.sector),
            sectors,
        );
        for (const entry of document) {
            assert.deepEqual(query[entry.sector].vector, entry.vector);
            assert.deepEqual(query[entry.sector].provenance, entry.provenance);
        }
        if (mode === "simple") {
            assert.equal(calls - before, 1);
            assert.deepEqual(
                document.map((r) => r.vector),
                [
                    [1, 2, 3],
                    [3, 1, 2],
                ],
            );
            assert.deepEqual(
                document.map((r) => r.provenance.model),
                ["text-embedding-3-small", "text-embedding-3-small"],
            );
        } else {
            assert.equal(
                document[0].dim,
                tier === "smart" ? 11 : tier === "deep" ? 3 : 8,
            );
            if (tier === "fast" || tier === "hybrid")
                assert.equal(calls, before);
        }
    }
    console.log(
        `[EMBED PATHS] ${tier}: indexed batch mapping and document/query transforms passed`,
    );
}
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
