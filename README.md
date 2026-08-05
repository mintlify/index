# Mintlify Index

Real-time documentation retrieval for coding agents.

Mintlify Index answers implementation questions (syntax, configuration, migration, setup) with compact, cited context assembled from primary-source developer documentation and live web search. It ships as a hosted [MCP](https://modelcontextprotocol.io) server exposing a single `context` tool.

## Quickstart

```bash
npx mint index
```

The interactive installer detects your coding agents and adds the hosted MCP server (`https://index.mintlify.com/mcp`) plus a usage rule so the agent reaches for it automatically. Supported clients:

- Claude Code
- Cursor
- VS Code (Copilot)
- Codex
- OpenCode
- Windsurf
- Zed

Non-interactive setup:

```bash
npx mint index --claude --cursor --yes     # specific clients, skip prompts
npx mint index --project                   # write project-level config instead of global
```

Any other MCP client can be pointed at the server manually:

```json
{
  "mcpServers": {
    "mintlify-index": {
      "type": "http",
      "url": "https://index.mintlify.com/mcp"
    }
  }
}
```

The `context` tool takes a `query` (plus optional `product`, `includeDomains`, `excludeDomains`, and a `tokenBudget` up to 6000) and returns a cited answer in one call.

## How it works

```
query
  │
  ▼
router ────────────── LLM route decision against a catalog of indexed sites
  │
  ├───────────────┬─────────────────┐
  ▼               ▼                 │
mintlify leg    web leg             │  run concurrently or routed
(Chroma hybrid  (Exa search +       │
 search over     live contents)     │
 indexed docs)                      │
  └───────┬───────┘                 │
          ▼                         │
combine + rerank ── deterministic scoring, hosted reranker, LLM fallback
          │
          ▼
context assembly ── token-budget packing with query-centered snippets
          │
          ▼
MCP `context` tool
```

| Directory | Pipeline stage |
| --- | --- |
| `src/retrieval/router.ts` | LLM query router deciding which leg(s) to serve |
| `src/retrieval/engine.ts` | The engine: legs, blending, ranking, relevance cutoff, hydration |
| `src/retrieval/webSearchProvider.ts` | Web leg over Exa |
| `src/retrieval/reranker.ts` | Hosted + LLM rerankers, query-centered snippeting |
| `src/retrieval/contextAssembly.ts` | Token-budget context packing |
| `src/retrieval/operations.ts` | `context` / `search` / `contents` operations |
| `src/retrieval/retrievalConfig.ts` | Tunable retrieval configuration |
| `src/mcp/` | MCP server: the `context` tool over streamable HTTP |
| `src/cli/` | The `mint index` installer (ships in the [`mint`](https://www.npmjs.com/package/mint) CLI) |
| `src/internal/` | Interfaces for Mintlify-platform components backing the hosted service |

## About this repo

This is a source release of the hosted service. It is **not runnable standalone**: docs ingestion, the Chroma corpus, auth, and infrastructure live in the Mintlify platform and are represented here by small interfaces in `src/internal/`. `src/server.ts` shows how the pieces wire together in production.

## License

[MIT](LICENSE)
