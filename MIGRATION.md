# Upgrading

Back up your database before upgrading: copy `openmemory.sqlite` while the server
is stopped, or use `pg_dump`. All schema changes below run automatically and
atomically on startup. A failed migration rolls back completely; fix the cause
and restart. To revert, restore the backup together with the previous release.
Deleting rows from `_om_migrations` does not undo a migration.

## Automatic schema migrations (`_om_migrations`)

| Version | SQLite | PostgreSQL |
|---|---|---|
| 1 | Temporal facts become unique per `user_id` (partial unique indexes for owned/unowned facts). Adds `document_sections`, backfilled only from unambiguous legacy `meta.parent_id`/`section_index` pairs that share user and project. | Same. |
| 2 | Adds nullable `vectors.provenance` (embedding provider/model/dimension). Existing vectors keep `NULL`. | Same. |
| 3 | Rebuilds `memories_fts` (rows written before the index existed were never searchable) and limits the FTS update trigger to `content` changes. | Adds a GIN full-text index on memory content (created on startup). |
| 4 | Adds `temporal_facts.project` (NULL = global), `kind` (`state` / `set` / `event`, default `state`) and `source_memory_id`. Fact identity becomes user + project + subject + predicate + object + `valid_from`. Existing facts become global `state` facts with no source. | Same. |

The SQLite temporal rebuild only accepts the stock `temporal_facts` definition;
a manually altered table aborts the migration instead of silently dropping
columns.

## Behaviour changes worth knowing

### Fact track (migration 4)

- **Facts are project-scoped.** `openmemory_store` writes facts into the call's
  `project` (default `default`), or into the global scope with
  `scope: "global"`. A project query returns that project's facts plus global
  ones. A fact in one project no longer ends a fact with the same
  subject/predicate in another project. Facts written before this release
  are global and therefore visible in every project; re-store them with a
  `project` if they are project-specific.
- **Update rules depend on `kind`.** `state` ends the previous value. A
  backfilled older value is fitted into history without becoming current, and a
  different value for the same start time is treated as a correction (the old
  row is kept with an empty interval). `set` values coexist until retracted
  with `openmemory_retract_fact`. `event` facts are instants and never replace
  anything. Re-asserting a value that already holds reuses the existing fact.
- **Subjects and predicates are normalised** on write and in exact-match
  queries: subjects are lower-cased with whitespace collapsed, and predicates
  become lower snake_case. Objects keep their case. Older rows keep their
  original spelling; natural-language fact queries match them
  case-insensitively.
- **`type: "both"` is one transaction** and links each fact to the stored
  observation (`source_memory_id`). If any fact is invalid, the observation is
  not stored either. Deleting the observation keeps its facts and clears the
  link.
- **Queries.** `factual` queries without a `fact_pattern` match the query text
  against subject, predicate and object, and return at most `fact_limit`
  (default 20). Contextual results include `linked_facts`. If a linked state
  fact has ended, the result is marked HISTORICAL with what replaced it.
- **Wakeup** starts with up to 20 current `state`/`set` facts for the project
  and global scope.

### Other changes in this release

- **CJK text.** Chinese, Japanese and Korean runs are tokenised into character
  bigrams. Previously such text produced no tokens, so every pure-CJK memory
  after the first was merged into it as a "duplicate" and shared one synthetic
  vector. English-only text tokenises exactly as before. CJK memories stored
  earlier keep their old, uninformative vectors; re-store important ones.
- **Deduplication** now requires real token overlap (Jaccard ≥ 0.8) on top of a
  SimHash match. Text with no tokens is only merged when it is identical.
- **Embedding spaces are isolated.** Vector search and fusion scoring skip
  stored vectors whose provenance (provider, model, transform, dimension)
  differs from the query's, even when the dimensions match. A provider switch
  or a fallback to synthetic embeddings therefore no longer produces
  meaningless similarities. Those memories remain reachable through
  full-text search. Legacy vectors without provenance are still compared.
- **Postgres fixes:** a waypoint-expanded query no longer fails on a hardcoded
  SQLite table name, and the temporal module no longer writes logs to stdout,
  which would corrupt the MCP stdio stream.

**Scope is a data boundary, not authentication.** `user_id` and `project` are
caller-supplied filters. They are applied *before* ranking in vector, full-text
and graph retrieval, so results from other scopes can no longer crowd out or
leak into scoped queries. Waypoint edges are only created, followed or
reinforced between memories that share both user and project; historical
cross-scope edges stay stored but are ignored. Unscoped calls still see every
scope. The optional `OM_API_KEY` is a single shared key.

**Deduplication** (SimHash) only merges memories with the same user and project.
Memories lost to earlier cross-scope merges cannot be reconstructed.

**Sessions.** The first `openmemory_summarize` call for a `session_id` fixes the
session's project and owner; later summaries must match both. Clients that reused
session IDs across projects or users must generate distinct IDs.

**Query scores** are now in `[0, 1)` and comparable across queries, so
`min_score` is a meaningful threshold. (They used to be z-scores within a single
result set.) Ranking order is unchanged apart from the new lexical signal.

**Hybrid retrieval.** Full-text matches are now scoped candidates in
`hsg_query` itself, so exact identifiers, error codes and file names are recalled
even when the embedding misses them. Query text is tokenised before it reaches
FTS5/tsquery, so punctuation no longer causes silent search failures.

**Decay** no longer overwrites a memory's search vector with a compressed or
fingerprinted one. Compressed vectors are kept only as a derived cache in
`memories.compressed_vec`.

**Telemetry removed.** The HTTP server no longer sends host information to an
external endpoint on startup; `OM_TELEMETRY` is ignored.

**Internal API.** Code that imports `core/db` directly must use
`transaction.run(async () => { ... })` and await all work inside it. Nested
transactions are rejected. Outside a callback, PostgreSQL queries use the pool
and SQLite queries are serialised through the same gate as transactions.

## Moving from OpenMemory-enhanced

The project is now **OpenMem** (`ayixiayi/OpenMem`, npm package `openmem-mcp`),
and the package lives at the repository root instead of `packages/openmemory-js`.
MCP tool names (`openmemory_*`), environment variables and the database schema
are unchanged.

1. **Keep your data.** The default SQLite file moved from
   `packages/openmemory-js/data/openmemory.sqlite` to `data/openmemory.sqlite`.
   Copy the old file there, or point `OM_DB_PATH` at it.
2. **Update the MCP server path** in your agent config to
   `/path/to/OpenMem/dist/ai/mcp.js`. The server now reports its name as
   `openmem`.
3. **Identity file:** `~/.openmem/identity.txt` is read first;
   `~/.openmemory-enhanced/identity.txt` still works as a fallback.
4. A `.env` file is now read from the repository root.

## Legacy v1.1 databases

Databases created by OpenMemory v1.1 or earlier need the multi-user columns
before the migrations above can run:

```bash
npm run migrate
```

This adds `user_id` to memories, vectors and waypoints plus a `users` table.
Existing rows keep `user_id = NULL`.
