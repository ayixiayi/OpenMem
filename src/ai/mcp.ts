import type { IncomingMessage, ServerResponse } from "http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { env } from "../core/cfg";
import {
    add_hsg_memory,
    hsg_query,
    reinforce_memory,
    delete_memory,
    sector_configs,
    fts_stopwords,
} from "../memory/hsg";
import {
    q,
    all_async,
    memories_table,
    sessions_table,
    summaries_table,
    vector_store,
    transaction,
} from "../core/db";
import { getEmbeddingInfo } from "../memory/embed";
import { j, p } from "../utils";
import type { sector_type, mem_row, rpc_err_code } from "../core/types";
import { update_user_summary } from "../memory/user_summary";
import {
    insert_fact_in_transaction,
    retract_fact,
    type FactKind,
} from "../temporal_graph/store";
import {
    query_facts_at_time,
    get_facts_by_source,
    get_successor,
} from "../temporal_graph/query";
import type { TemporalFact } from "../temporal_graph/types";
import { tokenize } from "../utils/text";
import { ToolRegistry } from "./mcp_tools";

const SERVER_VERSION = "2.1.0";

const sec_enum = z.enum([
    "episodic",
    "semantic",
    "procedural",
    "emotional",
    "reflective",
] as const);

const trunc = (val: string, max = 200) =>
    val.length <= max ? val : `${val.slice(0, max).trimEnd()}...`;

const build_mem_snap = (row: mem_row) => ({
    id: row.id,
    primary_sector: row.primary_sector,
    salience: Number(row.salience.toFixed(3)),
    last_seen_at: row.last_seen_at,
    user_id: row.user_id,
    content_preview: trunc(row.content, 240),
});

const day = (d: Date) => d.toISOString().slice(0, 10);
const fact_line = (f: TemporalFact) => `${f.subject} · ${f.predicate}: ${f.object}`;
const fact_json = (f: TemporalFact) => ({
    source: "temporal",
    id: f.id,
    subject: f.subject,
    predicate: f.predicate,
    object: f.object,
    kind: f.kind ?? "state",
    scope: f.project ?? "global",
    valid_from: f.valid_from.toISOString(),
    valid_to: f.valid_to ? f.valid_to.toISOString() : null,
    confidence: Number(f.confidence.toFixed(4)),
    source_memory_id: f.source_memory_id ?? null,
    content: `${f.subject} ${f.predicate} ${f.object}`,
});

type linked_fact = {
    id: string;
    fact: string;
    status: "current" | "ended" | "corrected" | "event";
    replaced_by?: { object: string; since: string };
};

/** Facts extracted from these memories, with what replaced them if they ended. */
async function linked_facts(memory_ids: string[], now: number) {
    const by_memory = new Map<string, linked_fact[]>();
    for (const f of await get_facts_by_source(memory_ids)) {
        const ended = f.valid_to !== null && f.valid_to.getTime() < now;
        const status: linked_fact["status"] =
            f.kind === "event"
                ? "event"
                : f.valid_to && f.valid_to < f.valid_from
                  ? "corrected"
                  : ended
                    ? "ended"
                    : "current";
        const entry: linked_fact = { id: f.id, fact: fact_line(f), status };
        if (status === "ended" && (f.kind ?? "state") === "state") {
            const next = await get_successor(f);
            if (next) entry.replaced_by = { object: next.object, since: day(next.valid_from) };
        }
        const list = by_memory.get(f.source_memory_id!) ?? [];
        list.push(entry);
        by_memory.set(f.source_memory_id!, list);
    }
    return by_memory;
}

const fmt_linked = (facts?: linked_fact[]) =>
    (facts ?? [])
        .map((f) =>
            f.status === "ended" || f.status === "corrected"
                ? `\n   ↳ HISTORICAL: ${f.fact} — ${f.status === "corrected" ? "corrected" : f.replaced_by ? `now ${f.replaced_by.object} (since ${f.replaced_by.since})` : "no longer true"}`
                : `\n   ↳ ${f.status === "event" ? "event" : "current fact"}: ${f.fact}`,
        )
        .join("");

/** Words and CJK bigrams used to match a natural-language question to facts. */
const fact_terms = (text: string) =>
    [...new Set(tokenize(text))].filter((t) => t.length >= 2 && !fts_stopwords.has(t));

const fmt_matches = (matches: Awaited<ReturnType<typeof hsg_query>>) =>
    matches
        .map((m: any, idx: any) => {
            const prev = trunc(m.content.replace(/\s+/g, " ").trim(), 200);
            return `${idx + 1}. [${m.primary_sector}] score=${m.score.toFixed(3)} salience=${m.salience.toFixed(3)} id=${m.id}\n${prev}${fmt_linked(m.linked_facts)}`;
        })
        .join("\n\n");

const set_hdrs = (res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type,Authorization,Mcp-Session-Id",
    );
};

