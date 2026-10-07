# Contributing

Thanks for helping improve OpenMem.

## Reporting bugs

Open an [issue](https://github.com/ayixiayi/OpenMem/issues) with
steps to reproduce, what you expected, what happened, and your backend
(`sqlite`/`postgres`, embedding provider). Report security problems privately
via [security advisories](https://github.com/ayixiayi/OpenMem/security/advisories/new).

## Development

Requires Node.js 20+.

```bash
git clone https://github.com/ayixiayi/OpenMem.git
cd OpenMem
make install
make test        # typecheck + offline suites (in-memory SQLite, synthetic embeddings)
make mcp         # run the MCP server over stdio
```

Individual suites live in `tests/` and run with
`npx tsx tests/<name>.ts`. Add a suite to `tests/run.cjs` when you create one.

## Pull requests

- Keep changes focused; one concern per PR.
- Add or update a test for every behaviour change. Tests must run offline.
- Schema changes go in `src/core/schema_migrations.ts` as a new numbered
  migration, never by editing an existing one, and get a line in
  [MIGRATION.md](MIGRATION.md).
- Respect scope: anything that reads or links memories must filter by
  `user_id` and `project` before ranking or limiting.
- Do not rename MCP tool names; agents depend on them.
- Run `make test` before pushing; CI runs the same checks.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are licensed under [Apache-2.0](LICENSE).
