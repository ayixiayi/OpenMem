const { spawnSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const home = mkdtempSync(join(tmpdir(), "openmemory-tests-"));
try {
    for (const test of [
        "test_integrity",
        "test_scope",
        "test_sessions",
        "test_sqlite_transactions",
        "test_postgres_transactions",
        "test_ingestion",
        "test_schema_migrations",
        "test_embedding_contract",
        "test_embedding_paths",
        "test_memory_lifecycle",
        "test_decay",
        "test_auth",
        "test_omnibus",
    ]) {
        const result = spawnSync(
            process.execPath,
            [require.resolve("tsx/cli"), `tests/${test}.ts`],
            {
                cwd: resolve(__dirname, ".."),
                stdio: "inherit",
                timeout: 120000,
                env: {
                    PATH: process.env.PATH,
                    SystemRoot: process.env.SystemRoot,
                    HOME: home,
                    USERPROFILE: home,
                    OM_DB_PATH: ":memory:",
                    OM_METADATA_BACKEND: "sqlite",
                    OM_VECTOR_BACKEND: "sqlite",
                    OM_EMBEDDINGS: "synthetic",
                    OM_TIER: "hybrid",
                },
            },
        );
        if (result.error || result.status !== 0) {
            throw (
                result.error ||
                new Error(
                    `${test} failed (status ${result.status}, signal ${result.signal})`,
                )
            );
        }
    }
    console.log("[REGRESSION] All 13 offline suites passed");
} finally {
    rmSync(home, { recursive: true, force: true });
}
