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

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_USERNAME = process.env.GITHUB_USERNAME ?? "bdbrown4";
const GITHUB_API = "https://api.github.com";
// Use PORT env var (injected by Railway/Render/etc.) or default to 3000 when
// running in a known cloud environment. Falls back to stdio locally.
const IS_CLOUD = !!(process.env.RAILWAY_ENVIRONMENT ?? process.env.RENDER ?? process.env.FLY_APP_NAME ?? process.env.PORT);
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : (IS_CLOUD ? 3000 : null);

const headers: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "github-portfolio-mcp-server/1.0",
};

if (process.env.GITHUB_TOKEN) {
  headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ghFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${res.statusText} — ${path}`);
  }
  return res.json() as Promise<T>;
}

interface GHRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  topics: string[];
  fork: boolean;
  created_at: string;
  updated_at: string;
  pushed_at: string;
}

interface GHUser {
  login: string;
  name: string | null;
  bio: string | null;
  html_url: string;
  avatar_url: string;
  location: string | null;
  company: string | null;
  blog: string;
  public_repos: number;
  followers: number;
  following: number;
}

// ---------------------------------------------------------------------------
// Tool handler functions (shared between MCP tools and REST proxy)
// ---------------------------------------------------------------------------

async function handleListRepos(args: { include_forks?: boolean; sort?: "updated" | "stars" | "name" }) {
  const repos = await ghFetch<GHRepo[]>(`/users/${GITHUB_USERNAME}/repos?per_page=100&sort=updated`);
  let filtered = args.include_forks ? repos : repos.filter((r) => !r.fork);
  if (args.sort === "stars") filtered.sort((a, b) => b.stargazers_count - a.stargazers_count);
  else if (args.sort === "name") filtered.sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(
    filtered.map((r) => ({
      name: r.name, description: r.description, language: r.language,
      stars: r.stargazers_count, forks: r.forks_count, topics: r.topics,
      url: r.html_url, updated: r.updated_at,
    })),
    null, 2
  );
}

async function handleGetRepoDetails(args: { repo_name: string }) {
  const repo = await ghFetch<GHRepo>(`/repos/${GITHUB_USERNAME}/${args.repo_name}`);
  let readme = "(No README found)";
  try {
    const readmeRes = await fetch(
      `${GITHUB_API}/repos/${GITHUB_USERNAME}/${args.repo_name}/readme`,
      { headers: { ...headers, Accept: "application/vnd.github.v3.raw" } }
    );
    if (readmeRes.ok) readme = await readmeRes.text();
  } catch {}
  return (
    `## Repository: ${repo.name}\n\n` +
    JSON.stringify({
      name: repo.name, full_name: repo.full_name, description: repo.description,
      language: repo.language, stars: repo.stargazers_count, forks: repo.forks_count,
      topics: repo.topics, url: repo.html_url,
      created: repo.created_at, updated: repo.updated_at, pushed: repo.pushed_at,
    }, null, 2) +
    `\n\n## README\n\n${readme}`
  );
}

async function handleGetLanguages(args: { repo_name: string }) {
  const languages = await ghFetch<Record<string, number>>(
    `/repos/${GITHUB_USERNAME}/${args.repo_name}/languages`
  );
  const total = Object.values(languages).reduce((a, b) => a + b, 0);
  return JSON.stringify(
    Object.entries(languages).map(([lang, bytes]) => ({
      language: lang, bytes,
      percentage: total > 0 ? ((bytes / total) * 100).toFixed(1) + "%" : "0%",
    })),
    null, 2
  );
}

async function handleGetProfile() {
  const user = await ghFetch<GHUser>(`/users/${GITHUB_USERNAME}`);
  return JSON.stringify({
    username: user.login, name: user.name, bio: user.bio,
    location: user.location, company: user.company, website: user.blog,
    avatar: user.avatar_url, github_url: user.html_url,
    public_repos: user.public_repos, followers: user.followers, following: user.following,
  }, null, 2);
}

async function handleSearchRepos(args: { query: string }) {
  const repos = await ghFetch<GHRepo[]>(`/users/${GITHUB_USERNAME}/repos?per_page=100`);
  const q = args.query.toLowerCase();
  const matches = repos.filter(
    (r) =>
      r.name.toLowerCase().includes(q) ||
      (r.description?.toLowerCase().includes(q) ?? false) ||
      r.topics.some((t) => t.toLowerCase().includes(q))
  );
  return matches.length > 0
    ? JSON.stringify(matches.map((r) => ({ name: r.name, description: r.description, language: r.language, url: r.html_url })), null, 2)
    : `No repositories matched "${args.query}".`;
}

async function handleGetTechStackSummary() {
  const repos = await ghFetch<GHRepo[]>(`/users/${GITHUB_USERNAME}/repos?per_page=100`);
  const originals = repos.filter((r) => !r.fork);
  const langCounts: Record<string, number> = {};
  const topicCounts: Record<string, number> = {};
  for (const repo of originals) {
    if (repo.language) langCounts[repo.language] = (langCounts[repo.language] ?? 0) + 1;
    for (const t of repo.topics) topicCounts[t] = (topicCounts[t] ?? 0) + 1;
  }
  return JSON.stringify({
    total_original_repos: originals.length,
    languages: Object.entries(langCounts).sort(([, a], [, b]) => b - a).map(([lang, count]) => ({ language: lang, repo_count: count })),
    topics: Object.entries(topicCounts).sort(([, a], [, b]) => b - a).map(([topic, count]) => ({ topic, repo_count: count })),
  }, null, 2);
}

