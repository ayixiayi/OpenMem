import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "openmemory-session-test-"));
process.env.HOME = home;
process.env.OM_DB_PATH = ":memory:";
process.env.OM_METADATA_BACKEND = "sqlite";
process.env.OM_VECTOR_BACKEND = "sqlite";
process.env.OM_EMBEDDINGS = "synthetic";
process.env.OM_TIER = "hybrid";

async function main() {
    const { Client } = await import(
        "@modelcontextprotocol/sdk/client/index.js"
    );
    const { InMemoryTransport } = await import(
        "@modelcontextprotocol/sdk/inMemory.js"
    );
    const { create_mcp_srv } = await import("../src/ai/mcp");
    const { q, run_async, all_async } = await import("../src/core/db");
    const server = create_mcp_srv();
    const client = new Client({
        name: "session-regressions",
        version: "1.0.0",
    });
    const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
        const call = (name: string, args: Record<string, unknown>) =>
            client.callTool({ name, arguments: args });
        const text = (result: any) =>
            result.content.map((item: any) => item.text || "").join("\n");
        const summarize = (
            session_id: string,
            project: string,
            user_id?: string,
            request = "summary",
        ) =>
            call("openmemory_summarize", {
                session_id,
                project,
                user_id,
                request,
                completed: `${request}-done`,
                learned: `${request}-learned`,
            });

        const tools = await client.listTools();
        for (const name of [
            "openmemory_summarize",
            "openmemory_wakeup",
            "openmemory_timeline",
            "openmemory_consolidate",
        ]) {
            const schema = tools.tools.find(
                (tool) => tool.name === name,
            )!.inputSchema;
            assert.ok(schema.properties?.user_id);
            assert.ok(!schema.required?.includes("user_id"));
        }

        assert.ok(
            !(
                await summarize(
                    "alice-session",
                    "shared",
                    " alice ",
                    "A-private-summary",
                )
            ).isError,
        );
        const owned = await q.get_session.get("alice-session");
        assert.equal(owned.user_id, "alice");
        await q.end_session.run(1234, "alice-session");
        const before = await q.get_session.get("alice-session");
        assert.ok(
            !(await summarize("alice-session", "shared", "alice", "A-repeat"))
                .isError,
        );
        assert.deepEqual(await q.get_session.get("alice-session"), before);
        const summariesBefore = await all_async(
            "select * from summaries order by id",
        );
        for (const [project, user] of [
            ["shared", "bob"],
            ["other", "alice"],
            ["shared", undefined],
        ]) {
            const result = await summarize("alice-session", project!, user);
            assert.equal(result.isError, true);
            assert.match(text(result), /different user or project/);
        }
        assert.deepEqual(await q.get_session.get("alice-session"), before);
        assert.deepEqual(
            await all_async("select * from summaries order by id"),
            summariesBefore,
        );

        assert.ok(
            !(
                await summarize(
                    "legacy-session",
                    "shared",
                    undefined,
                    "legacy-summary",
                )
            ).isError,
        );
        assert.equal((await q.get_session.get("legacy-session")).user_id, null);
        assert.equal(
            (await summarize("legacy-session", "shared", "alice")).isError,
            true,
        );

        // Failure after session insertion must roll back the session too.
        await run_async(
            "create trigger reject_summary before insert on summaries when new.request='fail' begin select raise(abort, 'forced summary failure'); end",
        );
        assert.equal(
            (await summarize("failed-session", "shared", "alice", "fail"))
                .isError,
            true,
        );
        assert.equal(await q.get_session.get("failed-session"), undefined);
        assert.equal(
            (await summarize("alice-session", "shared", "alice", "fail"))
                .isError,
            true,
        );
        assert.deepEqual(await q.get_session.get("alice-session"), before);

        // Concurrent conflicting claims: one owner wins, never two mixed summaries.
        const claims = await Promise.all([
            summarize("contested", "race", "alice", "race-alice"),
            summarize("contested", "race", "bob", "race-bob"),
        ]);
        assert.equal(claims.filter((result) => !result.isError).length, 1);
        const raceOwner = (await q.get_session.get("contested")).user_id;
        const raceRows = await q.get_summaries_by_project.all(
            "race",
            10,
            raceOwner,
        );
        assert.equal(raceRows.length, 1);
        assert.equal(raceRows[0].request, `race-${raceOwner}`);

        // Higher salience/newer foreign records must not consume scoped limits.
        await run_async(
            "update summaries set created_at=100 where session_id='alice-session'",
        );
        for (let i = 0; i < 4; i++) {
            assert.ok(
                !(
                    await summarize(
                        `bob-${i}`,
                        "shared",
                        "bob",
                        `B-private-summary-${i}`,
                    )
                ).isError,
            );
        }
        assert.ok(
            !(
                await summarize(
                    "alice-other",
                    "other",
                    "alice",
                    "other-project-secret",
                )
            ).isError,
        );
        // Old inconsistent rows must not acquire ownership through a mismatched session.
        await q.ins_summary.run(
            "alice-other",
            "shared",
            "mismatched-secret",
            "x",
            "x",
            null,
            null,
            Date.now(),
        );
        await q.ins_summary.run(
            "missing-session",
            "shared",
            "orphan-secret",
            "x",
            "x",
            null,
            null,
            Date.now(),
        );
        for (const [id, user, project, content, salience] of [
            ["a", "alice", "shared", "A-private-memory", 0.1],
            ["b", "bob", "shared", "B-private-memory", 1],
            ["c", "alice", "other", "other-project-memory", 1],
        ]) {
            await run_async(
                "insert into memories(id,user_id,project,content,primary_sector,salience,created_at) values(?,?,?,?,?,?,?)",
                [id, user, project, content, "semantic", salience, 100],
            );
        }
        const wake = await call("openmemory_wakeup", {
            project: "shared",
            user_id: "alice",
            limit: 1,
        });
        assert.ok(!wake.isError, text(wake));
        assert.match(text(wake), /A-private-memory/);
        assert.match(text(wake), /A-private-summary/);
        assert.doesNotMatch(
            text(wake),
            /B-private|other-project|orphan-secret|mismatched-secret|legacy-summary/,
        );
        const globalWake = await call("openmemory_wakeup", {
            project: "shared",
            limit: 1,
        });
        assert.ok(!globalWake.isError);
        assert.match(text(globalWake), /B-private-memory/);
        const unknown = await call("openmemory_wakeup", {
            project: "shared",
            user_id: "bob' OR 1=1 --",
        });
        assert.ok(!unknown.isError);
        assert.match(text(unknown), /No memories found/);

        await run_async("update memories set created_at=300 where id='c'");
        await run_async(
            "insert into memories(id,user_id,project,content,primary_sector,salience,created_at) values('d','alice','shared','emotion','emotional',0.9,400)",
        );
        const listed = await call("openmemory_list", {
            user_id: "alice",
            project: "shared",
            sector: "semantic",
            limit: 1,
        });
        assert.ok(!listed.isError, text(listed));
        const listedItems = JSON.parse((listed.content as any[])[1].text).items;
        assert.deepEqual(
            listedItems.map((row: any) => row.id),
            ["a"],
        );
        const projectList = await call("openmemory_list", {
            project: "shared",
            sector: "semantic",
            limit: 1,
        });
        assert.ok(!projectList.isError, text(projectList));
        assert.deepEqual(
            JSON.parse((projectList.content as any[])[1].text).items.map(
                (row: any) => row.id,
            ),
            ["b"],
        );

        const { mem } = await import("../src/server/routes/memory");
        const handlers = new Map<
            string,
            (req: any, res: any) => Promise<void>
        >();
        mem({
            get: (path: string, handler: any) => handlers.set(path, handler),
            post() {},
            patch() {},
            delete() {},
        });
        let payload: any;
        let status = 200;
        const response = {
            json(value: any) {
                payload = value;
            },
            status(value: number) {
                status = value;
                return response;
            },
        };
        await handlers.get("/memory/all")!(
            {
                query: {
                    user_id: "alice",
                    project: "shared",
                    sector: "semantic",
                    l: "1",
                },
            },
            response,
        );
        assert.equal(status, 200);
        assert.deepEqual(
            payload.items.map((row: any) => row.id),
            ["a"],
        );
        await handlers.get("/memory/all")!(
            {
                query: {
                    user_id: "alice",
                    project: "shared",
                    sector: "semantic",
                    l: "1",
                    u: "1",
                },
            },
            response,
        );
        assert.deepEqual(payload.items, []);

        await run_async("update memories set created_at=150 where id='b'");
        const timeline = await call("openmemory_timeline", {
            memory_id: "a",
            user_id: "alice",
            depth_after: 1,
        });
        assert.ok(!timeline.isError, text(timeline));
        assert.deepEqual(
            JSON.parse(text(timeline)).timeline.map((row: any) => row.id),
            ["a", "d"],
        );
        assert.equal(
            (
                await call("openmemory_timeline", {
                    memory_id: "a",
                    user_id: "bob",
                })
            ).isError,
            true,
        );
        const globalTimeline = await call("openmemory_timeline", {
            memory_id: "a",
            depth_after: 1,
        });
        assert.deepEqual(
            JSON.parse(text(globalTimeline)).timeline.map((row: any) => row.id),
            ["a", "b"],
        );

        for (let i = 0; i < 15; i++) {
            await run_async(
                "insert into memories(id,user_id,project,content,primary_sector,salience,created_at) values(?,?,'shared','candidate','semantic',?,?)",
                [
                    `candidate-${i}`,
                    i < 11 ? "alice" : "bob",
                    i < 11 ? 0.3 : 0.01,
                    500 + i,
                ],
            );
        }
        const consolidated = await call("openmemory_consolidate", {
            project: "shared",
            user_id: "alice",
            threshold: 10,
            candidate_count: 5,
        });
        assert.ok(!consolidated.isError, text(consolidated));
        const aliceCandidates = JSON.parse(text(consolidated));
        assert.equal(aliceCandidates.total_memories, 13);
        assert.equal(aliceCandidates.needs_consolidation, true);
        assert.deepEqual(
            aliceCandidates.candidates.map((row: any) => row.id),
            ["a", "candidate-0", "candidate-1", "candidate-2", "candidate-3"],
        );
        const bobCandidates = JSON.parse(
            text(
                await call("openmemory_consolidate", {
                    project: "shared",
                    user_id: "bob",
                    threshold: 10,
                }),
            ),
        );
        assert.equal(bobCandidates.total_memories, 5);
        assert.equal(bobCandidates.needs_consolidation, false);
        const globalCandidates = JSON.parse(
            text(
                await call("openmemory_consolidate", {
                    project: "shared",
                    threshold: 10,
                }),
            ),
        );
        assert.equal(globalCandidates.total_memories, 18);
        assert.equal(globalCandidates.needs_consolidation, true);
        console.log(
            "[SESSIONS] MCP ownership, rollback, concurrency and scoped context tools passed",
        );
    } finally {
        await client.close();
        await server.close();
    }
}

main().then(
    () => {
        rmSync(home, { recursive: true, force: true });
        process.exit(0);
    },
    (error) => {
        console.error(error);
        rmSync(home, { recursive: true, force: true });
        process.exit(1);
    },
);
