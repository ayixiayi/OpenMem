# OpenMem

**English** | [简体中文](README.zh-CN.md)

Long-term memory for **AI coding agents**, served over MCP. Your agent starts
every session already knowing what it did, decided and learned in this project
last time, without you repeating it.

- **One call to wake up.** `openmemory_wakeup(project)` returns the project's
  current facts, its most important memories grouped by type, and the last few
  session summaries, in a compact block.
- **Two tracks: why, and what's true now.** *Observations* keep the reasoning,
  failed attempts and gotchas. *Facts* (`backend · database: PostgreSQL`) keep
  the state, each with the time it became true. Storing both at once links
  them. When a fact changes, the old observation is still recalled for its
  reasoning but labelled **HISTORICAL** with the value that replaced it.
- **Scoped by project and user.** Every memory, session and summary carries a
  `project`. Filters apply *before* ranking in vector, full-text and graph
  retrieval, so one repository's memories never crowd out or leak into another's.
- **Hybrid recall that finds identifiers.** Embedding similarity, SQLite FTS5 /
  Postgres full-text matches and associative waypoints are fused into one score.
  An exact `ECONNRESET`, file name or config key is recalled even when the
  embedding misses it.
- **Offline by default.** SQLite plus built-in synthetic embeddings: no API key,
  no external service. Synthetic embeddings are hashed word and character
  features (CJK as character bigrams). They are strong at matching the same
  words and identifiers again, but they don't understand paraphrases. For
  that, switch to OpenAI, Gemini, Ollama or AWS embeddings with environment
  variables. Vectors from different models are never compared with each other.
- **A protocol, not just tools.** [`SKILL.md`](SKILL.md)
  tells the agent when to wake up, what to store, when to search and how to
  close a session.

## MCP tools

| Tool | Purpose |
|---|---|
| `openmemory_wakeup` | Session start: current facts + top memories by type + recent session summaries for a project |
| `openmemory_store` | Save an observation and/or facts. `type: "both"` stores them atomically and links them |
| `openmemory_query` | Scoped hybrid search over observations; `factual` for what is true now or at a date; `unified` for both |
| `openmemory_retract_fact` | End a fact that is no longer true without a replacement |
| `openmemory_summarize` | Save a session summary: request, completed, learned, next steps, files |
| `openmemory_timeline` | Memories before and after an anchor memory, in order |
| `openmemory_consolidate` | Report whether a project needs consolidation and return low-value candidates |
| `openmemory_list` | Recent memories, filtered by project, user and sector |
| `openmemory_get` | One memory in full |
| `openmemory_reinforce` | Boost a memory's salience |
| `openmemory_delete` | Delete a memory |
| `openmemory_status` | Counts by project/type/sector, embedding config and the usage protocol |

Observation types: `observation`, `bugfix`, `decision`, `discovery`, `feature`,
`gotcha`, `refactor`.

Fact kinds decide how a new value is applied:

- `state` (one value at a time) ends the previous value.
- `set` (values that coexist, such as supported platforms) adds alongside the others.
- `event` (deploys, outages) is recorded as an instant.

Facts belong to a project, or to the global scope for things like user
preferences. Older values can be backfilled into history.

## Setup

Requires Node.js 20+.

```bash
git clone https://github.com/ayixiayi/OpenMem.git
cd OpenMem
npm install
npm run build
```

Register the stdio server with your agent.

**Claude Code**

```bash
claude mcp add openmem -- node /path/to/OpenMem/dist/ai/mcp.js
```

**opencode** (`~/.config/opencode/opencode.json`)

```json
{
  "mcp": {
    "openmem": {
      "type": "local",
      "command": ["node", "/path/to/OpenMem/dist/ai/mcp.js"],
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

Then give the agent the protocol: copy [`SKILL.md`](SKILL.md) into its skills
directory (for Claude Code, `~/.claude/skills/openmem/SKILL.md`), or paste it
into your agent instructions.

Optional: put a few lines about yourself or your conventions in
`~/.openmem/identity.txt`; wakeup prepends them.

## How a session looks

```
Session 1 — project "api"
  → openmemory_wakeup("api")                                  ← "new project"
  → openmemory_store(type: "both", project: "api", observation_type: "decision",
       content: "Chose SQLite: single writer, no server to run.",
       facts: [{ subject: "backend", predicate: "database", object: "SQLite" }])
  → openmemory_summarize(project: "api", completed: "storage layer", …)

Session 7 — workers now write concurrently
  → openmemory_store(type: "both", project: "api", observation_type: "decision",
       content: "Moved to PostgreSQL: concurrent workers hit SQLITE_BUSY under load.",
       facts: [{ subject: "backend", predicate: "database", object: "PostgreSQL" }])

Session 8 — new conversation
  → openmemory_wakeup("api")
  ← ## Current Facts (1)
    - backend · database: PostgreSQL
    ## Essential Context (2 memories)
    [DECISION]
    - Moved to PostgreSQL: concurrent workers hit SQLITE_BUSY under load.
    - Chose SQLite: single writer, no server to run.
  → openmemory_query("why SQLite?", project: "api")
  ← 1. [semantic] score=0.93 salience=0.40 id=…
    Chose SQLite: single writer, no server to run.
       ↳ HISTORICAL: backend · database: SQLite — now PostgreSQL (since 2026-…)
```

## Retrieval pipeline

1. The query is embedded per memory sector and searched within the
   user/project scope.
2. Full-text search (FTS5 BM25 on SQLite, `tsvector` + GIN on Postgres) adds
   scoped lexical candidates; the query is tokenised first, so punctuation and
   operators are safe.
3. Low-confidence result sets are expanded along same-scope waypoint edges.
4. Each candidate gets one score in `[0, 1)` from vector similarity, token and
   tag overlap, full-text rank, waypoint weight and recency. `min_score`
   thresholds therefore mean the same thing for every query.
5. Recalled memories are reinforced; unused ones decay by sector-specific rates.

## Configuration

All settings are environment variables; none are required.

| Variable | Default | Description |
|---|---|---|
| `OM_DB_PATH` | `data/openmemory.sqlite` (in the repo) | SQLite database file |
| `OM_EMBEDDINGS` | `synthetic` | `synthetic`, `openai`, `gemini`, `ollama`, `aws` |
| `OPENAI_API_KEY` | — | Needed for `OM_EMBEDDINGS=openai` |
| `OM_TIER` | `hybrid` | `hybrid` / `fast` (synthetic), `smart` (synthetic + compressed semantic), `deep` (semantic) |
| `OM_METADATA_BACKEND` | `sqlite` | `sqlite` or `postgres` (`OM_PG_HOST`, `OM_PG_DB`, …) |
| `OM_VECTOR_BACKEND` | follows metadata | `valkey` to keep vectors in Valkey/Redis |

See [`.env.example`](.env.example) for the full list. Schema upgrades run
automatically on startup; see [MIGRATION.md](MIGRATION.md) before upgrading an
existing database.

## Development

```bash
npx tsc --noEmit
npm test          # offline: in-memory SQLite + synthetic embeddings
```

`npm start` runs the optional HTTP API (port `OM_PORT`, default 8080), which
also serves MCP at `POST /mcp`. The package can be used as a library too:

```typescript
import { Memory } from "openmem-mcp";

const mem = new Memory("user-123");
await mem.add("Chose JWT over server sessions", { project: "my-app", tags: ["auth"] });
const hits = await mem.search("auth decision", { project: "my-app", limit: 5 });
```

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE).
