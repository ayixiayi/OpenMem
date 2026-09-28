import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";

// The pool getter also supports db.ts replacing its pool during initialization.
export function postgres_transactions(pool: () => Pool) {
    const context = new AsyncLocalStorage<{
        client: PoolClient;
        active: boolean;
    }>();
    return {
        query: (sql: string, params: any[] = []) => {
            const scope = context.getStore();
            if (scope && !scope.active) {
                throw new Error("Transaction callback has already finished");
            }
            return (scope?.client ?? pool()).query(sql, params);
        },
        run: async <T>(work: () => Promise<T>): Promise<T> => {
            if (context.getStore())
                throw new Error("Nested transactions are not supported");
            const client = await pool().connect();
            const scope = { client, active: true };
            let discard = false;
            let begun = false;
            let committing = false;
            try {
                await client.query("BEGIN");
                begun = true;
                const result = await context.run(scope, work);
                scope.active = false;
                committing = true;
                await client.query("COMMIT");
                return result;
            } catch (error) {
                scope.active = false;
                // A failed BEGIN or COMMIT may leave the connection unusable.
                discard = !begun || committing;
                if (begun) {
                    try {
                        await client.query("ROLLBACK");
                    } catch {
                        discard = true;
                    }
                }
                throw error;
            } finally {
                scope.active = false;
                client.release(discard);
            }
        },
    };
}
