# openmemory-enhanced

Project-scoped, session-aware long-term memory for AI coding agents, served as
an MCP server. Works fully offline with SQLite and built-in embeddings.

Full documentation: [repository README](../../README.md). Agent protocol:
[SKILL.md](SKILL.md).

## Run the MCP server

```bash
npm install
npm run build
node dist/ai/mcp.js          # stdio transport
```

`npm start` runs the optional HTTP API (`dist/server/index.js`, port `OM_PORT`,
default 8080), which also exposes MCP over `POST /mcp`.

## Programmatic use

```typescript
import { Memory } from "openmemory-enhanced";

const mem = new Memory("user-123");
await mem.add("Chose JWT over server sessions", { project: "my-app", tags: ["auth"] });
const hits = await mem.search("auth decision", { project: "my-app", limit: 5 });
```

## Test

```bash
npx tsc --noEmit
npm test   # offline: in-memory SQLite + synthetic embeddings
```

Apache-2.0. See [NOTICE](../../NOTICE).
