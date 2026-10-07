import assert from "node:assert/strict";

process.env.OM_DB_PATH = ":memory:";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";
process.env.OM_EMBEDDINGS = "synthetic";

function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function main() {
    const { transaction, run_async, all_async, q } = await import(
        "../src/core/db"
    );
    const ready = gate(),
        proceed = gate();
    const failure = new Error("rollback A");
    const a = transaction.run(async () => {
        await q.ins_session.run("A", "project", 1, "alice");
        ready.resolve();
        await proceed.promise;
        throw failure;
    });
    const aCheck = assert.rejects(a, (error) => error === failure);
    await ready.promise;
    // These DAO and raw calls must queue outside A, not join its transaction.
    const outside = q.ins_session.run("outside", "project", 2, "bob");
    const read = all_async("select id from sessions order by id");
    const b = transaction.run(async () => {
        await q.ins_session.run("B", "project", 3, "bob");
        await assert.rejects(
            transaction.run(async () => {}),
            /Nested transactions/,
        );
        return 42;
    });
    // Give the old unguarded implementation time to submit outside SQL before rollback.
    await new Promise((resolve) => setTimeout(resolve, 25));
    proceed.resolve();
    await aCheck;
    await outside;
    assert.deepEqual(await read, [{ id: "outside" }]);
    assert.equal(await b, 42);
    assert.deepEqual(await all_async("select id from sessions order by id"), [
        { id: "B" },
        { id: "outside" },
    ]);

    await assert.rejects(
        transaction.run(async () => {
            await q.ins_session.run("failed", "project", 4, null);
            await run_async(
                "insert into sessions(id,project,started_at) values('B','duplicate',5)",
            );
        }),
        /UNIQUE/,
    );
    assert.equal(await q.get_session.get("failed"), undefined);
    assert.equal((await q.get_session.get("B")).project, "project");

    const late = gate();
    let detached!: Promise<void>;
    await transaction.run(async () => {
        detached = late.promise.then(() =>
            q.ins_session.run("late", "project", 6, null),
        );
    });
    const lateCheck = assert.rejects(detached, /already finished/);
    late.resolve();
    await lateCheck;
    assert.equal(await q.get_session.get("late"), undefined);
    await transaction.run(async () => {
        await q.ins_session.run("recovered", "project", 7, null);
    });
    assert.equal((await q.get_session.get("recovered")).started_at, 7);
    await run_async(
        "insert into memories(id,content,primary_sector,salience,last_seen_at,updated_at,feedback_score) values('target','one','semantic',0.2,10,11,0),('47','decoy','semantic',0.9,20,21,0.8)",
    );
    await q.upd_seen.run("target", 23, 0.65, 47);
    await q.upd_feedback.run("target", 0.37);
    assert.deepEqual(
        await all_async(
            "select id,last_seen_at,salience,updated_at,feedback_score from memories order by id",
        ),
        [
            {
                id: "47",
                last_seen_at: 20,
                salience: 0.9,
                updated_at: 21,
                feedback_score: 0.8,
            },
            {
                id: "target",
                last_seen_at: 23,
                salience: 0.65,
                updated_at: 47,
                feedback_score: 0.37,
            },
        ],
    );
    await q.ins_user.run("alice", "old profile", 0, 10, 11);
    await q.ins_user.run("91", "decoy profile", 4, 20, 21);
    await q.upd_user_summary.run("alice", "new profile", 91);
    assert.deepEqual(
        await all_async(
            "select user_id,summary,reflection_count,updated_at from users order by user_id",
        ),
        [
            {
                user_id: "91",
                summary: "decoy profile",
                reflection_count: 4,
                updated_at: 21,
            },
            {
                user_id: "alice",
                summary: "new profile",
                reflection_count: 1,
                updated_at: 91,
            },
        ],
    );
    console.log(
        "[SQLITE TRANSACTIONS] outside queries, rollback, nested rejection and expired contexts passed",
    );
}

const timeout = setTimeout(() => {
    console.error("SQLite regression timed out");
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
