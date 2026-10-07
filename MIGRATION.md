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

The SQLite temporal rebuild only accepts the stock `temporal_facts` definition;
a manually altered table aborts the migration instead of silently dropping
columns.

## Behaviour changes worth knowing

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
