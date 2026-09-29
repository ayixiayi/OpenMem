import assert from "node:assert/strict";

async function main() {
    const { q, run_async, vector_store } = await import("../src/core/db");
    const { Memory } = await import("../src/core/memory");
    const { add_hsg_memory, hsg_query, delete_memory, update_memory } =
        await import("../src/memory/hsg");
    const record = await add_hsg_memory(
        "Fresh lifecycle regression text",
        "[]",
        {},
        "alice",
    );
    const filter = { user_id: "alice", sectors: ["semantic"] };
    const query = "Fresh lifecycle regression text";
    assert.equal((await hsg_query(query, 1, filter))[0].id, record.id);
    await run_async("UPDATE memories SET content=? WHERE id=?", [
        "changed",
        record.id,
    ]);
    assert.equal((await hsg_query(query, 1, filter))[0].content, "changed");
    const originalDelete = vector_store.deleteVectors.bind(vector_store);
    const originalLog = q.ins_log.run;
    q.ins_log.run = async () => {
        throw new Error("generation unavailable");
    };
    let prematureDeletes = 0;
    vector_store.deleteVectors = async () => {
        prematureDeletes++;
    };
    await assert.rejects(
        update_memory(record.id, "replacement"),
        /generation unavailable/,
    );
    assert.equal(
        prematureDeletes,
        0,
        "generation failure must not remove external vectors",
    );
    assert.equal((await q.get_mem.get(record.id)).content, "changed");
    q.ins_log.run = originalLog;
    vector_store.deleteVectors = async () => {
        throw new Error("external offline");
    };
    await assert.rejects(delete_memory(record.id), /external offline/);
    assert.ok(await q.get_mem.get(record.id));
    vector_store.deleteVectors = originalDelete;
    await delete_memory(record.id);
    assert.deepEqual(await hsg_query(query, 1, filter), []);
    assert.deepEqual(await vector_store.getVectorsById(record.id), []);

    for (let i = 0; i < 103; i++) {
        await run_async(
            "INSERT INTO memories(id,user_id,content,primary_sector) VALUES (?,?,?,'semantic')",
            [`a${i}`, "alice", "fixture"],
        );
    }
    await run_async(
        "INSERT INTO memories(id,user_id,content,primary_sector) VALUES ('bob','bob','fixture','semantic')",
    );
    const deleted: string[] = [];
    vector_store.deleteVectors = async (id) => {
        deleted.push(id);
        await originalDelete(id);
    };
    await new Memory("alice").delete_all();
    assert.deepEqual(await q.all_mem_by_user.all("alice", 1000, 0), []);
    assert.ok(await q.get_mem.get("bob"));
    assert.equal(new Set(deleted).size, 103);
    assert.ok(!deleted.includes("bob"));
    await new Memory().wipe();
    assert.deepEqual(await q.all_mem.all(10, 0), []);
    assert.ok(deleted.includes("bob"));
    console.log(
        "[LIFECYCLE] Fresh reads, external failures, scoped pagination and wipe passed",
    );
}

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
