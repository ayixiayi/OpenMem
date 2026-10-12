---
name: openmem
description: Persistent, project-scoped memory across coding sessions via the OpenMem MCP server. Use at the start of every session, after meaningful progress, when the user refers to past work, and before ending a session.
---

# OpenMem protocol

`project` is always the basename of the working directory (`home` for the home
directory). Pass the same `project` to every call. Do all of this silently;
mention memory only when it changes what you do.

OpenMem has two tracks:

- **Observations** (contextual): what happened and *why*: decisions, root
  causes, failed attempts, gotchas. Searched by meaning and exact identifiers.
- **Facts**: what is *true*: `subject · predicate: object`, each with the time
  it became true. Answers "what is it now?" and "what was it then?" exactly.

## 1. Session start

Call `openmemory_wakeup(project)` once. It returns the project's current facts,
its most important observations grouped by type, and the last three session
summaries. If it reports a new project, continue normally.

Pick a `session_id` for this conversation (for example a UUID) and reuse it for
every store and the final summary.

## 2. During work: observations

After each meaningful step, call `openmemory_store` with:

- `content`: one self-contained observation, written for a future agent with
  zero context. Include exact identifiers (error codes, file paths, function
  names, config keys); retrieval matches them literally.
- `project`, `session_id`
- `observation_type`: `bugfix` | `decision` | `discovery` | `feature` |
  `gotcha` | `refactor` | `observation`
- `tags`: short, consistent category tags

Store *why*, not just *what*: the reason behind a decision, the root cause of a
bug, the trap that cost time. Skip anything derivable from the code or git log.
Save as you go. A session can end abruptly, so don't wait until the end.

## 3. During work: facts

When an observation **establishes or changes something that is simply true**,
store it with `type: "both"` and add `facts`. The facts are linked to the
observation, so the reasoning stays attached to the state.

Make a fact for:

- current project configuration and choices: database, framework, package
  manager, deploy target, API base URL, minimum supported version;
- confirmed state changes ("we moved from X to Y");
- explicit, durable user preferences. Use `scope: "global"` for those that apply
  in every project.

Do **not** make facts for guesses, plans, opinions, or anything you would need
a paragraph to qualify; those are observations.

Pick the `kind`:

| kind | use for | a new value… |
|---|---|---|
| `state` (default) | one value at a time: default database, current version | ends the previous value |
| `set` | values that coexist: supported platforms, CI runners | is added alongside the others |
| `event` | something that happened: deploy, outage, migration | is recorded at `valid_from`, never replaces anything |

Naming: `subject` is the thing (`backend`, `api`, `user`, `ci`); `predicate` is
a short snake_case attribute (`database`, `supported_platform`,
`answer_language`). Reuse names you see in wakeup or query results, because
consistent names are what make updates replace the right value. Set
`valid_from` when the change happened earlier than now; older values are
filled into history correctly.

When something stops being true without a replacement (a platform dropped, a
setting removed), call `openmemory_retract_fact`. Don't delete the
observation that explained it; history is the point.

## 4. Recall

Before answering questions about past work, or before making a decision the
project may already have made, search:

- `openmemory_query(query, project)`: observations (why, how, what happened).
- `type: "factual"`: what is true now, or `at` a past date.
- `type: "unified"`: both together.

Results marked **HISTORICAL** describe a state that has since changed. Use
them for the reasoning and trust the current fact for the state. Never guess
about past sessions. Use `openmemory_timeline(memory_id)` to see what happened
around a hit, and `openmemory_reinforce(id)` when a memory proved useful.

## 5. Session end

Call `openmemory_summarize` with `session_id`, `project`, `request`,
`completed`, `learned`, and optionally `next_steps` and `files_modified`.

## 6. Housekeeping

If wakeup shows a large project, call `openmemory_consolidate(project)`. When it
reports `needs_consolidation`, merge related low-salience candidates into fewer,
higher-quality memories with `openmemory_store`, then delete the originals.
