# Architecture

OpenMem is a single TypeScript package. Its main entry point is an MCP server
(`src/ai/mcp.ts`) that coding agents talk to over stdio. An optional HTTP API
(`src/server/`) exposes the same engine over REST and `POST /mcp`.

```
agent ──stdio──▶ src/ai/mcp.ts ─┐
                                ├─▶ src/memory/hsg.ts ──▶ src/core/db.ts ──▶ SQLite / Postgres
HTTP  ──REST───▶ src/server/  ──┘          │                    │
                                           ▼                    ▼
                                  src/memory/embed.ts   src/core/vector/* (SQL or Valkey)
```

## Source layout

| Path | Role |
|---|---|
| `src/ai/mcp.ts` | MCP tools (`openmemory_*`), the wake-up/consolidation logic and the usage protocol |
| `src/ai/mcp_tools.ts` | Tool registry: zod schemas → JSON Schema, argument validation, error wrapping |
| `src/memory/hsg.ts` | Memory engine: classification, dedup, write path, hybrid retrieval, waypoint graph |
| `src/memory/embed.ts` | Embedding providers, tiers, batching, fallback to synthetic |
| `src/memory/decay.ts` | Salience decay and the compressed-vector cache |
| `src/core/db.ts` | Schema bootstrap, query catalogue (`q`), transactions, backend selection |
| `src/core/schema_migrations.ts` | Numbered, atomic schema migrations (`_om_migrations`) |
| `src/core/vector/` | Vector stores: SQL (SQLite blobs or pgvector) and Valkey |
| `src/temporal_graph/` | Time-bounded subject–predicate–object facts |
| `src/server/` | Optional HTTP API, auth middleware, background jobs |
| `src/ops/`, `src/sources/` | Document ingestion and external source connectors (HTTP API only) |
| `tests/` | Offline suites; `tests/run.cjs` runs them against in-memory SQLite |

## Data model

Every memory row carries its **scope** and **session context**:

| Column | Meaning |
|---|---|
| `user_id` | Owner (`anonymous` when omitted) |
| `project` | Project scope, normally the working directory basename (`default` when omitted) |
| `session_id` | Conversation that produced it |
| `observation_type` | `observation`, `bugfix`, `decision`, `discovery`, `feature`, `gotcha`, `refactor` |
| `primary_sector` | One of five sectors (below), which sets the decay rate |
| `salience` | 0–1 importance; reinforced on recall, decays over time |
| `simhash` | 64-bit fingerprint for near-duplicate detection |
| `mean_vec` | Weighted mean of the memory's sector vectors, used for graph links |

Related tables:

- `vectors`: one row per memory per sector, plus the embedding's provenance (provider, model, dimension).
- `memories_fts`: FTS5 index over content. On Postgres this is a GIN `tsvector` index instead.
- `waypoints`: weighted associative edges between memories.
- `sessions` and `summaries`: session lifecycle and end-of-session summaries.
- `document_sections`: links an ingested document's root memory to its section memories.
- `temporal_facts` and `temporal_edges`: time-bounded facts.

### Sectors

Content is classified by pattern into a primary sector plus any additional
matches. The memory is embedded once per matched sector.

| Sector | Typical content | Decay λ |
|---|---|---|
| episodic | events, "yesterday we…" | 0.015 |
| semantic | facts, definitions | 0.005 |
| procedural | how-to, steps | 0.008 |
| emotional | preferences, feelings | 0.020 |
| reflective | lessons, insights | 0.001 |

## Write path (`add_hsg_memory`)

1. Compute SimHash, chunk long content and classify sectors.
2. Inside one transaction:
   - If a memory with the same user, project and a near-identical SimHash
     (Hamming ≤ 3) exists, boost its salience and return it instead of
     inserting.
   - Insert the row, embed each sector and store the vectors.
   - Store `mean_vec` and link the memory to its most similar neighbour in the
     same scope with a waypoint.

Embedding runs inside the transaction so that a failed embedding leaves no
partial memory. With a remote provider, that holds the SQLite write gate for
the duration of the API call.

## Read path (`hsg_query`)

1. **Vector candidates.** Embed the query for each sector and run a
   similarity search, filtered by user and project *before* top-k.
2. **Lexical candidates.** The query is tokenised into plain terms (so FTS
   syntax can't be injected). Matches come from FTS5 bm25 or Postgres
   `ts_rank`, scoped the same way and rank-normalised.
3. **Graph expansion.** If the vector matches are weak, follow waypoints
   whose endpoints share the same user and project.
4. **Scoring.** Every candidate gets one score in `[0, 1)`:
   `tanh(Σ w·signal)`. The signals are best sector similarity (penalised
   across unrelated sectors), token overlap, tag match, lexical rank,
   waypoint weight, recency, and keyword boost (hybrid tier).
5. **Feedback.** Returned memories are reinforced and their co-activation is
   recorded; a background loop turns co-activations into waypoint weight.

Scope is a data boundary, not authentication. Unscoped calls search everything.

## Embedding tiers (`OM_TIER`)

| Tier | Vectors |
|---|---|
| `hybrid` (default), `fast` | Synthetic: deterministic hashed token features, no network |
| `smart` | Synthetic vector fused with a compressed (128-d) semantic embedding |
| `deep` | Provider embeddings only (`OM_EMBEDDINGS`: openai, gemini, ollama, aws) |

If a provider fails, the next one in `OM_EMBEDDING_FALLBACK` is tried, with
synthetic as the final fallback. Vectors of a different dimension are
skipped at query time.

## Lifecycle

- **Wake-up** (`openmemory_wakeup`): an optional `~/.openmem/identity.txt`,
  then the top memories by salience in the project grouped by observation
  type (capped at ~3 200 chars), then the last three session summaries.
- **Summaries** (`openmemory_summarize`): the first summary for a session fixes
  that session's project and owner. Later summaries must match both.
- **Consolidation** (`openmemory_consolidate`): reports low-salience candidates
  once a project passes a threshold. The agent merges and deletes them; the
  server never deletes on its own.
- **Decay**: salience decays by sector rate. Cold memories get a compressed
  vector cache, but their search vectors are never replaced. Decay, reflection
  and user-summary jobs run on timers in the HTTP server process only. The
  stdio MCP server applies decay lazily when it scores a memory.

## Storage backends

| Setting | Metadata | Vectors |
|---|---|---|
| default | SQLite (WAL), single connection, queries serialised through one gate | SQLite blobs, exact cosine |
| `OM_METADATA_BACKEND=postgres` | Postgres; a transaction gets its own pooled connection | pgvector, exact search (mixed dimensions, so no ANN index) |
| `OM_VECTOR_BACKEND=valkey` | either | Valkey; scoped searches resolve eligible IDs from metadata first |

Transactions use `transaction.run(async () => …)` with async-context
propagation. Nested transactions are rejected.

## Testing

`npm test` runs every suite offline against in-memory SQLite with synthetic
embeddings. Postgres transaction and migration suites are mock-based. The
`*_integration.ts` suites need a disposable local server and are not part of
the default run.
