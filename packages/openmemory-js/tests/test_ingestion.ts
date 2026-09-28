import assert from "node:assert/strict";

process.env.OM_DB_PATH = ":memory:";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";
process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_TIER = "hybrid";

async function main() {
    const { ingestDocument } = await import("../src/ops/ingest");
    const { q, all_async } = await import("../src/core/db");
    const result = await ingestDocument(
        "text",
        "Apples grow on trees in orchards.\n\nSubmarines explore the deepest ocean.",
        { source: "fixture" },
        { force_root: true, sec_sz: 40 },
        "alice",
    );
    assert.equal(result.strategy, "root-child");
    assert.equal(result.child_count, 2);
    const root = await q.get_mem.get(result.root_memory_id);
    assert.equal(root.user_id, "alice");
    assert.equal(root.project, "default");
    assert.equal(root.primary_sector, "reflective");
    assert.equal(root.salience, 1);
    assert.equal(root.segment, 0);
    assert.match(root.content, /split across 2 sections/);
    assert.equal(JSON.parse(root.meta).source, "fixture");
    const children = (
        await all_async("select * from memories where id<>?", [root.id])
    ).sort(
        (a, b) =>
            JSON.parse(a.meta).section_index - JSON.parse(b.meta).section_index,
    );
    assert.equal(children.length, 2);
    for (const [index, child] of children.entries()) {
        const meta = JSON.parse(child.meta);
        assert.equal(child.user_id, "alice");
        assert.equal(child.project, "default");
        assert.equal(meta.parent_id, root.id);
        assert.equal(meta.section_index, index);
        assert.equal(meta.total_sections, 2);
        assert.ok(
            (await all_async("select id from vectors where id=?", [child.id]))
                .length > 0,
        );
    }
    assert.match(children[0].content, /Apples/);
    assert.match(children[1].content, /Submarines/);
    const repeated = await ingestDocument("text", "Apples grow on trees in orchards.\n\nSubmarines explore the deepest ocean.", { source: "second" }, { force_root: true, sec_sz: 40 }, "alice");
    const membership = await q.get_document_sections.all(repeated.root_memory_id);
    assert.deepEqual(membership.map(row => [row.section_index, row.id]), children.map((row, index) => [index, row.id]));
    assert.equal((await q.get_document_sections.all(root.id)).length, 2);
    assert.equal(JSON.parse((await q.get_mem.get(children[0].id)).meta).parent_id, root.id);
    await q.del_mem.run(root.id);
    assert.equal((await q.get_document_sections.all(root.id)).length, 0);
    assert.equal((await q.get_document_sections.all(repeated.root_memory_id)).length, 2);
    assert.ok(await q.get_mem.get(children[0].id));
    console.log(
        "[INGESTION] root field bindings, actual section count and child metadata passed",
    );
}
main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
