#!/usr/bin/env node

/**
 * GitHub Portfolio MCP Server
 *
 * Exposes tools that let AI agents query a GitHub user's public profile,
 * repositories, languages, and README content. Designed as a learning project
 * for the Model Context Protocol (MCP).
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GITHUB_USERNAME = "bdbrown4";
const GITHUB_API = "https://api.github.com";

const headers: Record<string, string> = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "github-portfolio-mcp-server/1.0",
};

// Allow an optional PAT for higher rate limits
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
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "github-portfolio-mcp-server",
  version: "1.0.0",
});

// ── Tool: list_repos ──────────────────────────────────────────────────────
server.registerTool(
  "list_repos",
  {
    title: "List GitHub Repositories",
    description:
      `List public repositories for the portfolio owner (${GITHUB_USERNAME}). ` +
      `Returns name, description, language, stars, and URL for each repo. ` +
      `Set include_forks to true to include forked repos.`,
    inputSchema: {
      include_forks: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include forked repositories in the results"),
      sort: z
        .enum(["updated", "stars", "name"])
        .optional()
        .default("updated")
        .describe("Sort repositories by this field"),
    },
  },
  async ({ include_forks, sort }) => {
    const repos = await ghFetch<GHRepo[]>(
      `/users/${GITHUB_USERNAME}/repos?per_page=100&sort=updated`
    );

    let filtered = include_forks ? repos : repos.filter((r) => !r.fork);

    if (sort === "stars") {
      filtered.sort((a, b) => b.stargazers_count - a.stargazers_count);
    } else if (sort === "name") {
      filtered.sort((a, b) => a.name.localeCompare(b.name));
    }

    const summary = filtered.map((r) => ({
      name: r.name,
      description: r.description,
      language: r.language,
      stars: r.stargazers_count,
      forks: r.forks_count,
      topics: r.topics,
      url: r.html_url,
      updated: r.updated_at,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  }
);

// ── Tool: get_repo_details ────────────────────────────────────────────────
server.registerTool(
  "get_repo_details",
  {
    title: "Get Repository Details",
    description:
      "Get detailed information about a specific repository including its README content.",
    inputSchema: {
      repo_name: z.string().describe("The repository name (e.g. 'crypto-web-component')"),
    },
  },
  async ({ repo_name }) => {
    const repo = await ghFetch<GHRepo>(
      `/repos/${GITHUB_USERNAME}/${repo_name}`
    );

    // Try to fetch the README
    let readme = "(No README found)";
    try {
      const readmeRes = await fetch(
        `${GITHUB_API}/repos/${GITHUB_USERNAME}/${repo_name}/readme`,
        { headers: { ...headers, Accept: "application/vnd.github.v3.raw" } }
      );
      if (readmeRes.ok) {
        readme = await readmeRes.text();
      }
    } catch {
      // README not found — that's fine
    }

    const details = {
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description,
      language: repo.language,
      stars: repo.stargazers_count,
      forks: repo.forks_count,
      topics: repo.topics,
      url: repo.html_url,
      created: repo.created_at,
      updated: repo.updated_at,
      pushed: repo.pushed_at,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: `## Repository: ${repo.name}\n\n` +
            `${JSON.stringify(details, null, 2)}\n\n` +
            `## README\n\n${readme}`,
        },
      ],
    };
  }
);

// ── Tool: get_languages ───────────────────────────────────────────────────
server.registerTool(
  "get_languages",
  {
    title: "Get Repository Languages",
    description:
      "Get the programming languages used in a specific repository, with byte counts.",
    inputSchema: {
      repo_name: z.string().describe("The repository name"),
    },
  },
  async ({ repo_name }) => {
    const languages = await ghFetch<Record<string, number>>(
      `/repos/${GITHUB_USERNAME}/${repo_name}/languages`
    );

    const total = Object.values(languages).reduce((a, b) => a + b, 0);
    const breakdown = Object.entries(languages).map(([lang, bytes]) => ({
      language: lang,
      bytes,
      percentage: total > 0 ? ((bytes / total) * 100).toFixed(1) + "%" : "0%",
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(breakdown, null, 2),
        },
      ],
    };
  }
);

// ── Tool: get_profile ─────────────────────────────────────────────────────
server.registerTool(
  "get_profile",
  {
    title: "Get GitHub Profile",
    description: `Get the public GitHub profile for ${GITHUB_USERNAME} — bio, location, company, follower count, etc.`,
    inputSchema: {},
  },
  async () => {
    const user = await ghFetch<GHUser>(`/users/${GITHUB_USERNAME}`);

    const profile = {
      username: user.login,
      name: user.name,
      bio: user.bio,
      location: user.location,
      company: user.company,
      website: user.blog,
      avatar: user.avatar_url,
      github_url: user.html_url,
      public_repos: user.public_repos,
      followers: user.followers,
      following: user.following,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(profile, null, 2),
        },
      ],
    };
  }
);

// ── Tool: search_repos ────────────────────────────────────────────────────
server.registerTool(
  "search_repos",
  {
    title: "Search Repositories",
    description:
      `Search ${GITHUB_USERNAME}'s repositories by keyword. Matches against repo name, description, and topics.`,
    inputSchema: {
      query: z.string().describe("Search keyword to match against repo names, descriptions, and topics"),
    },
  },
  async ({ query }) => {
    const repos = await ghFetch<GHRepo[]>(
      `/users/${GITHUB_USERNAME}/repos?per_page=100`
    );

    const q = query.toLowerCase();
    const matches = repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.description?.toLowerCase().includes(q) ?? false) ||
        r.topics.some((t) => t.toLowerCase().includes(q))
    );

    const results = matches.map((r) => ({
      name: r.name,
      description: r.description,
      language: r.language,
      url: r.html_url,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text:
            results.length > 0
              ? JSON.stringify(results, null, 2)
              : `No repositories matched "${query}".`,
        },
      ],
    };
  }
);

// ── Tool: get_tech_stack_summary ──────────────────────────────────────────
server.registerTool(
  "get_tech_stack_summary",
  {
    title: "Tech Stack Summary",
    description:
      `Aggregate the programming languages and technologies used across all of ${GITHUB_USERNAME}'s repositories into a summary.`,
    inputSchema: {},
  },
  async () => {
    const repos = await ghFetch<GHRepo[]>(
      `/users/${GITHUB_USERNAME}/repos?per_page=100`
    );

    const originalRepos = repos.filter((r) => !r.fork);
    const langCounts: Record<string, number> = {};
    const topicCounts: Record<string, number> = {};

    for (const repo of originalRepos) {
      if (repo.language) {
        langCounts[repo.language] = (langCounts[repo.language] ?? 0) + 1;
      }
      for (const topic of repo.topics) {
        topicCounts[topic] = (topicCounts[topic] ?? 0) + 1;
      }
    }

    const languages = Object.entries(langCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([lang, count]) => ({ language: lang, repo_count: count }));

    const topics = Object.entries(topicCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([topic, count]) => ({ topic, repo_count: count }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              total_original_repos: originalRepos.length,
              languages,
              topics,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// ── Resource: profile ─────────────────────────────────────────────────────
server.registerResource(
  "profile",
  `github://${GITHUB_USERNAME}/profile`,
  { description: `Public GitHub profile for ${GITHUB_USERNAME}`, mimeType: "application/json" },
  async () => {
    const user = await ghFetch<GHUser>(`/users/${GITHUB_USERNAME}`);
    return {
      contents: [
        {
          uri: `github://${GITHUB_USERNAME}/profile`,
          mimeType: "application/json",
          text: JSON.stringify(user, null, 2),
        },
      ],
    };
  }
);

// ── Resource template: repo README ────────────────────────────────────────
server.registerResource(
  "repo-readme",
  new ResourceTemplate("github://{owner}/{repo}/readme", { list: undefined }),
  { description: "README content for a specific repository", mimeType: "text/markdown" },
  async (uri, { owner, repo }) => {
    const readmeRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/readme`,
      { headers: { ...headers, Accept: "application/vnd.github.v3.raw" } }
    );
    const text = readmeRes.ok
      ? await readmeRes.text()
      : "(No README found)";

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text,
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start the server (stdio transport)
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("GitHub Portfolio MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