// Tool registry for REST proxy
type ToolHandler = (args: Record<string, unknown>) => Promise<string>;
const TOOL_REGISTRY: Record<string, ToolHandler> = {
  list_repos:             (a) => handleListRepos(a as Parameters<typeof handleListRepos>[0]),
  get_repo_details:       (a) => handleGetRepoDetails(a as Parameters<typeof handleGetRepoDetails>[0]),
  get_languages:          (a) => handleGetLanguages(a as Parameters<typeof handleGetLanguages>[0]),
  get_profile:            ()  => handleGetProfile(),
  search_repos:           (a) => handleSearchRepos(a as Parameters<typeof handleSearchRepos>[0]),
  get_tech_stack_summary: ()  => handleGetTechStackSummary(),
};

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "github-portfolio-mcp-server", version: "1.0.0" });

server.registerTool("list_repos", {
  title: "List GitHub Repositories",
  description: `List public repositories for ${GITHUB_USERNAME}.`,
  inputSchema: {
    include_forks: z.boolean().optional().default(false),
    sort: z.enum(["updated", "stars", "name"]).optional().default("updated"),
  },
}, async (args) => ({ content: [{ type: "text" as const, text: await handleListRepos(args) }] }));

server.registerTool("get_repo_details", {
  title: "Get Repository Details",
  description: "Get detailed info about a specific repository including its README.",
  inputSchema: { repo_name: z.string().describe("Repository name") },
}, async (args) => ({ content: [{ type: "text" as const, text: await handleGetRepoDetails(args) }] }));

server.registerTool("get_languages", {
  title: "Get Repository Languages",
  description: "Get programming languages used in a repository with byte counts.",
  inputSchema: { repo_name: z.string() },
}, async (args) => ({ content: [{ type: "text" as const, text: await handleGetLanguages(args) }] }));

server.registerTool("get_profile", {
  title: "Get GitHub Profile",
  description: `Get the public GitHub profile for ${GITHUB_USERNAME}.`,
  inputSchema: {},
}, async () => ({ content: [{ type: "text" as const, text: await handleGetProfile() }] }));

server.registerTool("search_repos", {
  title: "Search Repositories",
  description: `Search ${GITHUB_USERNAME}'s repositories by keyword.`,
  inputSchema: { query: z.string() },
}, async (args) => ({ content: [{ type: "text" as const, text: await handleSearchRepos(args) }] }));

server.registerTool("get_tech_stack_summary", {
  title: "Tech Stack Summary",
  description: `Aggregate languages and technologies across all of ${GITHUB_USERNAME}'s repos.`,
  inputSchema: {},
}, async () => ({ content: [{ type: "text" as const, text: await handleGetTechStackSummary() }] }));

server.registerResource(
  "profile",
  `github://${GITHUB_USERNAME}/profile`,
  { description: `Public GitHub profile for ${GITHUB_USERNAME}`, mimeType: "application/json" },
  async () => ({
    contents: [{ uri: `github://${GITHUB_USERNAME}/profile`, mimeType: "application/json", text: await handleGetProfile() }],
  })
);

server.registerResource(
  "repo-readme",
  new ResourceTemplate("github://{owner}/{repo}/readme", { list: undefined }),
  { description: "README content for a specific repository", mimeType: "text/markdown" },
  async (uri, { owner, repo }) => {
    const readmeRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/readme`,
      { headers: { ...headers, Accept: "application/vnd.github.v3.raw" } }
    );
    return {
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: readmeRes.ok ? await readmeRes.text() : "(No README found)" }],
    };
  }
);

// ---------------------------------------------------------------------------
// Startup: HTTP/SSE mode (when PORT is set) or stdio (default)
// ---------------------------------------------------------------------------

async function startHttp() {
  const app = express();
  app.use(express.json());

  // REST proxy — called by the Python agentic pipeline
  app.post("/call/:tool", async (req, res) => {
    const toolName = req.params.tool!;
    const handler = TOOL_REGISTRY[toolName];
    if (!handler) {
      res.status(404).json({ error: `Unknown tool: ${toolName}`, available: Object.keys(TOOL_REGISTRY) });
      return;
    }
    try {
      const args = ((req.body as { args?: Record<string, unknown> }).args) ?? {};
      const text = await handler(args);
      res.json({ content: [{ type: "text", text }] });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.get("/tools", (_req, res) => {
    res.json({ tools: Object.keys(TOOL_REGISTRY) });
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", username: GITHUB_USERNAME, tools: Object.keys(TOOL_REGISTRY).length });
  });

  // Root — friendly message instead of 404
  app.get("/", (_req, res) => {
    res.json({ name: "github-portfolio-mcp-server", status: "ok", endpoints: ["/health", "/tools", "/call/:tool"] });
  });

  app.listen(PORT!, "0.0.0.0", () => {
    console.log(`GitHub Portfolio MCP Server running on port ${PORT}`);
    console.log(`  REST: POST /call/:tool_name`);
    console.log(`  Tools: ${Object.keys(TOOL_REGISTRY).join(", ")}`);
  });
}

async function startStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitHub Portfolio MCP Server running on stdio");
}

async function main() {
  if (PORT) {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("Fatal error in main():", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});
