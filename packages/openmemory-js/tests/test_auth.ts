import assert from "node:assert/strict";

process.env.OM_API_KEY = "test-key";
process.env.OM_RATE_LIMIT_ENABLED = "false";
process.env.OM_TIER = "hybrid";

async function main() {
    const { authenticate_api_request } = await import(
        "../src/server/middleware/auth"
    );
    function request(url: string, headers: Record<string, unknown> = {}) {
        let status = 200,
            next = 0;
        const res = {
            status(code: number) {
                status = code;
                return res;
            },
            json(body: unknown) {
                return body;
            },
        };
        authenticate_api_request({ url, headers }, res, () => {
            next++;
        });
        return { status, next };
    }
    assert.deepEqual(request("/memory", { "x-api-key": "test-key" }), {
        status: 200,
        next: 1,
    });
    assert.deepEqual(request("/memory", { authorization: "Bearer test-key" }), {
        status: 200,
        next: 1,
    });
    // Same character count, different UTF-8 byte count: reject, never throw.
    assert.deepEqual(request("/memory", { "x-api-key": "tést-key" }), {
        status: 403,
        next: 0,
    });
    for (const headers of [
        { "x-api-key": ["test-key"] },
        { authorization: ["Bearer test-key"] },
        { "x-api-key": 12 },
    ]) {
        assert.deepEqual(request("/memory", headers), { status: 401, next: 0 });
    }
    for (const path of [
        "/health",
        "/health/",
        "/health?probe=1",
        "/api/system/stats",
    ]) {
        assert.deepEqual(request(path), { status: 200, next: 1 });
    }
    for (const path of [
        "/health-private",
        "/api/system/stats/export",
        "/memory",
    ]) {
        assert.deepEqual(request(path), { status: 401, next: 0 });
    }
    console.log(
        "[AUTH] exact public paths, malformed headers and UTF-8 key rejection passed",
    );
}
main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
