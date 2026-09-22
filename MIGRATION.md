# Multi-User Tenant Migration (v1.2)

⚠️ **Required for users upgrading from v1.1 or earlier**

OpenMemory v1.2 introduces per-user memory isolation with `user_id` fields. The schema changes add user columns to memories, vectors, and waypoints tables, plus a new users table for summaries.

## Automatic Migration (Recommended)

**OpenMemory includes an automatic migration script for safe database upgrades.**

Run the migration before starting your server:

```bash
cd packages/openmemory-js
npm run migrate
```

**Console output:**

```
OpenMemory Database Migration Tool

[MIGRATE] Checking for pending migrations...
[MIGRATE] Current database version: none
[MIGRATE] Running migration: 1.2.0 - Multi-user tenant support
[MIGRATE] Migration 1.2.0 completed successfully
[MIGRATE] All migrations completed

[SUCCESS] Migration completed
```

**Features:**

- ✅ Auto-detects applied migrations (won't re-run)
- ✅ Safe execution (checks for existing columns before altering)
- ✅ Version tracking (stores applied versions in `schema_version` table)
- ✅ Works with both SQLite and PostgreSQL
- ✅ Gracefully handles errors (skips duplicates)
- ✅ Runs before database is initialized

**After migration, start your server normally:**

```bash
npm run dev
# or
npm start
```

**Location:** `packages/openmemory-js/src/migrate.ts`

---

## Manual Migration (Advanced)

If you prefer manual control or need to run migrations separately, use the SQL scripts below.

### SQLite Migration

Run these commands in your SQLite database (`data/openmemory.sqlite`):

```sql
-- Add user_id to memories table
ALTER TABLE memories ADD COLUMN user_id TEXT;
CREATE INDEX idx_memories_user ON memories(user_id);

-- Add user_id to vectors table
ALTER TABLE vectors ADD COLUMN user_id TEXT;
CREATE INDEX idx_vectors_user ON vectors(user_id);

-- Recreate waypoints table with composite primary key (src_id, user_id)
-- SQLite requires table recreation to change primary key
CREATE TABLE waypoints_new (
  src_id TEXT,
  dst_id TEXT NOT NULL,
  user_id TEXT,
  weight REAL NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY(src_id, user_id)
);

INSERT INTO waypoints_new
  SELECT src_id, dst_id, NULL, weight, created_at, updated_at
  FROM waypoints;

DROP TABLE waypoints;
ALTER TABLE waypoints_new RENAME TO waypoints;

CREATE INDEX idx_waypoints_src ON waypoints(src_id);
CREATE INDEX idx_waypoints_dst ON waypoints(dst_id);
CREATE INDEX idx_waypoints_user ON waypoints(user_id);

-- Create users table
CREATE TABLE users (
  user_id TEXT PRIMARY KEY,
  summary TEXT,
  reflection_count INTEGER DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER
);

-- Create stats table (added in v1.2 for maintenance tracking)
CREATE TABLE stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  ts INTEGER NOT NULL
);

CREATE INDEX idx_stats_ts ON stats(ts);
CREATE INDEX idx_stats_type ON stats(type);
```

---

## PostgreSQL Migration

Replace `schema` with `OM_PG_SCHEMA` and `table_name` with `OM_PG_TABLE` from your config:

```sql
-- Add user_id to memories table
ALTER TABLE schema.table_name ADD COLUMN user_id TEXT;
CREATE INDEX openmemory_memories_user_idx ON schema.table_name(user_id);

-- Add user_id to vectors table
ALTER TABLE schema.openmemory_vectors ADD COLUMN user_id TEXT;
CREATE INDEX openmemory_vectors_user_idx ON schema.openmemory_vectors(user_id);

-- Add user_id to waypoints and update primary key
ALTER TABLE schema.openmemory_waypoints ADD COLUMN user_id TEXT;
ALTER TABLE schema.openmemory_waypoints DROP CONSTRAINT openmemory_waypoints_pkey;
ALTER TABLE schema.openmemory_waypoints ADD PRIMARY KEY (src_id, user_id);
CREATE INDEX openmemory_waypoints_user_idx ON schema.openmemory_waypoints(user_id);

-- Create users table
CREATE TABLE schema.openmemory_users (
  user_id TEXT PRIMARY KEY,
  summary TEXT,
  reflection_count INTEGER DEFAULT 0,
  created_at BIGINT,
  updated_at BIGINT
);
```

---

## Schema Changes Summary

### Modified Tables

- **memories**: Added `user_id TEXT` column + index
- **vectors**: Added `user_id TEXT` column + index
- **waypoints**: Added `user_id TEXT` column, changed primary key from `(src_id)` to `(src_id, user_id)`

### New Tables

- **users**: User summaries and reflection tracking
- **stats**: Maintenance operation logging (decay, reflect, consolidate)

### New Query Methods

- `all_mem_by_user(user_id, limit, offset)` - Get memories for specific user
- `ins_user(user_id, summary, reflection_count, created_at, updated_at)` - Insert/update user
- `get_user(user_id)` - Get user record
- `upd_user_summary(user_id, summary, updated_at)` - Update user summary

---

## Post-Migration Notes

- **Existing records**: Will have `user_id = NULL` (treated as system/default user)
- **API usage**: Include `user_id` in `POST /memory/add` requests
- **Querying**: Filter by user with `filters: { user_id: "user123" }`
- **User summaries**: Auto-generated when memories are added per user
- **Migration tool**: Preserves user_id when importing from Zep/Mem0/Supermemory

## Integrity fixes: scope and Python temporal schema

JS HSG deduplication now matches both the stored `user_id` and `project`.
Omitted values retain the existing `anonymous` / `default` defaults. Legacy
NULL-owned memories are not silently assigned to these scopes. Records lost
through earlier cross-scope deduplication cannot be reconstructed automatically.

In both engines, an unowned temporal write now supersedes only unowned facts,
not facts belonging to every user. Unscoped reads retain their legacy global
behavior; this is not a complete tenant authorization system. Single and batch
temporal inserts roll back supersession if insertion fails. Validity remains
millisecond-based and inclusive; out-of-order and multi-valued fact policy is
unchanged.

JS `POST /api/temporal/fact` now forwards optional body `user_id`, and
`GET /api/temporal/fact` plus `/api/temporal/fact/current` forward optional query
`user_id`. These are caller-supplied scope filters, not authentication claims.
Other temporal endpoints retain their existing scope behavior.

Python applies `002_temporal_contract.sql` on the next database connection,
after `001_initial.sql`. It renames `obj` to `object` and `relation` to
`relation_type`, adds user/update fields, and assigns stable IDs to legacy edges.
Existing fact IDs, metadata, confidence and validity intervals are preserved.
Unknown historical `last_updated` values remain NULL rather than being inferred
from valid time. Migration DDL and its `_migrations` marker commit atomically.

This upgrade targets the Python `001_initial.sql` schema only. It does **not**
make JS and Python databases interchangeable, or upgrade manually modified
schemas. Back up with SQLite's backup API before opening a persistent database
with the new package, and test on a copy. On failure the pending migration is
rolled back and the connection is closed; correct the cause before retrying.
To revert a successfully upgraded database, stop writers and restore the backup
together with the prior package. Do not merely delete the migration marker.

Offline regression checks (run from each package directory):

```bash
# JS: the integrity test forces an in-memory SQLite database and synthetic embeddings.
npx tsx tests/test_integrity.ts
# Python: all temporal test fixtures use disposable in-memory databases.
OM_DB_URL=sqlite:///:memory: OM_EMBED_KIND=synthetic python -m pytest -q tests/test_temporal_integrity.py
```

## JS project retrieval and waypoint boundaries

Project filters now apply before vector top-k selection. SQLite and PostgreSQL
use the metadata table's project field; no vector schema migration is needed.
Valkey scoped queries resolve eligible IDs from metadata and fetch their binary
vectors in batches of 100 before exact ranking. This avoids global KNN
post-filter starvation but costs a scan of the scoped vectors; large-scope
latency still needs measurement. Direct Valkey adapters must supply the metadata
resolver for project searches, otherwise the call fails rather than ignoring
the project.

HSG waypoint creation, traversal, coactivation and linked reinforcement now
require matching stored user and project on both endpoints, including for
unscoped queries. Existing cross-scope edges remain stored but are not followed
or reinforced. NULL scopes are not silently equated with named defaults.
Unscoped vector retrieval still searches all scopes. These are data boundaries,
not caller authorization; summaries, wakeup and temporal authorization require
separate work. Run `npx tsx tests/test_scope.ts` for the offline regression suite.
