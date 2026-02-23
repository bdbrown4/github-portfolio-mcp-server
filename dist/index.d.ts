#!/usr/bin/env node
/**
 * GitHub Portfolio MCP Server
 *
 * Exposes tools that let AI agents query a GitHub user's public profile,
 * repositories, languages, and README content.
 *
 * Transports:
 *   - stdio  (default) — for local VS Code / Claude Desktop use
 *   - HTTP/SSE         — when PORT env var is set (for hosted deployment)
 *     - GET  /sse               MCP SSE transport endpoint
 *     - POST /messages          SSE message handler
 *     - POST /call/:tool        REST proxy (used by Python agentic pipeline)
 *     - GET  /tools             List available tools
 *     - GET  /health            Health check
 */
export {};
//# sourceMappingURL=index.d.ts.map