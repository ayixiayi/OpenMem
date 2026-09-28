import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { migrate_postgres } from "../src/core/schema_migrations";

async function main() {
    const socket = process.env.OM_TEST_PG_SOCKET;
    if (!socket?.startsWith("/"))
        throw new Error(
            "Set OM_TEST_PG_SOCKET to a disposable local PostgreSQL socket directory",
        );
    const pool = new Pool({
        host: socket,
        port: 55439,
        user: "om_test",
        database: "postgres",
        password: "",
    });
    const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;
    const table = `"${schema}".memories`;
    const facts = `"${schema}".temporal_facts`;
    const root = randomUUID(),
        child = randomUUID(),
        fact = randomUUID();
    try {
        await pool.query(`create schema "${schema}"`);
        await pool.query(
            `create table ${table}(id uuid primary key,user_id text,project text,meta text)`,
        );
        await pool.query(
            `create table ${facts}(id uuid primary key,user_id text,subject text,predicate text,object text,valid_from bigint,unique(subject,predicate,object,valid_from))`,
        );
        await pool.query(
            `insert into ${facts} values($1,'alice','person','city','Paris',100)`,
            [fact],
        );
        await pool.query(
            `insert into ${table} values($1,'alice','project',$2),($3,'alice','project',$4)`,
            [
                root,
                JSON.stringify({ is_root: true }),
                child,
                JSON.stringify({
                    is_child: true,
                    parent_id: root,
                    section_index: 0,
                }),
            ],
        );
        // Failure after schema changes must restore the old constraint and data.
        await pool.query(
            `create table "${schema}"._om_migrations(version integer primary key check(version<0))`,
        );
        await assert.rejects(
            migrate_postgres(pool, schema, table),
            /check constraint/,
        );
        assert.equal(
            (
                await pool.query(`select to_regclass($1) as name`, [
                    `${schema}.document_sections`,
                ])
            ).rows[0].name,
            null,
        );
        await assert.rejects(
            pool.query(
                `insert into ${facts} values($1,'bob','person','city','Paris',100)`,
                [randomUUID()],
            ),
            /unique constraint/,
        );
        await pool.query(
            `alter table "${schema}"._om_migrations drop constraint _om_migrations_version_check`,
        );
        await Promise.all([
            migrate_postgres(pool, schema, table),
            migrate_postgres(pool, schema, table),
        ]);
        assert.deepEqual(
            (await pool.query(`select * from "${schema}".document_sections`))
                .rows,
            [{ document_id: root, section_index: 0, memory_id: child }],
        );
        await pool.query(
            `insert into ${facts} values($1,'bob','person','city','Paris',100)`,
            [randomUUID()],
        );
        await assert.rejects(
            pool.query(
                `insert into ${facts} values($1,'alice','person','city','Paris',100)`,
                [randomUUID()],
            ),
            /unique constraint/,
        );
        await pool.query(
            `insert into ${facts} values($1,null,'person','city','Paris',100)`,
            [randomUUID()],
        );
        await assert.rejects(
            pool.query(
                `insert into ${facts} values($1,null,'person','city','Paris',100)`,
                [randomUUID()],
            ),
            /unique constraint/,
        );
        assert.equal(
            (
                await pool.query(
                    `select count(*)::integer as n from "${schema}"._om_migrations`,
                )
            ).rows[0].n,
            1,
        );
        await pool.query(`delete from ${table} where id=$1`, [root]);
        assert.deepEqual(
            (await pool.query(`select * from "${schema}".document_sections`))
                .rows,
            [],
        );
        assert.equal(
            (await pool.query(`select id from ${table}`)).rows[0].id,
            child,
        );
        console.log(
            "[PG MIGRATION] rollback, concurrent startup, backfill, tenant uniqueness and cascade passed",
        );
    } finally {
        await pool.query(`drop schema if exists "${schema}" cascade`);
        await pool.end();
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
