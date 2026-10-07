import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { postgres_transactions } from "../src/core/postgres_transaction";

// Deliberately require a local disposable server, never application credentials.
const socket = process.env.OM_TEST_PG_SOCKET;
if (!socket?.startsWith("/tmp/")) {
    throw new Error(
        "Set OM_TEST_PG_SOCKET to a disposable PostgreSQL socket under /tmp/",
    );
}
const pool = new Pool({
    host: socket,
    port: 55439,
    user: "om_test",
    database: "postgres",
    password: "unused-local-test",
    ssl: false,
    max: 3,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
});
const tx = postgres_transactions(() => pool);
const table = `"tx_test_${randomUUID().replaceAll("-", "")}"`;
function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function main() {
    try {
        await pool.query(`create table ${table}(id text primary key)`);
        const aReady = gate(),
            bReady = gate(),
            proceed = gate();
        let aPid = 0,
            bPid = 0;
        const abort = new Error("rollback only A");
        const a = tx.run(async () => {
            aPid = (await tx.query("select pg_backend_pid() as pid")).rows[0]
                .pid;
            await tx.query(`insert into ${table} values($1)`, ["A"]);
            aReady.resolve();
            await proceed.promise;
            throw abort;
        });
        const aCheck = assert.rejects(a, (received) => received === abort);
        const b = tx.run(async () => {
            bPid = (await tx.query("select pg_backend_pid() as pid")).rows[0]
                .pid;
            await tx.query(`insert into ${table} values($1)`, ["B"]);
            bReady.resolve();
            await proceed.promise;
            return "B committed";
        });
        await Promise.all([aReady.promise, bReady.promise]);
        try {
            const outsidePid = (
                await tx.query("select pg_backend_pid() as pid")
            ).rows[0].pid;
            assert.equal(new Set([aPid, bPid, outsidePid]).size, 3);
            await tx.query(`insert into ${table} values($1)`, ["outside"]);
            assert.deepEqual((await tx.query(`select id from ${table}`)).rows, [
                { id: "outside" },
            ]);
        } finally {
            proceed.resolve();
            await aCheck;
            assert.equal(await b, "B committed");
        }
        assert.deepEqual(
            (await tx.query(`select id from ${table} order by id`)).rows,
            [{ id: "B" }, { id: "outside" }],
        );
        // A real SQL error aborts the transaction; its earlier insert must disappear.
        await assert.rejects(
            tx.run(async () => {
                await tx.query(`insert into ${table} values('rolled-back')`);
                await tx.query(`insert into ${table} values('B')`);
            }),
            (error: any) => error.code === "23505",
        );
        assert.deepEqual(
            (await tx.query(`select id from ${table} order by id`)).rows,
            [{ id: "B" }, { id: "outside" }],
        );
        await tx.run(async () => {
            await tx.query(`insert into ${table} values('recovered')`);
        });
        assert.equal(
            (await tx.query(`select count(*)::int as n from ${table}`)).rows[0]
                .n,
            3,
        );
        console.log(
            "[PG INTEGRATION] distinct connections, commit/rollback isolation, SQL failure and recovery passed",
        );
    } finally {
        try {
            await pool.query(`drop table if exists ${table}`);
        } finally {
            await pool.end();
        }
    }
}

const timeout = setTimeout(() => {
    console.error("PostgreSQL integration timed out");
    process.exit(1);
}, 20000);
main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => clearTimeout(timeout));
