import assert from "node:assert/strict";
import sqlite3 from "sqlite3";
import { migrate_sqlite } from "../src/core/schema_migrations";

async function fixture() {
    const db = new sqlite3.Database(":memory:");
    const run = (sql: string, params: any[] = []) =>
        new Promise<void>((resolve, reject) =>
            db.run(sql, params, (error) => (error ? reject(error) : resolve())),
        );
    const all = (sql: string) =>
        new Promise<any[]>((resolve, reject) =>
            db.all(sql, (error, rows) =>
                error ? reject(error) : resolve(rows),
            ),
        );
    await run(
        "create table memories(id text primary key,user_id text,project text,meta text)",
    );
    await run("create table vectors(id text,sector text,v blob,dim integer)");
    await run("insert into vectors values('legacy','semantic',x'0000803f',1)");
    await run(
        "create table temporal_facts(id text primary key,user_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))",
    );
    await run(
        "create table temporal_edges(id text primary key,source_id text references temporal_facts(id),target_id text references temporal_facts(id))",
    );
    await run("create index custom_fact_index on temporal_facts(object)");
    await run("create table audit(message text)");
    await run(
        "create trigger custom_fact_trigger after update on temporal_facts begin insert into audit values(new.id); end",
    );
    await run(
        "insert into temporal_facts values('original','alice','person','city','Paris',100,199,0.7,123,'{\"source\":\"old\"}')",
    );
    await run(
        "insert into temporal_edges values('edge','original','original')",
    );
    for (const [id, user, meta] of [
        ["root", "alice", { is_root: true }],
        [
            "child",
            "alice",
            { is_child: true, parent_id: "root", section_index: 0 },
        ],
        [
            "ambiguous-a",
            "alice",
            { is_child: true, parent_id: "root", section_index: 1 },
        ],
        [
            "ambiguous-b",
            "alice",
            { is_child: true, parent_id: "root", section_index: 1 },
        ],
        [
            "foreign",
            "bob",
            { is_child: true, parent_id: "root", section_index: 2 },
        ],
    ])
        await run("insert into memories values(?,?,'project',?)", [
            id,
            user,
            JSON.stringify(meta),
        ]);
    await run(
        "insert into memories values('invalid','alice','project','not-json')",
    );
    return {
        db,
        run,
        all,
        close: () =>
            new Promise<void>((resolve, reject) =>
                db.close((error) => (error ? reject(error) : resolve())),
            ),
    };
}

async function main() {
    const f = await fixture();
    try {
        const facts = await f.all("select * from temporal_facts");
        const memories = await f.all("select * from memories order by id");
        await migrate_sqlite(f.db);
        await migrate_sqlite(f.db);
        assert.deepEqual(await f.all("select * from temporal_facts"), facts);
        assert.deepEqual(
            await f.all("select * from memories order by id"),
            memories,
        );
        assert.deepEqual(await f.all("select * from temporal_edges"), [
            { id: "edge", source_id: "original", target_id: "original" },
        ]);
        assert.deepEqual(await f.all("pragma foreign_key_check"), []);
        assert.equal(
            (
                await f.all(
                    "select name from sqlite_master where name='custom_fact_index'",
                )
            ).length,
            1,
        );
        assert.deepEqual(await f.all("select * from document_sections"), [
            { document_id: "root", section_index: 0, memory_id: "child" },
        ]);
        await f.run(
            "insert into temporal_facts select 'bob','bob',subject,predicate,object,valid_from,valid_to,confidence,last_updated,metadata from temporal_facts where id='original'",
        );
        await assert.rejects(
            f.run(
                "insert into temporal_facts select 'duplicate','alice',subject,predicate,object,valid_from,valid_to,confidence,last_updated,metadata from temporal_facts where id='original'",
            ),
            /UNIQUE/,
        );
        await f.run(
            "insert into temporal_facts select 'unowned',null,subject,predicate,object,valid_from,valid_to,confidence,last_updated,metadata from temporal_facts where id='original'",
        );
        await assert.rejects(
            f.run(
                "insert into temporal_facts select 'duplicate-null',null,subject,predicate,object,valid_from,valid_to,confidence,last_updated,metadata from temporal_facts where id='original'",
            ),
            /UNIQUE/,
        );
        assert.deepEqual(await f.all("select * from _om_migrations"), [
            { version: 1 },
            { version: 2 },
        ]);
        assert.deepEqual(
            await f.all(
                "select id,hex(v) as bytes,dim,provenance from vectors",
            ),
            [{ id: "legacy", bytes: "0000803F", dim: 1, provenance: null }],
        );
        await f.run(
            "update temporal_facts set last_updated=456 where id='original'",
        );
        assert.deepEqual(await f.all("select * from audit"), [
            { message: "original" },
        ]);
    } finally {
        await f.close();
    }

    const custom = await fixture();
    try {
        await custom.run(
            "alter table temporal_facts add column private_extension text",
        );
        await assert.rejects(
            migrate_sqlite(custom.db),
            /Unsupported temporal_facts schema/,
        );
        assert.equal(
            (await custom.all("select * from temporal_facts"))[0]
                .private_extension,
            null,
        );
        assert.deepEqual(
            await custom.all(
                "select name from sqlite_master where name='_om_migrations'",
            ),
            [],
        );
    } finally {
        await custom.close();
    }

    const failed = await fixture();
    try {
        await failed.run(
            "create table _om_migrations(version integer primary key)",
        );
        await failed.run(
            "create trigger fail_marker before insert on _om_migrations begin select raise(abort,'injected migration failure'); end",
        );
        const schema = await failed.all(
            "select name,sql from sqlite_master order by name",
        );
        const data = await failed.all("select * from temporal_facts");
        await assert.rejects(
            migrate_sqlite(failed.db),
            /injected migration failure/,
        );
        assert.deepEqual(
            await failed.all(
                "select name,sql from sqlite_master order by name",
            ),
            schema,
        );
        assert.deepEqual(
            await failed.all("select * from temporal_facts"),
            data,
        );
        await failed.run("drop trigger fail_marker");
        await migrate_sqlite(failed.db);
    } finally {
        await failed.close();
    }
    console.log(
        "[MIGRATION] legacy preservation, tenant uniqueness, unambiguous backfill, rollback and repeatability passed",
    );
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