const send_err = (
    res: ServerResponse,
    code: rpc_err_code,
    msg: string,
    id: number | string | null = null,
    status = 400,
) => {
    if (!res.headersSent) {
        res.statusCode = status;
        set_hdrs(res);
        res.end(
            JSON.stringify({
                jsonrpc: "2.0",
                error: { code, message: msg },
                id,
            }),
        );
    }
};

const uid = (val?: string | null) => (val?.trim() ? val.trim() : undefined);

export const create_mcp_srv = () => {
    const srv = new McpServer(
        {
            name: "openmem",
            version: SERVER_VERSION,
        },
        { capabilities: { tools: {}, resources: {}, logging: {} } },
    );

    const registry = new ToolRegistry();

    registry.tool(
        "openmemory_query",
        "Search memory. 'contextual' searches observations (why/how/what happened); 'factual' returns facts valid at a point in time (what is true now, or was then); 'unified' does both. Contextual hits whose extracted facts have since changed are marked HISTORICAL.",
        {
            query: z
                .string()
                .min(1, "query text is required")
                .describe("Free-form search text; also matched against fact subject/predicate/object when no fact_pattern is given"),
            type: z
                .enum(["contextual", "factual", "unified"])
                .optional()
                .default("contextual")
                .describe("'contextual' (default), 'factual' or 'unified'"),
            fact_pattern: z
                .object({
                    subject: z.string().optional().describe("Exact entity, e.g. 'backend'"),
                    predicate: z.string().optional().describe("Exact attribute, e.g. 'database'"),
                    object: z.string().optional().describe("Exact value"),
                })
                .optional()
                .describe("Exact fact filter; omit to match facts by the query text"),
            at: z
                .string()
                .optional()
                .describe("ISO date for point-in-time fact queries (default: now)"),
            k: z
                .number()
                .int()
                .min(1)
                .max(32)
                .default(8)
                .describe("Maximum contextual results"),
            fact_limit: z
                .number()
                .int()
                .min(1)
                .max(100)
                .default(20)
                .describe("Maximum factual results"),
            sector: sec_enum
                .optional()
                .describe("Restrict contextual search to a sector"),
            min_salience: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe("Minimum salience (contextual)"),
            min_score: z
                .number()
                .min(0)
                .max(1)
                .optional()
                .describe("Minimum score in [0,1) (contextual)"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Isolate results to a specific user identifier"),
            project: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Project scope. Fact queries also include global facts."),
        },
        async ({
            query,
            type = "contextual",
            fact_pattern,
            at,
            k,
            fact_limit,
            sector,
            min_salience,
            min_score,
            user_id,
            project,
        }) => {
            const u = uid(user_id);
            const proj = project?.trim() || undefined;
            const results: any = { type, query };
            const at_date = at ? new Date(at) : new Date();
            if (Number.isNaN(at_date.getTime())) throw new Error(`Invalid 'at' date: ${at}`);

            if (type === "contextual" || type === "unified") {
                const flt =
                    sector || min_salience !== undefined || u || proj
                        ? {
                            ...(sector ? { sectors: [sector as sector_type] } : {}),
                            ...(min_salience !== undefined
                                ? { minSalience: min_salience }
                                : {}),
                            ...(u ? { user_id: u } : {}),
                            ...(proj ? { project: proj } : {}),
                        }
                        : undefined;

                // hsg_query fuses vector, lexical (FTS) and graph evidence.
                let matches = await hsg_query(query, k ?? 8, flt);
                if (min_score !== undefined) {
                    matches = matches.filter((m: any) => m.score >= min_score);
                }
                const links = await linked_facts(
                    matches.map((m) => m.id),
                    Date.now(),
                );
                results.contextual = matches.map((m: any) => ({
                    source: "hsg",
                    id: m.id,
                    score: Number(m.score.toFixed(4)),
                    primary_sector: m.primary_sector,
                    sectors: m.sectors,
                    salience: Number(m.salience.toFixed(4)),
                    last_seen_at: m.last_seen_at,
                    path: m.path,
                    content: m.content,
                    ...(links.has(m.id) ? { linked_facts: links.get(m.id) } : {}),
                }));
            }

            if (type === "factual" || type === "unified") {
                const pattern =
                    fact_pattern?.subject || fact_pattern?.predicate || fact_pattern?.object
                        ? fact_pattern
                        : undefined;
                const limit = fact_limit ?? 20;
                let facts = await query_facts_at_time(
                    pattern?.subject,
                    pattern?.predicate,
                    pattern?.object,
                    at_date,
                    0.0,
                    u,
                    { project: proj, limit: pattern ? limit : 1000 },
                );
                if (!pattern) {
                    const terms = fact_terms(query);
                    if (terms.length) {
                        facts = facts
                            .map((f) => {
                                const hay = `${f.subject} ${f.predicate} ${f.object}`.toLowerCase();
                                return { f, hits: terms.filter((t) => hay.includes(t)).length };
                            })
                            .filter((x) => x.hits > 0)
                            .sort((a, b) => b.hits - a.hits)
                            .map((x) => x.f);
                    }
                    facts = facts.slice(0, limit);
                }
                results.factual = facts.map(fact_json);
            }

            const fmt_facts = (facts: any[]) =>
                facts
                    .map(
                        (f: any, idx: number) =>
                            `${idx + 1}. [${f.kind}${f.scope === "global" ? ", global" : ""}] ${f.subject} · ${f.predicate}: ${f.object} (since ${f.valid_from.slice(0, 10)}${f.valid_to ? `, until ${f.valid_to.slice(0, 10)}` : ""}) id=${f.id}`,
                    )
                    .join("\n");

            let summ = "";
            if (type === "contextual") {
                summ = results.contextual.length
                    ? fmt_matches(results.contextual)
                    : "No contextual memories matched the query.";
            } else if (type === "factual") {
                summ = results.factual.length
                    ? fmt_facts(results.factual)
                    : "No facts matched the query.";
            } else {
                const ctx_count = results.contextual.length;
                const fact_count = results.factual.length;
                summ = `Found ${fact_count} facts and ${ctx_count} contextual memories.`;
                if (fact_count > 0) summ += `\n\n=== Facts (valid ${at ? `at ${at}` : "now"}) ===\n${fmt_facts(results.factual)}`;
                if (ctx_count > 0) summ += `\n\n=== Contextual Memories ===\n${fmt_matches(results.contextual)}`;
                if (ctx_count === 0 && fact_count === 0) summ = "No results found in either track.";
            }

            return {
                content: [
                    { type: "text", text: summ },
                    {
                        type: "text",
                        text: JSON.stringify(results, null, 2),
                    },
                ],
            };
        },
    );

    registry.tool(
        "openmemory_store",
        "Persist an observation (contextual) and/or structured facts. Use type 'both' when an observation establishes or changes a fact: it is stored atomically and the facts link back to the observation.",
        {
            content: z.string().min(1).describe("The observation, written for a future agent with zero context"),
            type: z
                .enum(["contextual", "factual", "both"])
                .optional()
                .default("contextual")
                .describe("'contextual' (default), 'factual', or 'both' (observation + facts in one transaction)"),
            facts: z
                .array(
                    z.object({
                        subject: z.string().min(1).describe("Entity, e.g. 'backend', 'user'"),
                        predicate: z
                            .string()
                            .min(1)
                            .describe("Attribute in snake_case, e.g. 'database', 'supported_platform'"),
                        object: z.string().min(1).describe("Value, e.g. 'PostgreSQL'"),
                        kind: z
                            .enum(["state", "set", "event"])
                            .optional()
                            .default("state")
                            .describe("'state': one value at a time, a new one ends the old (default). 'set': values coexist, retract individually. 'event': something that happened at valid_from"),
                        scope: z
                            .enum(["project", "global"])
                            .optional()
                            .default("project")
                            .describe("'project' (default) or 'global' for facts that hold in every project, such as user preferences"),
                        confidence: z
                            .number()
                            .min(0)
                            .max(1)
                            .optional()
                            .describe("Confidence 0-1 (default 1.0)"),
                        valid_from: z
                            .string()
                            .optional()
                            .describe("ISO date the fact became true (default: now). Earlier dates are backfilled into history."),
                    }),
                )
                .optional()
                .describe("Facts to store. Required when type is 'factual' or 'both'"),
            tags: z
                .array(z.string())
                .optional()
                .describe("Optional tag list (contextual)"),
            metadata: z
                .record(z.any())
                .optional()
                .describe("Arbitrary metadata blob"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Associate the memory with a specific user identifier"),
            project: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Project scope (working directory basename); applies to both tracks"),
            session_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Session identifier for grouping related memories"),
            observation_type: z
                .enum([
                    "observation",
                    "bugfix",
                    "decision",
                    "discovery",
                    "feature",
                    "gotcha",
                    "refactor",
                ])
                .optional()
                .default("observation")
                .describe("Type of observation being stored"),
        },
        async ({
            content,
            type = "contextual",
            facts,
            tags,
            metadata,
            user_id,
            project,
            session_id,
            observation_type,
        }) => {
            const u = uid(user_id);
            const proj = project ?? "default";
            const results: any = { type };

            if (
                (type === "factual" || type === "both") &&
                (!facts || facts.length === 0)
            ) {
                throw new Error(
                    `Facts array is required when type is '${type}'. Please provide at least one fact.`,
                );
            }

            const temporal: any[] = [];
            const write_facts = async (source_memory_id: string | null) => {
                for (const fact of facts ?? []) {
                    const valid_from = fact.valid_from ? new Date(fact.valid_from) : new Date();
                    const kind = (fact.kind ?? "state") as FactKind;
                    const scope = fact.scope === "global" ? null : proj;
                    const id = await insert_fact_in_transaction(
                        fact.subject,
                        fact.predicate,
                        fact.object,
                        valid_from,
                        fact.confidence ?? 1.0,
                        metadata,
                        u,
                        { project: scope, kind, source_memory_id },
                    );
                    temporal.push({
                        id,
                        subject: fact.subject,
                        predicate: fact.predicate,
                        object: fact.object,
                        kind,
                        scope: scope ?? "global",
                        valid_from: valid_from.toISOString(),
                        source_memory_id,
                    });
                }
            };

            if (type === "contextual" || type === "both") {
                const res = await add_hsg_memory(
                    content,
                    j(tags || []),
                    metadata,
                    u,
                    project,
                    session_id,
                    observation_type,
                    type === "both" ? write_facts : undefined,
                );
                results.hsg = {
                    id: res.id,
                    primary_sector: res.primary_sector,
                    sectors: res.sectors,
                    ...(res.deduplicated ? { deduplicated: true } : {}),
                };
                if (u) {
                    update_user_summary(u).catch((err) =>
                        console.error("[MCP] user summary update failed:", err),
                    );
                }
            } else {
                await transaction.run(() => write_facts(null));
            }
            if (temporal.length) results.temporal = temporal;

            const who = u ? ` [user=${u}]` : "";
            const fact_txt = `${temporal.length} fact(s): ${temporal.map((f) => `${f.subject} · ${f.predicate}: ${f.object} (${f.kind})`).join("; ")}`;
            let txt = "";
            if (type === "contextual") {
                txt = `Stored memory ${results.hsg.id} (primary=${results.hsg.primary_sector}) across sectors: ${results.hsg.sectors.join(", ")}${results.hsg.deduplicated ? " (merged with a near-duplicate)" : ""}${who}`;
            } else if (type === "factual") {
                txt = `Stored ${fact_txt}${who}`;
            } else {
                txt = `Stored memory ${results.hsg.id} and ${fact_txt}, linked to it${who}`;
            }

            return {
                content: [
                    { type: "text", text: txt },
                    {
                        type: "text",
                        text: JSON.stringify(
                            { ...results, user_id: u ?? null },
                            null,
                            2,
                        ),
                    },
                ],
            };
        },
    );

    registry.tool(
        "openmemory_retract_fact",
        "End a fact that is no longer true without replacing it, e.g. a platform no longer supported (set kind) or a removed setting. To change a state fact's value, store the new value instead.",
        {
            id: z.string().min(1).optional().describe("Fact id; or give subject + predicate (+ object)"),
            subject: z.string().min(1).optional(),
            predicate: z.string().min(1).optional(),
            object: z.string().min(1).optional().describe("Retract only this value; omit to retract every current value"),
            scope: z.enum(["project", "global"]).optional().default("project"),
            project: z.string().trim().min(1).optional().describe("Project the fact belongs to (default 'default')"),
            user_id: z.string().trim().min(1).optional(),
            at: z.string().optional().describe("ISO date it stopped being true (default: now)"),
        },
        async (args) => {
            const at = args.at ? new Date(args.at) : new Date();
            if (Number.isNaN(at.getTime())) throw new Error(`Invalid 'at' date: ${args.at}`);
            const n = await retract_fact(
                { id: args.id, subject: args.subject, predicate: args.predicate, object: args.object },
                at,
                uid(args.user_id),
                args.scope === "global" ? null : (args.project ?? "default"),
            );
            return {
                content: [{ type: "text", text: n ? `Retracted ${n} fact(s) as of ${at.toISOString()}` : "No current fact matched." }],
                ...(n ? {} : { isError: true }),
            };
        },
    );

    registry.tool(
        "openmemory_reinforce",
        "Boost salience for an existing memory",
        {
            id: z.string().min(1).describe("Memory identifier to reinforce"),
            boost: z
                .number()
                .min(0.01)
                .max(1)
                .default(0.1)
                .describe("Salience boost amount (default 0.1)"),
        },
        async ({ id, boost }) => {
            await reinforce_memory(id, boost);
            return {
                content: [
                    {
                        type: "text",
                        text: `Reinforced memory ${id} by ${boost}`,
                    },
                ],
            };
        },
    );

    registry.tool(
        "openmemory_delete",
        "Delete a memory by identifier",
        {
            id: z.string().min(1).describe("Memory identifier to delete"),
            user_id: z.string().trim().min(1).optional().describe("Validate ownership"),
        },
        async ({ id, user_id }) => {
            const u = uid(user_id);
            if (u) {
                // Pre-check ownership if user_id provided
                const mem = await q.get_mem.get(id);
                if (mem && mem.user_id !== u) {
                    throw new Error(`Memory ${id} not found for user ${u}`);
                }
            }

            const success = await delete_memory(id);
            if (!success) {
                return {
                    content: [{ type: "text", text: `Memory ${id} not found or could not be deleted.` }],
                    isError: true
                };
            }

            return {
                content: [{ type: "text", text: `Memory ${id} successfully deleted.` }],
            };
        },
    );

    registry.tool(
        "openmemory_list",
        "List recent memories for quick inspection",
        {
            limit: z
                .number()
                .int()
                .min(1)
                .max(50)
                .default(10)
                .describe("Number of memories to return"),
            sector: sec_enum.optional().describe("Optionally limit to a sector"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Restrict results to a specific user identifier"),
            project: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe("Restrict to a specific project"),
        },
        async ({ limit, sector, user_id, project }) => {
            const u = uid(user_id);
            const proj = project?.trim() || undefined;
            const rows: mem_row[] = await q.all_mem.all(limit ?? 10, 0, { user_id: u, project: proj, sector });
            const items = rows.map((row) => ({
                ...build_mem_snap(row),
                tags: p(row.tags || "[]") as string[],
                metadata: p(row.meta || "{}") as Record<string, unknown>,
            }));
            const lns = items.map(
                (item, idx) =>
                    `${idx + 1}. [${item.primary_sector}] salience=${item.salience} id=${item.id}${item.tags.length ? ` tags=${item.tags.join(", ")}` : ""}${item.user_id ? ` user=${item.user_id}` : ""}\n${item.content_preview}`,
            );
            return {
                content: [
                    {
                        type: "text",
                        text: lns.join("\n\n") || "No memories stored yet.",
                    },
                    { type: "text", text: JSON.stringify({ items }, null, 2) },
                ],
            };
        },
    );

    registry.tool(
        "openmemory_summarize",
        "Persist a summary of work completed in a session.",
        {
            session_id: z.string().min(1).describe("Session identifier"),
            user_id: z.string().trim().min(1).optional().describe("Session owner; omit for an unowned session"),
            project: z
                .string()
                .min(1)
                .describe("Project name (working directory basename)"),
            request: z.string().min(1).describe("What the user originally asked for"),
            completed: z.string().min(1).describe("What was actually completed"),
            learned: z.string().min(1).describe("Key learnings and discoveries"),
            next_steps: z.string().optional().describe("Remaining work or follow-ups"),
            files_modified: z
                .array(z.string())
                .optional()
                .describe("List of modified file paths"),
        },
        async (args) => {
            const user_id = uid(args.user_id) ?? null;
            await transaction.run(async () => {
                await q.ins_session.run(
                    args.session_id,
                    args.project,
                    Date.now(),
                    user_id,
                );
                const session = await q.get_session.get(args.session_id);
                if (session.project !== args.project || session.user_id !== user_id) {
                    throw new Error("Session belongs to a different user or project");
                }
                await q.ins_summary.run(
                    args.session_id,
                    args.project,
                    args.request,
                    args.completed,
                    args.learned,
                    args.next_steps || null,
                    args.files_modified ? JSON.stringify(args.files_modified) : null,
                    Date.now(),
                );
            });
            return {
                content: [
                    {
                        type: "text",
                        text: `Session summary saved for project "${args.project}"`,
                    },
                ],
            };
        },
    );

    registry.tool(
        "openmemory_timeline",
        "Get surrounding observations around an anchor memory for chronological context.",
        {
            memory_id: z.string().min(1).describe("Anchor memory ID"),
            user_id: z.string().trim().min(1).optional().describe("Restrict the anchor and surrounding memories to this user"),
            depth_before: z
                .number()
                .int()
                .min(0)
                .max(50)
                .default(3)
                .describe("Number of memories before the anchor"),
            depth_after: z
                .number()
                .int()
                .min(0)
                .max(50)
                .default(7)
                .describe("Number of memories after the anchor"),
        },
        async (args) => {
            const user_id = uid(args.user_id);
            const anchor = await q.get_mem.get(args.memory_id);
            if (!anchor || (user_id && anchor.user_id !== user_id)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Memory ${args.memory_id} not found`,
                        },
                    ],
                    isError: true,
                };
            }

            const project = (anchor as any).project || "default";
            const created = Number((anchor as any).created_at || 0);

            const scope = user_id ? " and user_id=?" : "";
            const params = user_id ? [project, created, user_id] : [project, created];
            const before = await all_async(
                `select * from ${memories_table} where project=? and created_at<?${scope} order by created_at desc,id desc limit ?`,
                [...params, args.depth_before],
            );
            const after = await all_async(
                `select * from ${memories_table} where project=? and created_at>?${scope} order by created_at asc,id asc limit ?`,
                [...params, args.depth_after],
            );

            const timeline = [...before.reverse(), anchor, ...after];
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ timeline }, null, 2),
                    },
                ],
            };
        },
    );

    registry.tool(
        "openmemory_get",
        "Fetch a single memory by identifier",
        {
            id: z.string().min(1).describe("Memory identifier to load"),
            include_vectors: z
                .boolean()
                .default(false)
                .describe("Include sector vector metadata"),
            user_id: z
                .string()
                .trim()
                .min(1)
                .optional()
                .describe(
                    "Validate ownership against a specific user identifier",
                ),
        },
        async ({ id, include_vectors, user_id }) => {
            const u = uid(user_id);
            const mem = await q.get_mem.get(id);
            if (!mem)
                return {
                    content: [
                        { type: "text", text: `Memory ${id} not found.` },
                    ],
                };
            if (u && mem.user_id !== u)
                return {
                    content: [
                        {
                            type: "text",
                            text: `Memory ${id} not found for user ${u}.`,
                        },
                    ],
                };
            const vecs = include_vectors
                ? await vector_store.getVectorsById(id)
                : [];
            const pay = {
                id: mem.id,
                content: mem.content,
                primary_sector: mem.primary_sector,
                salience: mem.salience,
                decay_lambda: mem.decay_lambda,
                created_at: mem.created_at,
                updated_at: mem.updated_at,
                last_seen_at: mem.last_seen_at,
                user_id: mem.user_id,
                tags: p(mem.tags || "[]"),
                metadata: p(mem.meta || "{}"),
                sectors: include_vectors
                    ? vecs.map((v) => v.sector)
                    : undefined,
            };
            return {
                content: [{ type: "text", text: JSON.stringify(pay, null, 2) }],
            };
        },
    );
    registry.tool(
        "openmemory_consolidate",
        "Check if a project's memories need consolidation and return the lowest-value candidates for merging. Call this periodically to prevent memory bloat. The agent should review the candidates, synthesize them into fewer high-quality memories via openmemory_store, then delete the originals via openmemory_delete.",
        {
            project: z.string().trim().min(1).describe("Project to check for consolidation"),
            user_id: z.string().trim().min(1).optional().describe("Restrict counts and candidates to this user; omit for the whole project"),
            threshold: z
                .number()
                .int()
                .min(10)
                .max(500)
                .default(50)
                .describe("Consolidation triggers when memory count exceeds this (default 50)"),
            candidate_count: z
                .number()
                .int()
                .min(5)
                .max(30)
                .default(10)
                .describe("Number of lowest-salience candidates to return (default 10)"),
        },
        async (args) => {
            const user_id = uid(args.user_id);
            const scope = `project=?${user_id ? " and user_id=?" : ""}`;
            const params = user_id ? [args.project, user_id] : [args.project];
            const count_rows = await all_async(`select count(*) as c from ${memories_table} where ${scope}`, params);
            const total = Number(count_rows[0]?.c ?? 0);

            if (total <= (args.threshold ?? 50)) {
                return {
                    content: [{
                        type: "text",
                        text: JSON.stringify({
                            needs_consolidation: false,
                            total_memories: total,
                            threshold: args.threshold ?? 50,
                            message: `Project "${args.project}" has ${total} memories (threshold: ${args.threshold ?? 50}). No consolidation needed.`,
                        }, null, 2),
                    }],
                };
            }

            const candidates = await all_async(
                `select id,content,observation_type,primary_sector,salience,tags,meta,created_at from ${memories_table} where ${scope} order by salience asc,created_at asc,id asc limit ?`,
                [...params, args.candidate_count ?? 10],
            );

            const formatted = candidates.map((c: any) => ({
                id: c.id,
                content: c.content,
                observation_type: c.observation_type,
                primary_sector: c.primary_sector,
                salience: c.salience,
                tags: p(c.tags || "[]"),
                metadata: p(c.meta || "{}"),
                created_at: c.created_at,
            }));

            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({
                        needs_consolidation: true,
                        total_memories: total,
                        threshold: args.threshold ?? 50,
                        excess: total - (args.threshold ?? 50),
                        candidates: formatted,
                        instructions: "Review these low-salience memories. Synthesize related ones into fewer, higher-quality memories using openmemory_store, then delete the originals using openmemory_delete. Preserve important facts and decisions; discard redundant or outdated observations.",
                    }, null, 2),
                }],
            };
        },
    );

    // Self-teaching: embeds the usage protocol and stats in the response.
    registry.tool(
        "openmemory_status",
        "Get memory system status, statistics, and usage protocol. Call this on wake-up to learn how to use the memory system.",
        {},
        async () => {
            const total_rows = await all_async(
                `select count(*) as c from ${memories_table}`,
            );
            const total = total_rows?.[0]?.c ?? 0;

            const by_sector = await all_async(
                `select primary_sector as sector, count(*) as count, round(avg(salience), 3) as avg_salience from ${memories_table} group by primary_sector order by count desc`,
            );

            const by_project = await all_async(
                `select project, count(*) as count from ${memories_table} group by project order by count desc limit 20`,
            );

            const by_type = await all_async(
                `select observation_type as type, count(*) as count from ${memories_table} group by observation_type order by count desc`,
            );

            const summary_count = await all_async(
                `select count(*) as c from ${summaries_table}`,
            );

            const session_count = await all_async(
                `select count(*) as c from ${sessions_table}`,
            );

            const protocol = `MEMORY PROTOCOL:
1. SESSION START: Call openmemory_wakeup(project) once. It returns current facts, the most important observations and recent session summaries.
2. DURING WORK: After meaningful steps, call openmemory_store with content (self-contained, written for a future agent), project, session_id and observation_type (observation|bugfix|decision|discovery|feature|gotcha|refactor). Store WHY, not just what.
3. FACTS: When the work establishes or changes something that is simply true now (the project's database, a confirmed setting, a user preference), use type 'both' and add facts. kind 'state' = one value at a time (a new value ends the old); 'set' = values that coexist (supported platforms); 'event' = something that happened. scope 'global' for facts that hold in every project. Use openmemory_retract_fact when something stops being true without a replacement.
4. SEARCH: openmemory_query(query, project) before answering questions about past work. type 'factual' for what is true now (or 'at' a date); 'unified' for both. Results marked HISTORICAL describe a state that has since changed.
5. SESSION END: Call openmemory_summarize with session_id, project, request, completed, learned, next_steps, files_modified.
6. NEVER GUESS about past work; search first.
7. CONSOLIDATION: When wakeup shows many memories, call openmemory_consolidate(project) and merge low-value ones.`;

            const pay = {
                total_memories: Number(total),
                total_summaries: Number(summary_count?.[0]?.c ?? 0),
                total_sessions: Number(session_count?.[0]?.c ?? 0),
                by_sector,
                by_project,
                by_observation_type: by_type,
                embeddings: getEmbeddingInfo(),
                protocol,
                available_tools: registry.names(),
            };

            return {
                content: [{ type: "text", text: JSON.stringify(pay, null, 2) }],
            };
        },
    );

    // ── openmemory_wakeup (4-layer: L0 identity + L1 top-N essential story) ──
    registry.tool(
        "openmemory_wakeup",
        "Load compressed project context for session start. Returns identity + top memories + recent summaries in a single call (~200 tokens). Call this ONCE at the beginning of every session.",
        {
            user_id: z.string().trim().min(1).optional().describe("Restrict memories and summaries to this user; omit for project-wide context"),
            project: z
                .string()
                .trim()
                .min(1)
                .describe("Project name (working directory basename). Use 'home' for home directory."),
            limit: z
                .number()
                .int()
                .min(1)
                .max(50)
                .default(15)
                .describe("Max memories to include in essential story (default 15)"),
        },
        async (args: { project: string; limit?: number; user_id?: string }) => {
            const limit = args.limit ?? 15;
            const user_id = uid(args.user_id);
            const max_chars = 3200;

            // L0: Identity (static, optional)
            let identity = "";
            // ~/.openmemory-enhanced is the pre-rename location.
            for (const dir of [".openmem", ".openmemory-enhanced"]) {
                try {
                    identity = fs.readFileSync(path.join(os.homedir(), dir, "identity.txt"), "utf-8").trim();
                    break;
                } catch { /* optional */ }
            }

            // L1: Top-N memories by salience, project-scoped
            const top_memories = await all_async(
                `select id, content, observation_type, primary_sector, salience, project from ${memories_table} where project=?${user_id ? " and user_id=?" : ""} order by salience desc, created_at desc limit ?`,
                user_id ? [args.project, user_id, limit] : [args.project, limit],
            );

            // Group by observation_type, truncate to budget
            const grouped: Record<string, string[]> = {};
            let chars = 0;
            for (const m of top_memories) {
                if (chars >= max_chars) break;
                const typ = m.observation_type || "observation";
                if (!grouped[typ]) grouped[typ] = [];
                const line = trunc(m.content.replace(/\s+/g, " ").trim(), 200);
                grouped[typ].push(line);
                chars += line.length;
            }

            let essential_story = "";
            for (const [typ, lines] of Object.entries(grouped)) {
                essential_story += `[${typ.toUpperCase()}]\n`;
                for (const line of lines) {
                    essential_story += `- ${line}\n`;
                }
                essential_story += "\n";
            }

            // L0.5: Current facts (state + set) for the project and global scope.
            const current_facts = await query_facts_at_time(
                undefined, undefined, undefined, new Date(), 0.1, user_id,
                { project: args.project, kinds: ["state", "set"], limit: 20 },
            );
            const facts_text = current_facts
                .map((f) => `- ${fact_line(f)}${f.project ? "" : " (global)"}`)
                .join("\n");

            // L1.5: Recent summaries
            const recent_summaries = await q.get_summaries_by_project.all(
                args.project, 3, user_id,
            );

            let summary_text = "";
            for (const s of recent_summaries) {
                summary_text += `Session: ${s.request || "?"}\n`;
                summary_text += `  Done: ${trunc(s.completed || "", 150)}\n`;
                if (s.learned) summary_text += `  Learned: ${trunc(s.learned, 100)}\n`;
                if (s.next_steps) summary_text += `  Next: ${trunc(s.next_steps, 100)}\n`;
                summary_text += "\n";
            }

            const sections: string[] = [];
            if (identity) sections.push(`## Identity\n${identity}`);
            if (facts_text) sections.push(`## Current Facts (${current_facts.length})\n${facts_text}`);
            if (essential_story.trim()) sections.push(`## Essential Context (${top_memories.length} memories)\n${essential_story.trim()}`);
            if (summary_text.trim()) sections.push(`## Recent Sessions (${recent_summaries.length})\n${summary_text.trim()}`);

            if (sections.length === 0) {
                return {
                    content: [{ type: "text", text: `No memories found for project "${args.project}". This appears to be a new project.` }],
                };
            }

            return {
                content: [{ type: "text", text: sections.join("\n\n") }],
            };
        },
    );

    registry.apply(srv);

    srv.resource(
        "openmemory-config",
        "openmemory://config",
        {
            mimeType: "application/json",
            description:
                "Runtime configuration snapshot for the OpenMemory MCP server",
        },
        async () => {
            const stats = await all_async(
                `select primary_sector as sector, count(*) as count, avg(salience) as avg_salience from ${memories_table} group by primary_sector`,
            );
            const pay = {
                mode: env.mode,
                sectors: sector_configs,
                stats,
                embeddings: getEmbeddingInfo(),
                server: { version: SERVER_VERSION, protocol: "2025-06-18" },
                available_tools: registry.names(),
            };
            return {
                contents: [
                    {
                        uri: "openmemory://config",
                        text: JSON.stringify(pay, null, 2),
                    },
                ],
            };
        },
    );

    srv.server.oninitialized = () => {

        console.error(
            "[MCP] initialization completed with client:",
            srv.server.getClientVersion(),
        );
    };
    return srv;
};

const extract_pay = async (req: IncomingMessage & { body?: any }) => {
    if (req.body !== undefined) {
        if (typeof req.body === "string") {
            if (!req.body.trim()) return undefined;
            return JSON.parse(req.body);
        }
        if (typeof req.body === "object" && req.body !== null) return req.body;
        return undefined;
    }
    const raw = await new Promise<string>((resolve, reject) => {
        let buf = "";
        req.on("data", (chunk) => {
            buf += chunk;
        });
        req.on("end", () => resolve(buf));
        req.on("error", reject);
    });
    if (!raw.trim()) return undefined;
    return JSON.parse(raw);
};

export const mcp = (app: any) => {
    const handle_req = async (req: any, res: any) => {
        try {
            const pay = await extract_pay(req);
            if (!pay || typeof pay !== "object") {
                send_err(res, -32600, "Request body must be a JSON object");
                return;
            }
            console.error("[MCP] Incoming request:", JSON.stringify(pay));
            set_hdrs(res);

            // Create a fresh transport + server per request to support
            // multiple clients (MCP SDK 1.27 rejects re-initialization
            // on a single transport instance).
            const srv = create_mcp_srv();
            const trans = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true,
            });
            await srv.connect(trans);
            await trans.handleRequest(req, res, pay);
        } catch (error) {
            console.error("[MCP] Error handling request:", error);
            if (error instanceof SyntaxError) {
                send_err(res, -32600, "Invalid JSON payload");
                return;
            }
            if (!res.headersSent)
                send_err(
                    res,
                    -32603,
                    "Internal server error",
                    (error as any)?.id ?? null,
                    500,
                );
        }
    };

    app.post("/mcp", (req: any, res: any) => {
        void handle_req(req, res);
    });
    app.options("/mcp", (_req: any, res: any) => {
        res.statusCode = 204;
        set_hdrs(res);
        res.end();
    });

    const method_not_allowed = (_req: IncomingMessage, res: ServerResponse) => {
        send_err(
            res,
            -32600,
            "Method not supported. Use POST  /mcp with JSON payload.",
            null,
            405,
        );
    };
    app.get("/mcp", method_not_allowed);
    app.delete("/mcp", method_not_allowed);
    app.put("/mcp", method_not_allowed);
};

export const start_mcp_stdio = async () => {
    const srv = create_mcp_srv();
    const trans = new StdioServerTransport();
    await srv.connect(trans);

};

if (typeof require !== "undefined" && require.main === module) {
    void start_mcp_stdio().catch((error) => {
        console.error("[MCP] STDIO startup failed:", error);
        process.exitCode = 1;
    });
}
