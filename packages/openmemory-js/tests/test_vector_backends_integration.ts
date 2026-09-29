import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Redis from "ioredis";

async function main() {
    const socket = process.env.OM_TEST_PG_SOCKET;
    if (!socket?.startsWith("/") || process.env.OM_TEST_REDIS_PORT !== "56379")
        throw new Error(
            "Use disposable PostgreSQL Unix socket and Redis port 56379",
        );
    const pool = new Pool({
        host: socket,
        port: 55439,
        user: "om_test",
        database: "postgres",
        password: "",
    });
    const schema = `vector_test_${randomUUID().replaceAll("-", "")}`;
    const redis = new Redis({ host: "127.0.0.1", port: 56379 });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    try {
        await pool.query(`create schema "${schema}"`);
        Object.assign(process.env, {
            OM_METADATA_BACKEND: "postgres",
            OM_VECTOR_BACKEND: "postgres",
            OM_PG_HOST: socket,
            OM_PG_PORT: "55439",
            OM_PG_USER: "om_test",
            OM_PG_DB: "postgres",
            OM_PG_SCHEMA: schema,
            OM_EMBEDDINGS: "synthetic",
        });
        const db = await import("../src/core/db");
        await db.all_async("select 1");
        const { ValkeyVectorStore } = await import("../src/core/vector/valkey");
        const valkey = Object.create(ValkeyVectorStore.prototype) as any;
        valkey.client = redis;
        // SCAN explicitly permits duplicate keys, including across pages.
        const scan = redis.scan.bind(redis) as (
            ...args: any[]
        ) => Promise<[string, string[]]>;
        (redis as any).scan = async (...args: any[]) => {
            const [cursor, keys] = await scan(...args);
            return [cursor, [...keys, ...keys]];
        };
        for (const store of [db.vector_store, valkey]) {
            const provenance = {
                schema_version: 1 as const,
                provider: "fixture",
                model: "model-a",
                sector: "semantic",
                dimensions: 3,
                transform: "identity-v1",
            };
            await store.storeVector(
                ids[0],
                "semantic",
                [0.25, -0.75, 1.5],
                3,
                "alice",
                provenance,
            );
            await store.storeVector(
                ids[0],
                "reflective",
                [1, 0, 0],
                3,
                "alice",
            );
            await store.storeVector(ids[1], "semantic", [1, 0], 2, "alice");
            await store.storeVector(
                ids[2],
                "semantic",
                [0.25, -0.75, 1.5],
                3,
                "bob",
            );
            const row = await store.getVector(ids[0], "semantic");
            assert.deepEqual(row?.vector, [0.25, -0.75, 1.5]);
            assert.deepEqual(row?.provenance, provenance);
            assert.equal((await store.getVectorsById(ids[0])).length, 2);
            assert.equal(
                (await store.getVectorsBySector("semantic")).filter(
                    (r: any) => r.id === ids[0],
                ).length,
                1,
            );
            assert.deepEqual(
                (await store.getVectorsBySector("semantic")).find(
                    (r: any) => r.id === ids[0],
                )?.provenance,
                provenance,
            );
            const hits = await store.searchSimilar(
                "semantic",
                [-0.25, 0.75, -1.5],
                3,
                "alice",
            );
            assert.deepEqual(
                hits.map((r: any) => r.id),
                [ids[0]],
            );
            assert.ok(Math.abs(hits[0].score + 1) < 1e-6);
            await store.storeVector(ids[0], "semantic", [3, 2, 1], 3, "alice");
            assert.equal(
                (await store.getVector(ids[0], "semantic"))?.provenance,
                null,
            );
            for (const id of ids) await store.deleteVectors(id);
            assert.deepEqual(await store.getVectorsById(ids[0]), []);
        }
        console.log(
            "[VECTOR INTEGRATION] PostgreSQL app bootstrap, multi-sector storage, binary Redis roundtrip, provenance and dimension-scoped ranking passed",
        );
    } finally {
        for (const id of ids)
            await redis.del(`vec:semantic:${id}`, `vec:reflective:${id}`);
        await redis.quit();
        await pool.query(`drop schema if exists "${schema}" cascade`);
        await pool.end();
    }
}
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
