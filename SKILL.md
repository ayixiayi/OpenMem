---
name: openmem
description: Persistent, project-scoped memory across coding sessions via the OpenMem MCP server. Use at the start of every session, after meaningful progress, when the user refers to past work, and before ending a session.
---

# OpenMem protocol

`project` is always the basename of the working directory (`home` for the home
directory). Pass the same `project` to every call. Do all of this silently;
mention memory only when it changes what you do.

## 1. Session start

Call `openmemory_wakeup(project)` once. It returns, in one compact block, the
highest-salience memories grouped by type plus the last three session summaries.
If it reports a new project, continue normally.

Pick a `session_id` for this conversation (for example a UUID) and reuse it for
every store and the final summary.

## 2. During work

After each meaningful step, call `openmemory_store` with:

- `content` — one self-contained observation, written for a future agent with
  zero context. Include exact identifiers (error codes, file paths, function
  names, config keys): retrieval matches them literally.
- `project`, `session_id`
- `observation_type` — `bugfix` | `decision` | `discovery` | `feature` |
  `gotcha` | `refactor` | `observation`
- `tags` — short, consistent category tags
- `metadata` — optional `{ files_involved: [...], concepts: [...] }`

Store *why*, not just *what*: the reason behind a decision, the root cause of a
bug, the trap that cost time. Skip anything derivable from the code or git log.

When a stored fact becomes outdated, store the corrected fact and delete the old
memory with `openmemory_delete`.

## 3. Recall

When the user asks about past work, or you are about to make a decision the
project may already have made, call `openmemory_query(query, project)` before
answering. Never guess about past sessions. Use `openmemory_timeline(memory_id)`
to see what happened around a hit, and `openmemory_reinforce(id)` when a memory
proved useful.

## 4. Session end

Call `openmemory_summarize` with `session_id`, `project`, `request`,
`completed`, `learned`, and optionally `next_steps` and `files_modified`.

## 5. Housekeeping

If wakeup shows a large project, call `openmemory_consolidate(project)`. When it
reports `needs_consolidation`, merge related low-salience candidates into fewer,
higher-quality memories with `openmemory_store`, then delete the originals.
