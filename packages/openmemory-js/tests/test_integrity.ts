import assert from "node:assert/strict";

// Never let this regression suite open a configured persistent database.
process.env.OM_DB_PATH = ":memory:";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";
process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_TIER = "hybrid";

async function main() {
    const { add_hsg_memory } = await import("../src/memory/hsg");
    const { all_async, get_async } = await import("../src/core/db");
    const { insert_fact, batch_insert_facts } = await import(
        "../src/temporal_graph/store"
    );
    const text =
        "Integrity regression: use a scoped immutable document identifier.";
    const scopes: Array<[string | undefined, string | undefined]> = [
        ["alice", "alpha"],
        ["bob", "alpha"],
        ["alice", "beta"],
        [undefined, undefined],
        [undefined, "alpha"],
    ];
    const ids: string[] = [];
    for (const [user, project] of scopes) {
        const added = await add_hsg_memory(
            text,
            undefined,
            undefined,
            user,
            project,
        );
        assert.ok(!added.deduplicated);
        ids.push(added.id);
        const repeated = await add_hsg_memory(
            text,
            undefined,
            undefined,
            user,
            project,
        );
        assert.equal(repeated.id, added.id);
        assert.equal(repeated.deduplicated, true);
    }
    assert.equal(new Set(ids).size, scopes.length);
    assert.equal(
        (await all_async("SELECT id FROM memories")).length,
        scopes.length,
    );
    const defaults = await add_hsg_memory(
        text,
        undefined,
        undefined,
        "anonymous",
        "default",
    );
    assert.equal(defaults.id, ids[3]);
    const concurrent = await Promise.all(
        [0, 1].map(() =>
            add_hsg_memory(
                "Concurrent identical content",
                undefined,
                undefined,
                undefined,
                "concurrent",
            ),
        ),
    );
    assert.equal(concurrent[0].id, concurrent[1].id);

    const a = await insert_fact(
        "person",
        "city",
        "Paris",
        new Date(1000),
        1,
        undefined,
        "alice",
    );
    const b = await insert_fact(
        "person",
        "city",
        "Berlin",
        new Date(1100),
        1,
        undefined,
        "bob",
    );
    const anonymous = await insert_fact(
        "person",
        "city",
        "Oslo",
        new Date(1200),
    );
    await insert_fact("person", "city", "Rome", new Date(2000));
    assert.equal(
        (await get_async("SELECT valid_to FROM temporal_facts WHERE id=?", [a]))
            .valid_to,
        null,
    );
    assert.equal(
        (await get_async("SELECT valid_to FROM temporal_facts WHERE id=?", [b]))
            .valid_to,
        null,
    );
    assert.equal(
        (
            await get_async("SELECT valid_to FROM temporal_facts WHERE id=?", [
                anonymous,
            ])
        ).valid_to,
        1999,
    );

    const before = await all_async("SELECT * FROM temporal_facts ORDER BY id");
    await assert.rejects(
        insert_fact(
            "person",
            "city",
            "Tokyo",
            new Date(3000),
            2,
            undefined,
            "alice",
        ),
    );
    assert.deepEqual(
        await all_async("SELECT * FROM temporal_facts ORDER BY id"),
        before,
    );
    await assert.rejects(
        batch_insert_facts(
            [
                {
                    subject: "person",
                    predicate: "city",
                    object: "Madrid",
                    valid_from: new Date(3000),
                },
                {
                    subject: "person",
                    predicate: "city",
                    object: "Lima",
                    valid_from: new Date(4000),
                    confidence: 2,
                },
            ],
            "alice",
        ),
    );
    assert.deepEqual(
        await all_async("SELECT * FROM temporal_facts ORDER BY id"),
        before,
    );
    const batch = await batch_insert_facts(
        [
            {
                subject: "person",
                predicate: "city",
                object: "Madrid",
                valid_from: new Date(3000),
            },
            {
                subject: "person",
                predicate: "city",
                object: "Lima",
                valid_from: new Date(4000),
            },
        ],
        "alice",
    );
    assert.equal(
        (await get_async("SELECT valid_to FROM temporal_facts WHERE id=?", [a]))
            .valid_to,
        2999,
    );
    assert.equal(
        (
            await get_async("SELECT valid_to FROM temporal_facts WHERE id=?", [
                batch[0],
            ])
        ).valid_to,
        3999,
    );
    assert.equal(
        (
            await get_async("SELECT valid_to FROM temporal_facts WHERE id=?", [
                batch[1],
            ])
        ).valid_to,
        null,
    );
    const routes = await import("../src/server/routes/temporal");
    const invoke = async (
        handler: (req: any, res: any) => Promise<any>,
        req: any,
    ) => {
        let body: any;
        let status = 200;
        const res = {
            status(code: number) {
                status = code;
                return res;
            },
            json(value: any) {
                body = value;
            },
        };
        await handler(req, res);
        assert.equal(status, 200);
        return body;
    };
    const created = await invoke(routes.create_temporal_fact, {
        body: {
            subject: "api-person",
            predicate: "city",
            object: "Paris",
            user_id: "alice",
            valid_from: 1000,
        },
    });
    await invoke(routes.create_temporal_fact, {
        body: {
            subject: "api-person",
            predicate: "city",
            object: "Berlin",
            user_id: "bob",
            valid_from: 2000,
        },
    });
    const found = await invoke(routes.get_temporal_fact, {
        query: {
            subject: "api-person",
            user_id: "alice",
            at: 3000,
        },
    });
    assert.deepEqual(
        found.facts.map((f: any) => f.id),
        [created.id],
    );
    assert.equal(found.facts[0].user_id, "alice");
    const current = await invoke(routes.get_current_temporal_fact, {
        query: {
            subject: "api-person",
            predicate: "city",
            user_id: "alice",
        },
    });
    assert.equal(current.fact.id, created.id);
    console.log(
        "[INTEGRITY] Scoped deduplication, temporal isolation and rollback passed",
    );
}

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
