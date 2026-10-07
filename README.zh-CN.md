# OpenMem

[English](README.md) | **简体中文**

为 **AI 编程 agent** 提供的长期记忆，通过 MCP 提供服务。agent 每次开启新会话时，
都已经知道自己上次在这个项目里做了什么、定了什么、学到了什么，不需要你重复交代。

- **一次调用即可唤醒。** `openmemory_wakeup(project)` 返回该项目最重要的记忆（按类型分组）
  以及最近几次会话的总结，内容紧凑。
- **按项目和用户隔离。** 每条记忆、会话和总结都带有 `project`。在向量、全文和图检索中，
  过滤都发生在排序*之前*，因此一个仓库的记忆不会挤占或泄漏到另一个仓库。
- **能找到标识符的混合召回。** 向量相似度、SQLite FTS5 / Postgres 全文匹配与联想路径点
  融合成一个分数。即使向量没能命中，精确的 `ECONNRESET`、文件名或配置项也能被召回。
- **默认离线可用。** SQLite 加内置的合成向量：不需要 API key，不依赖任何外部服务。
  通过环境变量即可切换到 OpenAI、Gemini、Ollama 或 AWS 向量，或改用 Postgres + pgvector。
- **不只是工具，还有协议。** [`SKILL.md`](SKILL.md) 告诉 agent 何时唤醒、存什么、
  何时搜索以及如何结束一次会话。

## MCP 工具

| 工具 | 用途 |
|---|---|
| `openmemory_wakeup` | 会话开始：返回项目中按类型分组的重要记忆 + 最近的会话总结 |
| `openmemory_store` | 保存一条观察，可带 `project`、`session_id`、`observation_type`、标签和元数据（也可存时序事实） |
| `openmemory_query` | 限定作用域的混合搜索（向量 + 全文 + 路径点），可选时序事实查询 |
| `openmemory_summarize` | 保存会话总结：需求、完成内容、收获、后续步骤、修改的文件 |
| `openmemory_timeline` | 按时间顺序返回某条记忆前后的记忆 |
| `openmemory_consolidate` | 判断项目是否需要整理，并返回低价值的候选记忆 |
| `openmemory_list` | 最近的记忆，可按项目、用户和扇区过滤 |
| `openmemory_get` | 获取单条记忆的完整内容 |
| `openmemory_reinforce` | 提高某条记忆的显著度 |
| `openmemory_delete` | 删除一条记忆 |
| `openmemory_status` | 按项目/类型/扇区统计数量、向量配置以及使用协议 |

观察类型：`observation`、`bugfix`、`decision`、`discovery`、`feature`、`gotcha`、`refactor`。

## 安装

需要 Node.js 20+。

```bash
git clone https://github.com/ayixiayi/OpenMem.git
cd OpenMem
npm install
npm run build
```

在 agent 中注册 stdio 服务。

**Claude Code**

```bash
claude mcp add openmem -- node /path/to/OpenMem/dist/ai/mcp.js
```

**opencode**（`~/.config/opencode/opencode.json`）

```json
{
  "mcp": {
    "openmem": {
      "type": "local",
      "command": ["node", "/path/to/OpenMem/dist/ai/mcp.js"],
      "enabled": true,
      "timeout": 15000
    }
  }
}
```

然后把协议交给 agent：将 [`SKILL.md`](SKILL.md) 复制到它的 skills 目录
（Claude Code 为 `~/.claude/skills/openmem/SKILL.md`），或粘贴进 agent 的指令中。

可选：在 `~/.openmem/identity.txt` 中写几行关于你自己或你的习惯约定，唤醒时会放在最前面。

## 一次会话的样子

```
会话 1 — 项目 "my-app"
  → openmemory_wakeup("my-app")                       ← "new project"
  → openmemory_store("Chose JWT over server sessions: the API is stateless
       behind a load balancer", project: "my-app", observation_type: "decision")
  → openmemory_summarize(project: "my-app", completed: "JWT auth", learned: …)

会话 2 — 新对话，同一个项目
  → openmemory_wakeup("my-app")
  ← ## Essential Context (1 memories)
    [DECISION]
    - Chose JWT over server sessions: the API is stateless behind a load balancer
    ## Recent Sessions (1)
    Session: Add authentication
      Done: JWT auth
      Next: refresh-token rotation
```

## 检索流程

1. 按记忆扇区分别对查询做向量化，并在用户/项目作用域内搜索。
2. 全文搜索（SQLite 上为 FTS5 BM25，Postgres 上为 `tsvector` + GIN）补充同一作用域内的
   词法候选；查询会先分词，因此标点和运算符都是安全的。
3. 置信度较低的结果会沿同作用域的路径点边扩展。
4. 每个候选得到一个 `[0, 1)` 区间的分数，综合向量相似度、词与标签重合度、全文排名、
   路径点权重和时间新近度。因此 `min_score` 阈值对每次查询含义一致。
5. 被召回的记忆会被强化；未被使用的记忆按各扇区的速率衰减。

## 配置

所有配置都通过环境变量设置，均为可选。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OM_DB_PATH` | `data/openmemory.sqlite`（仓库内） | SQLite 数据库文件 |
| `OM_EMBEDDINGS` | `synthetic` | `synthetic`、`openai`、`gemini`、`ollama`、`aws` |
| `OPENAI_API_KEY` | — | 使用 `OM_EMBEDDINGS=openai` 时需要 |
| `OM_TIER` | `hybrid` | `hybrid` / `fast`（合成向量）、`smart`（合成 + 压缩语义向量）、`deep`（语义向量） |
| `OM_METADATA_BACKEND` | `sqlite` | `sqlite` 或 `postgres`（`OM_PG_HOST`、`OM_PG_DB` 等） |
| `OM_VECTOR_BACKEND` | 跟随元数据后端 | 设为 `valkey` 时向量存放在 Valkey/Redis 中 |

完整列表见 [`.env.example`](.env.example)。数据库结构升级会在启动时自动执行；
升级已有数据库前请先阅读 [MIGRATION.md](MIGRATION.md)。

## 开发

```bash
npx tsc --noEmit
npm test          # 离线运行：内存 SQLite + 合成向量
```

`npm start` 启动可选的 HTTP API（端口为 `OM_PORT`，默认 8080），同时在 `POST /mcp`
提供 MCP 服务。也可以作为库使用：

```typescript
import { Memory } from "openmem-mcp";

const mem = new Memory("user-123");
await mem.add("Chose JWT over server sessions", { project: "my-app", tags: ["auth"] });
const hits = await mem.search("auth decision", { project: "my-app", limit: 5 });
```

## 许可证

[Apache-2.0](LICENSE)。另见 [NOTICE](NOTICE)。
