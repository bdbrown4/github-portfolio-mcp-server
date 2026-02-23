#!/usr/bin/env node
/**
 * GitHub Portfolio MCP Server
 *
 * Exposes tools that let AI agents query a GitHub user's public profile,
 * repositories, languages, and README content.
 *
 * Transports:
 *   - stdio  (default, local) — for VS Code / Claude Desktop
 *   - HTTP   (when PORT is set) — Express REST API for hosted/cloud use
 *     - GET  /health            Health check
 *     - GET  /tools             List available tools
 *     - POST /call/:tool        Call a tool by name
 */
export {};
//# sourceMappingURL=index.d.ts.map