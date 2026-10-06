import type sqlite3 from "sqlite3";
import type { Pool } from "pg";

// Only reconstruct relationships explicitly recorded in legacy metadata.
function legacy_sections(rows: any[]): Array<[string, number, string]> {
    const records = new Map(
        rows.map((row) => {
            let meta: any;
            try {
                meta = JSON.parse(row.meta || "{}");
            } catch {
                meta = {};
            }
            return [row.id, { ...row, meta }];
        }),
    );
    const candidates = new Map<string, [string, number, string] | null>();
    for (const child of records.values()) {
        const meta = child.meta;
        if (
            !meta ||
            meta.is_child !== true ||
            !Number.isInteger(meta.section_index) ||
            meta.section_index < 0
        )
            continue;
        const root = records.get(meta.parent_id);
        if (
            !root ||
            root.id === child.id ||
            root.meta?.is_root !== true ||
            root.user_id !== child.user_id ||
            root.project !== child.project
        )
            continue;
        const key = JSON.stringify([root.id, meta.section_index]);
        candidates.set(
            key,
            candidates.has(key)
                ? null
                : [root.id, meta.section_index, child.id],
        );
    }
    return [...candidates.values()].filter(
        (row): row is [string, number, string] => row !== null,
    );
}

export async function migrate_sqlite(db: sqlite3.Database): Promise<void> {
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
    if ((await all("pragma foreign_keys"))[0].foreign_keys)
        throw new Error(
            "SQLite migration requires foreign_keys=OFF before opening the transaction",
        );
    await run("BEGIN IMMEDIATE");
    try {
        await run(
            "create table if not exists _om_migrations(version integer primary key)",
        );
        if (
            !(await all("select version from _om_migrations where version=1"))
                .length
        ) {
            // Rebuild only the SDK's known table. Unknown custom schema must not
            // silently lose columns, indexes or triggers during an upgrade.
            const expected =
                "create table temporal_facts(id text primary key,user_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text,unique(subject,predicate,object,valid_from))";
            const normalize = (sql: string) =>
                sql
                    .toLowerCase()
                    .replace(/\s+|["`\[\]]/g, "")
                    .replace("ifnotexists", "");
            const definition =
                (
                    await all(
                        "select sql from sqlite_master where type='table' and name='temporal_facts'",
                    )
                )[0]?.sql || "";
            if (normalize(definition) !== normalize(expected))
                throw new Error(
                    "Unsupported temporal_facts schema; review migration before upgrading",
                );
            const schema = await all(
                "select type,name,sql from sqlite_master where tbl_name='temporal_facts' and sql is not null and type in ('index','trigger')",
            );
            await run(
                "create table temporal_facts_upgrade(id text primary key,user_id text,subject text not null,predicate text not null,object text not null,valid_from integer not null,valid_to integer,confidence real not null check(confidence >= 0 and confidence <= 1),last_updated integer not null,metadata text)",
            );
            await run(
                "insert into temporal_facts_upgrade select id,user_id,subject,predicate,object,valid_from,valid_to,confidence,last_updated,metadata from temporal_facts",
            );
            await run("drop table temporal_facts");
            await run(
                "alter table temporal_facts_upgrade rename to temporal_facts",
            );
            for (const item of schema) await run(item.sql);
            await run(
                "create unique index temporal_owned_identity on temporal_facts(user_id,subject,predicate,object,valid_from) where user_id is not null",
            );
            await run(
                "create unique index temporal_unowned_identity on temporal_facts(subject,predicate,object,valid_from) where user_id is null",
            );
            await run(
                "create table document_sections(document_id text not null,section_index integer not null check(section_index>=0),memory_id text not null,primary key(document_id,section_index),foreign key(document_id) references memories(id) on delete cascade,foreign key(memory_id) references memories(id) on delete cascade)",
            );
            await run(
                "create index document_sections_memory on document_sections(memory_id)",
            );
            // Existing databases have foreign_keys=OFF; keep deletion atomic anyway.
            await run(
                "create trigger document_sections_delete after delete on memories begin delete from document_sections where document_id=old.id or memory_id=old.id; end",
            );
            for (const row of legacy_sections(
                await all("select id,user_id,project,meta from memories"),
            )) {
                await run("insert into document_sections values(?,?,?)", row);
            }
            await run("insert into _om_migrations values(1)");
        }
        if (
            !(await all("select version from _om_migrations where version=2"))
                .length
        ) {
            await run("alter table vectors add column provenance text");
            await run("insert into _om_migrations values(2)");
        }
        if (
            !(await all("select version from _om_migrations where version=3"))
                .length
        ) {
            // Rows written before memories_fts existed were never indexed, and the
            // old trigger rewrote the index on every salience/feedback update.
            if (
                (
                    await all(
                        "select name from sqlite_master where name='memories_fts'",
                    )
                ).length
            ) {
                await run("drop trigger if exists memories_au");
                await run(
                    "create trigger memories_au after update of content on memories begin insert into memories_fts(memories_fts, rowid, id, content) values ('delete', old.rowid, old.id, old.content); insert into memories_fts(rowid, id, content) values (new.rowid, new.id, new.content); end",
                );
                await run(
                    "insert into memories_fts(memories_fts) values('rebuild')",
                );
            }
            await run("insert into _om_migrations values(3)");
        }
        await run("COMMIT");
    } catch (error) {
        await run("ROLLBACK");
        throw error;
    }
}

export async function migrate_postgres(
    pool: Pool,
    schema: string,
    memories: string,
    vectors: string,
): Promise<void> {
    const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const prefix = quote(schema);
    const facts = `${prefix}."temporal_facts"`;
    const sections = `${prefix}."document_sections"`;
    const versions = `${prefix}."_om_migrations"`;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [
            `openmemory-schema:${schema}`,
        ]);
        await client.query(
            `create table if not exists ${versions}(version integer primary key)`,
        );
        if (
            !(
                await client.query(
                    `select version from ${versions} where version=1`,
                )
            ).rows.length
        ) {
            const old = await client.query(
                "select conname from pg_constraint where conrelid=$1::regclass and contype='u' and pg_get_constraintdef(oid)='UNIQUE (subject, predicate, object, valid_from)'",
                [facts],
            );
            for (const row of old.rows)
                await client.query(
                    `alter table ${facts} drop constraint ${quote(row.conname)}`,
                );
            await client.query(
                `create unique index temporal_owned_identity on ${facts}(user_id,subject,predicate,object,valid_from) where user_id is not null`,
            );
            await client.query(
                `create unique index temporal_unowned_identity on ${facts}(subject,predicate,object,valid_from) where user_id is null`,
            );
            await client.query(
                `create table ${sections}(document_id uuid not null references ${memories}(id) on delete cascade,section_index integer not null check(section_index>=0),memory_id uuid not null references ${memories}(id) on delete cascade,primary key(document_id,section_index))`,
            );
            await client.query(
                `create index document_sections_memory on ${sections}(memory_id)`,
            );
            for (const row of legacy_sections(
                (
                    await client.query(
                        `select id,user_id,project,meta from ${memories}`,
                    )
                ).rows,
            )) {
                await client.query(
                    `insert into ${sections} values($1,$2,$3)`,
                    row,
                );
            }
            await client.query(`insert into ${versions} values(1)`);
        }
        if (
            !(
                await client.query(
                    `select version from ${versions} where version=2`,
                )
            ).rows.length
        ) {
            await client.query(
                `alter table ${vectors} add column provenance text`,
            );
            await client.query(`insert into ${versions} values(2)`);
        }
        await client.query("COMMIT");
    } catch (error) {
        try {
            await client.query("ROLLBACK");
        } catch {
            client.release(true);
            throw error;
        }
        client.release(true);
        throw error;
    }
    client.release();
}
