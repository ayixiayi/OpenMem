import assert from "node:assert/strict";

process.env.OM_DB_PATH = ":memory:";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";
process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_TIER = "hybrid";

async function main() {
    const { q, run_async, all_async, vector_store } = await import(
        "../src/core/db"
    );
    const hsg = await import("../src/memory/hsg");
    const { vectorToBuffer, embedQueryForAllSectors } = await import(
        "../src/memory/embed"
    );
    const now = Date.now();
    async function seed(
        id: string,
        user: string,
        project: string,
        vector?: number[],
    ) {
        await run_async(
            `insert into memories(id,user_id,project,content,primary_sector,tags,meta,created_at,updated_at,last_seen_at,salience,decay_lambda,mean_vec) values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
                id,
                user,
                project,
                id,
                "semantic",
                "[]",
                "{}",
                now,
                now,
                now,
                0.4,
                0.005,
                vector ? vectorToBuffer(vector) : null,
            ],
        );
        if (vector)
            await vector_store.storeVector(
                id,
                "semantic",
                vector,
                vector.length,
                user,
            );
    }

    // Five stronger matches in another project must not starve topK=1 in ours.
    const text = "project candidate isolation regression";
    const query = (await embedQueryForAllSectors(text, ["semantic"])).semantic;
    for (let i = 0; i < 5; i++)
        await seed(`foreign-${i}`, "alice", "other", query);
    await seed(
        "wanted",
        "alice",
        "target",
        query.map((v) => -v),
    );
    await seed("wrong-user", "bob", "target", query);
    assert.equal(
        (
            await vector_store.searchSimilar("semantic", query, 1, "alice")
        )[0].id.startsWith("foreign"),
        true,
    );
    assert.deepEqual(
        (
            await vector_store.searchSimilar(
                "semantic",
                query,
                1,
                "alice",
                "target",
            )
        ).map((r) => r.id),
        ["wanted"],
    );
    assert.equal(
        (
            await vector_store.searchSimilar(
                "semantic",
                query,
                1,
                undefined,
                "target",
            )
        )[0].id,
        "wrong-user",
    );
    assert.deepEqual(
        await vector_store.searchSimilar(
            "semantic",
            query,
            1,
            "alice",
            "missing",
        ),
        [],
    );
    assert.deepEqual(
        (
            await hsg.hsg_query(text, 1, {
                user_id: "alice",
                project: "target",
                sectors: ["semantic"],
            })
        ).map((r) => r.id),
        ["wanted"],
    );

    await seed("a", "alice", "alpha", [1, 0]);
    await seed("b", "alice", "beta", [1, 0]);
    await seed("c", "bob", "alpha", [1, 0]);
    await seed("d", "alice", "alpha", [0.8, 0.6]);
    await hsg.create_single_waypoint("a", [1, 0], now, "alice");
    assert.equal((await q.get_neighbors.all("a"))[0].dst_id, "d");
    await run_async("delete from waypoints");
    await hsg.create_contextual_waypoints("a", ["b", "c", "d"], 0.4, "alice");
    assert.deepEqual(
        (await q.get_neighbors.all("a")).map((r: any) => r.dst_id),
        ["d"],
    );
    await hsg.reinforce_waypoints(["a", "d"]);
    assert.equal((await q.get_waypoint.get("a", "d")).weight, 0.45);

    // Existing bad edges cannot bridge into another scope, even if the far end returns to ours.
    await run_async("delete from waypoints");
    await q.ins_waypoint.run("a", "b", "alice", 0.7, now, now);
    await q.ins_waypoint.run("b", "d", "alice", 0.8, now, now);
    const before = await all_async("select * from waypoints order by src_id");
    assert.deepEqual(
        (
            await hsg.expand_via_waypoints(["a"], 10, {
                user_id: "alice",
                project: "alpha",
            })
        ).map((r) => r.id),
        ["a"],
    );
    assert.deepEqual(
        await hsg.expand_via_waypoints(["c"], 10, { user_id: "alice" }),
        [],
    );
    await hsg.reinforce_waypoints(["a", "b", "d"]);
    assert.deepEqual(
        await all_async("select * from waypoints order by src_id"),
        before,
    );
    await q.ins_waypoint.run("a", "d", "alice", 0.7, now, now);
    await q.ins_waypoint.run("d", "c", "alice", 0.8, now, now);
    assert.deepEqual(
        (await hsg.expand_via_waypoints(["a"], 10)).map((r) => r.id),
        ["a", "d"],
    );

    // Query a graph-only result with a bad outgoing edge: returning it must not
    // propagate salience or last_seen changes to the foreign memory.
    await seed(
        "root",
        "alice",
        "graph",
        query.map(() => 0),
    );
    await seed("linked", "alice", "graph");
    await q.ins_waypoint.run("root", "linked", "alice", 0.9, now, now);
    await q.ins_waypoint.run("linked", "c", "alice", 0.8, now, now);
    const foreignBefore = await q.get_mem.get("c");
    const hits = await hsg.hsg_query("graph-only reinforcement isolation", 2, {
        user_id: "alice",
        project: "graph",
        sectors: ["semantic"],
    });
    assert.deepEqual(hits.map((r) => r.id).sort(), ["linked", "root"]);
    assert.deepEqual(hits.find((r) => r.id === "linked")?.path, [
        "root",
        "linked",
    ]);
    assert.deepEqual(await q.get_mem.get("c"), foreignBefore);
    assert.equal((await q.get_waypoint.get("linked", "c")).weight, 0.8);

    // Validate native PG binding order and the configured metadata table without a PG server.
    const { PostgresVectorStore } = await import("../src/core/vector/postgres");
    const calls: Array<{ sql: string; params: any[] }> = [];
    const pg = new PostgresVectorStore(
        {
            run_async: async () => {},
            get_async: async () => null,
            all_async: async (sql, params = []) => {
                calls.push({ sql, params });
                return [];
            },
        },
        '"audit"."vectors"',
        true,
        '"audit"."memories"',
    );
    await pg.searchSimilar("semantic", [1, 0], 3, "alice", "alpha");
    assert.deepEqual(calls[0].params, [
        "[1,0]",
        "semantic",
        3,
        "alice",
        "alpha",
    ]);
    assert.match(
        calls[0].sql,
        /select id from "audit"\."memories" where project=\$5/,
    );
    await pg.searchSimilar("semantic", [1, 0], 3, undefined, "alpha");
    assert.deepEqual(calls[1].params, ["[1,0]", "semantic", 3, "alpha"]);
    assert.match(calls[1].sql, /project=\$4/);

    // Exercise the Valkey scoped path with binary buffers and a missing sector vector.
    const { ValkeyVectorStore } = await import("../src/core/vector/valkey");
    const valkey = Object.create(ValkeyVectorStore.prototype) as any;
    valkey.scopedMemoryIds = async (user: string, project: string) => {
        assert.equal(user, "alice");
        assert.equal(project, "alpha");
        return ["low", "missing", "high"];
    };
    valkey.client = {
        pipeline() {
            const keys: string[] = [];
            return {
                hgetBuffer(key: string) {
                    keys.push(key);
                },
                async exec() {
                    return keys.map((key) => [
                        null,
                        key.endsWith("missing")
                            ? null
                            : vectorToBuffer(
                                  key.endsWith("high") ? [1, 0] : [0.6, 0.8],
                              ),
                    ]);
                },
            };
        },
    };
    const result = await valkey.searchSimilar(
        "semantic",
        [1, 0],
        1,
        "alice",
        "alpha",
    );
    assert.deepEqual(result, [{ id: "high", score: 1 }]);
    console.log(
        "[SCOPE] Candidate filtering, graph boundaries, waypoint updates and backend contracts passed",
    );
}

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
