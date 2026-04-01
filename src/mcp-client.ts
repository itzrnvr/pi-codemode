// mcp-client.ts — MCP client with lazy connections and cache integration.
//
// Uses pi-mcp-adapter's metadata cache for instant tool discovery (no connections).
// Servers connect lazily on first actual tool call. Type info comes from cache.

import { McpServerManager } from "pi-mcp-adapter/server-manager.js";
import { loadMcpConfig } from "pi-mcp-adapter/config.js";
import { loadMetadataCache, isServerCacheValid, computeServerHash } from "pi-mcp-adapter/metadata-cache.js";
import { transformMcpContent } from "pi-mcp-adapter/tool-registrar.js";
import type { McpContent } from "pi-mcp-adapter/types.js";
import { generateParamSummary } from "./type-generator.js";

/** Info about an MCP tool (from cache or live connection) */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** Info about an MCP server and its tools */
export interface McpServerInfo {
  serverName: string;
  /** Short namespace used in code: tools.<namespace>.toolName() */
  namespace: string;
  tools: McpToolInfo[];
  /** Whether this came from cache (true) or live connection (false) */
  fromCache: boolean;
}

export interface McpClient {
  /** Get info about all known servers (from cache, no connections needed). */
  getServers(): McpServerInfo[];

  /** Call a tool on a specific server. Lazy-connects if needed. */
  call(namespace: string, toolName: string, args?: Record<string, unknown>): Promise<string>;

  /** Search available MCP tools (uses cache, no connections needed). */
  search(query: string): string;

  /** List all configured server names. */
  listServers(): string[];

  /** Clean up all connections. */
  shutdown(): Promise<void>;

  /** Whether any MCP servers are configured. */
  readonly available: boolean;
}

export function createMcpClient(): McpClient {
  const manager = new McpServerManager();
  const config = loadMcpConfig();
  const serverNames = Object.keys(config.mcpServers);
  const cache = loadMetadataCache();

  // Build server info from cache (instant, no connections)
  const servers = new Map<string, McpServerInfo>();
  const namespaceToServer = new Map<string, string>(); // namespace → serverName

  for (const serverName of serverNames) {
    const namespace = toNamespace(serverName);
    namespaceToServer.set(namespace, serverName);

    const def = config.mcpServers[serverName];
    const cached = cache?.servers?.[serverName];

    if (cached && def && isServerCacheValid(cached, def)) {
      // Use cached tool metadata — no connection needed
      servers.set(namespace, {
        serverName,
        namespace,
        tools: cached.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
        fromCache: true,
      });
    } else {
      // No valid cache — server exists but tools unknown until connected
      servers.set(namespace, {
        serverName,
        namespace,
        tools: [],
        fromCache: false,
      });
    }
  }

  // Track which servers have live connections
  const connectedServers = new Set<string>();

  async function ensureConnected(namespace: string): Promise<void> {
    const serverName = namespaceToServer.get(namespace);
    if (!serverName) throw new Error(`Unknown MCP server namespace: "${namespace}"`);
    if (connectedServers.has(serverName)) return;

    const def = config.mcpServers[serverName];
    if (!def) throw new Error(`No config for MCP server: "${serverName}"`);

    const connection = await manager.connect(serverName, def);

    // Update server info with live tool data
    const tools: McpToolInfo[] = connection.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    servers.set(namespace, { serverName, namespace, tools, fromCache: false });
    connectedServers.add(serverName);
  }

  return {
    get available() {
      return serverNames.length > 0;
    },

    getServers() {
      return [...servers.values()];
    },

    async call(namespace: string, toolName: string, args?: Record<string, unknown>): Promise<string> {
      // Lazy-connect on first call
      await ensureConnected(namespace);

      const info = servers.get(namespace)!;
      const connection = manager.getConnection(info.serverName);
      if (!connection) {
        throw new Error(`MCP server "${info.serverName}" failed to connect`);
      }

      manager.touch(info.serverName);
      manager.incrementInFlight(info.serverName);

      try {
        const result = await connection.client.callTool({
          name: toolName,
          arguments: args ?? {},
        });

        const mcpContent = (result.content ?? []) as McpContent[];
        const content = transformMcpContent(mcpContent);

        const textParts = content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text);

        const text = textParts.join("\n") || "(empty result)";

        if (result.isError) {
          // Enrich error with schema hints to help self-correction
          const info = servers.get(namespace)!;
          const toolInfo = info.tools.find((t) => t.name === toolName);
          let errorMsg = `MCP tool error: tools.${namespace}.${toolName}()\n\n${text}`;
          if (toolInfo?.inputSchema) {
            errorMsg += `\n\n${generateParamSummary(toolInfo.inputSchema)}`;
          }
          throw new Error(errorMsg);
        }

        return text;
      } finally {
        manager.decrementInFlight(info.serverName);
      }
    },

    search(query: string): string {
      const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
      if (terms.length === 0) return "Empty search query.";

      // Score each tool: count how many terms match (AND-ish ranking)
      const scored: Array<{ namespace: string; tool: string; description: string; score: number }> = [];

      for (const server of servers.values()) {
        for (const tool of server.tools) {
          const searchText = `${server.namespace} ${tool.name} ${tool.description ?? ""}`.toLowerCase();
          const score = terms.filter((term) => searchText.includes(term)).length;
          if (score > 0) {
            scored.push({
              namespace: server.namespace,
              tool: tool.name,
              description: tool.description ?? "",
              score,
            });
          }
        }
      }

      // Sort by score descending, then alphabetically
      scored.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool));

      // Only show tools that match at least half the terms (if multi-term query)
      const minScore = terms.length > 2 ? Math.ceil(terms.length / 2) : 1;
      const matches = scored.filter((m) => m.score >= minScore).slice(0, 30);

      if (matches.length === 0) {
        const uncached = [...servers.values()].filter((s) => s.tools.length === 0);
        if (uncached.length > 0) {
          return `No cached MCP tools matching "${query}".\n\nServers with unknown tools (call any tool to trigger connection): ${uncached.map((s) => s.namespace).join(", ")}`;
        }
        return `No MCP tools matching "${query}".`;
      }

      let text = `Found ${matches.length} MCP tool${matches.length === 1 ? "" : "s"} matching "${query}":\n\n`;
      for (const m of matches) {
        text += `tools.${m.namespace}.${m.tool}()\n`;
        text += `  ${m.description || "(no description)"}\n\n`;
      }
      return text.trim();
    },

    listServers() {
      return serverNames;
    },

    async shutdown() {
      await manager.closeAll();
      connectedServers.clear();
    },
  };
}

function toNamespace(serverName: string): string {
  let ns = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
  return ns || "mcp";
}
