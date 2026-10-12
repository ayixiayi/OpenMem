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
| `src/temporal_graph/` | Fact track: scoped, typed, time-bounded subject–predicate–object facts |
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
- `temporal_facts`: the fact track (below). `temporal_edges` is used by the HTTP API only.

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
   - If a memory with the same user and project has a near-identical SimHash
     (Hamming ≤ 3) *and* a token-set Jaccard ≥ 0.8, boost its salience and
     return it instead of inserting. Text with no tokens only matches an
     identical text.
   - Insert the row, embed each sector and store the vectors.
   - Store `mean_vec` and link the memory to its most similar neighbour in the
     same scope with a waypoint.

An optional `within(memory_id)` callback runs in the same transaction; the
MCP `both` store uses it to write facts atomically with the observation.

Tokenisation keeps ASCII words as before and splits CJK runs into overlapping
character bigrams, so Chinese, Japanese and Korean text gets real tokens for
SimHash, synthetic vectors and overlap scoring.

Embedding runs inside the transaction so that a failed embedding leaves no
partial memory. With a remote provider, that holds the SQLite write gate for
the duration of the API call.

## Read path (`hsg_query`)

1. **Vector candidates.** Embed the query for each sector and run a
   similarity search, filtered by user and project *before* top-k. Only
   stored vectors in the query's embedding space are compared (same
   provider, model, transform and dimension; chunk averages count as their
   source's space). Legacy vectors without provenance are still compared.
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
synthetic as the final fallback. Each vector records its provenance, so a
memory embedded by a fallback model is excluded from vector search for queries
embedded by a different model. It is still found through full-text search.
Unscoped Valkey searches (`FT.SEARCH` and its scan fallback) do not filter by
space yet; scoped Valkey searches do.

Synthetic vectors are hashed word, character-n-gram and word-sequence
features. They match repeated vocabulary and identifiers well and have no
learned notion of paraphrase.

## Fact track (`src/temporal_graph/`)

A fact is `subject · predicate: object`, valid from `valid_from` until
`valid_to` (open-ended while current). Each fact carries:

| Field | Meaning |
|---|---|
| `user_id`, `project` | Scope. `project = NULL` is a global fact (e.g. a user preference). |
| `kind` | `state`, `set` or `event` (below) |
| `source_memory_id` | The observation it was extracted from, if any |

Identity is user + project + subject + predicate + object + `valid_from`.
Subjects are lower-cased and predicates become snake_case on write.

**Update rules** (`insert_fact_in_transaction`), keyed by user + project +
subject + predicate:

- `state`: one value at a time.
  - Re-asserting the value that already holds at that time reuses the
    existing fact.
  - A new value ends the previous one at `valid_from − 1`.
  - A backfilled older value ends where the next known value begins, so it
    never becomes current.
  - A different value with the *same* `valid_from` is a correction. The
    mistaken row is kept with an empty interval (`valid_to < valid_from`) and
    is never returned as valid.
- `set`: values coexist. A value already held is reused. Values end only
  through `retract_fact`.
- `event`: an instant (`valid_to = valid_from`). Never replaces anything and
  never appears as current state.

**Reads.**

- `query_facts_at_time` returns facts valid at a point in time. A project
  filter returns that project's facts plus global ones.
- The MCP `factual` query uses exact `fact_pattern` fields when given.
  Otherwise it matches the query's words and CJK bigrams against subject,
  predicate and object, capped by `fact_limit`.
- `wakeup` lists up to 20 current `state`/`set` facts.

**Linking the tracks.**

- `openmemory_store` with `type: "both"` writes the observation and its
  facts in one transaction, setting `source_memory_id`.
- Contextual query results carry `linked_facts` with a status: `current`,
  `ended`, `corrected` or `event`.
- An ended state fact also carries the value that replaced it, and the text
  output marks the hit HISTORICAL. The observation's reasoning stays
  searchable while its state is clearly superseded.
- Deleting an observation keeps its facts and clears the link.

## Lifecycle

- **Wake-up** (`openmemory_wakeup`): an optional `~/.openmem/identity.txt`,
  then up to 20 current facts (project + global), then the top memories by
  salience in the project grouped by observation type (capped at ~3 200
  chars), then the last three session summaries.
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
