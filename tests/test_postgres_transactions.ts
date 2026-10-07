import assert from "node:assert/strict";
import { Pool } from "pg";
import { postgres_transactions } from "../src/core/postgres_transaction";

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function main() {
    const clients: { sql: string[]; releases: boolean[] }[] = [];
    const outside: string[] = [];
    let fail = "";
    const pool = {
        query: async (sql: string) => {
            outside.push(sql);
            return { rows: [] };
        },
        connect: async () => {
            const record = { sql: [] as string[], releases: [] as boolean[] };
            clients.push(record);
            // Delay acquisition so simultaneous runs exercise the old cli race.
            await Promise.resolve();
            return {
                query: async (sql: string) => {
                    record.sql.push(sql);
                    if (sql === fail) throw new Error(`failed ${sql}`);
                    return { rows: [] };
                },
                release: (discard: boolean) => record.releases.push(discard),
            };
        },
    } as unknown as Pool;
    const tx = postgres_transactions(() => pool);
    const aReady = gate(),
        bReady = gate(),
        proceed = gate();
    const error = new Error("abort A");
    const a = tx.run(async () => {
        await tx.query("A1");
        aReady.resolve();
        await proceed.promise;
        await tx.query("A2");
        throw error;
    });
    const aCheck = assert.rejects(a, (received) => received === error);
    const b = tx.run(async () => {
        await tx.query("B1");
        bReady.resolve();
        await proceed.promise;
        await tx.query("B2");
        return 42;
    });
    await Promise.all([aReady.promise, bReady.promise]);
    await tx.query("OUTSIDE");
    proceed.resolve();
    await aCheck;
    assert.equal(await b, 42);
    assert.deepEqual(outside, ["OUTSIDE"]);
    assert.deepEqual(clients[0].sql, ["BEGIN", "A1", "A2", "ROLLBACK"]);
    assert.deepEqual(clients[1].sql, ["BEGIN", "B1", "B2", "COMMIT"]);
    assert.deepEqual(clients[0].releases, [false]);
    assert.deepEqual(clients[1].releases, [false]);

    for (const statement of ["BEGIN", "COMMIT", "ROLLBACK"]) {
        fail = statement;
        await assert.rejects(
            tx.run(async () => {
                await tx.query("WORK");
                if (statement === "ROLLBACK") throw error;
            }),
            statement === "ROLLBACK"
                ? (received) => received === error
                : new RegExp(statement),
        );
        const last = clients.at(-1)!;
        assert.deepEqual(last.releases, [true]);
        assert.deepEqual(
            last.sql,
            statement === "BEGIN"
                ? ["BEGIN"]
                : [
                      "BEGIN",
                      "WORK",
                      ...(statement === "COMMIT" ? ["COMMIT"] : []),
                      "ROLLBACK",
                  ],
        );
    }
    fail = "";
    const beforeNested = clients.length;
    await tx.run(async () => {
        await assert.rejects(
            tx.run(async () => {}),
            /Nested transactions/,
        );
        await tx.query("AFTER_NESTED_REJECTION");
    });
    assert.equal(clients.length, beforeNested + 1);
    assert.deepEqual(clients.at(-1)!.releases, [false]);

    const late = gate();
    let detached!: Promise<unknown>;
    await tx.run(async () => {
        detached = late.promise.then(() => tx.query("AFTER_RELEASE"));
    });
    const detachedCheck = assert.rejects(detached, /already finished/);
    late.resolve();
    await detachedCheck;
    assert.ok(clients.every((client) => !client.sql.includes("AFTER_RELEASE")));
    assert.deepEqual(outside, ["OUTSIDE"]);

    // Exercise the actual PG DAO wiring without opening any network connection.
    process.env.OM_METADATA_BACKEND = "postgres";
    process.env.OM_VECTOR_BACKEND = "postgres";
    process.env.OM_PG_SCHEMA = "fixture";
    process.env.OM_PG_TABLE = "memory_fixture";
    process.env.OM_VECTOR_TABLE = "vector_fixture";
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const originalQuery = Pool.prototype.query;
    const originalConnect = Pool.prototype.connect;
    Pool.prototype.query = (async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows: [] };
    }) as any;
    Pool.prototype.connect = (async () => {
        return { query: Pool.prototype.query, release() {} };
    }) as any;
    try {
        const { q, all_async } = await import("../src/core/db");
        await all_async("select 1"); // Wait for mocked initialization to finish.
        calls.length = 0;
        const vector = Buffer.from([1, 2, 3]);
        await q.upd_compressed_vec.run(vector, "memory-id");
        assert.deepEqual(calls.pop(), {
            sql: 'update "fixture"."memory_fixture" set compressed_vec=$1 where id=$2',
            params: [vector, "memory-id"],
        });
        await q.upd_log.run("failed", "provider error", "log-id");
        assert.deepEqual(calls.pop(), {
            sql: 'update "fixture"."openmemory_embed_logs" set status=$1,err=$2 where id=$3',
            params: ["failed", "provider error", "log-id"],
        });
        await q.all_mem.all(2, 1, {
            user_id: "alice",
            project: "alpha",
            sector: "semantic",
        });
        assert.deepEqual(calls.pop(), {
            sql: 'select * from "fixture"."memory_fixture" where user_id=$1 and project=$2 and primary_sector=$3 order by created_at desc,id desc limit $4 offset $5',
            params: ["alice", "alpha", "semantic", 2, 1],
        });
        await q.get_summaries_by_project.all("alpha", 3, "alice");
        const summaries = calls.pop()!;
        assert.deepEqual(summaries.params, ["alpha", 3, "alice"]);
        assert.match(summaries.sql, /"fixture"\."openmemory_sessions"/);
        assert.match(summaries.sql, /session\.user_id=\$3/);
        for (const dao of [q.get_neighbors, q.get_waypoints_by_src]) {
            await dao.all("memory-id");
            const edge = calls.pop()!;
            assert.deepEqual(edge.params, ["memory-id"]);
            assert.match(
                edge.sql,
                /source\.user_id is not distinct from target\.user_id/,
            );
            assert.match(
                edge.sql,
                /source\.project is not distinct from target\.project/,
            );
        }
    } finally {
        Pool.prototype.query = originalQuery;
        Pool.prototype.connect = originalConnect;
    }
    console.log(
        "[PG TRANSACTIONS] connection isolation, failure cleanup and native DAO contracts passed",
    );
}

const timeout = setTimeout(() => {
    console.error("Transaction regression timed out");
    process.exit(1);
}, 10000);
main().then(
    () => {
        clearTimeout(timeout);
        process.exit(0);
    },
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
