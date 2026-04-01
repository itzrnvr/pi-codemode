// tool-bindings.ts — Create runtime bindings that back the TypeScript type declarations.
//
// Each binding wraps a real Pi tool implementation and returns simplified values:
// - read → string (the file content)
// - write → void
// - tools.<server>.<tool>(args) → string (MCP tools as per-server namespaces)
// - search_tools → string (FTS via MiniSearch)
// - progress → void (streams to UI)
//
// Shell commands are handled by zx's $ (exposed directly in the sandbox),
// not through a tools.bash() binding.

import {
  createReadTool,
  createWriteTool,
  createEditTool,
} from "@mariozechner/pi-coding-agent";
import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { McpClient } from "./mcp-client.js";
import { searchTools } from "./search.js";
import { generateToolSignature } from "./type-generator.js";

/** The shape the sandbox code sees at runtime — base tools */
export interface ToolBindings {
  read(params: {
    path: string;
    offset?: number;
    limit?: number;
  }): Promise<string>;

  write(params: { path: string; content: string }): Promise<void>;

  edit(params: {
    path: string;
    oldText: string;
    newText: string;
  }): Promise<string>;

  search_tools(params: { query: string }): Promise<string>;

  describe_tools(params: { namespace: string; tool?: string }): Promise<string>;

  progress(message: string): void;

  /** MCP server namespaces are added dynamically as tools.<namespace>.<tool>(args) */
  [serverNamespace: string]: unknown;
}

export interface ToolBindingsOptions {
  cwd: string;
  /** MCP client for proxying MCP tool calls */
  mcpClient?: McpClient;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback for streaming progress to the UI */
  onUpdate?: AgentToolUpdateCallback;
}

/**
 * Create the tool binding functions for the sandbox.
 */
export function createToolBindings(options: ToolBindingsOptions): ToolBindings {
  const { cwd, mcpClient, signal, onUpdate } = options;

  // Create fresh tool instances for the current cwd
  const readTool = createReadTool(cwd);
  const writeTool = createWriteTool(cwd);
  const editTool = createEditTool(cwd);

  const toolCallId = `codemode-${Date.now()}`;

  const bindings: ToolBindings = {
    async read(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      const result = await readTool.execute(toolCallId, params, signal);
      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return text;
    },

    async write(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      await writeTool.execute(toolCallId, params, signal);
    },

    async edit(params) {
      if (signal?.aborted) throw new Error("Execution cancelled");
      const result = await editTool.execute(toolCallId, params, signal);
      const text = result.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return text;
    },

    async search_tools(params) {
      return searchTools(params.query);
    },

    async describe_tools(params) {
      if (!mcpClient?.available) {
        return "No MCP servers available.";
      }
      const servers = mcpClient.getServers();
      const server = servers.find((s) => s.namespace === params.namespace);
      if (!server) {
        const available = servers.map((s) => s.namespace).join(", ");
        return `Unknown namespace "${params.namespace}". Available: ${available}`;
      }
      if (!params.tool) {
        // List all tools in this namespace
        if (server.tools.length === 0) {
          return `tools.${server.namespace} has no cached tools. Call any tool to trigger a connection.`;
        }
        let text = `tools.${server.namespace} — ${server.tools.length} tools:\n\n`;
        for (const t of server.tools) {
          text += `  ${t.name}`;
          if (t.description) {
            const short = t.description.length > 120 ? t.description.slice(0, 120) + "..." : t.description;
            text += ` — ${short}`;
          }
          text += "\n";
        }
        return text.trimEnd();
      }
      // Describe a specific tool with full TypeScript signature
      const tool = server.tools.find((t) => t.name === params.tool);
      if (!tool) {
        const names = server.tools.map((t) => t.name).join(", ");
        return `Unknown tool "${params.tool}" in tools.${server.namespace}. Available: ${names}`;
      }
      return generateToolSignature(server.namespace, tool.name, tool.description, tool.inputSchema);
    },
    progress(message: string) {
      if (onUpdate) {
        onUpdate({
          content: [{ type: "text", text: message }],
          details: { progress: true },
        });
      }
    },
  };

  // Add per-server MCP namespaces as proxy objects
  // e.g., tools.slack = { channels_me(args) { ... }, ... }
  // Built from cache info — mcpClient.call() lazy-connects on first use
  if (mcpClient?.available) {
    for (const server of mcpClient.getServers()) {
      const serverProxy: Record<string, (args?: Record<string, unknown>) => Promise<string>> = {};

      for (const tool of server.tools) {
        serverProxy[tool.name] = async (args?: Record<string, unknown>) => {
          if (signal?.aborted) throw new Error("Execution cancelled");
          return mcpClient.call(server.namespace, tool.name, args);
        };
      }

      // Also add a Proxy fallback so uncached tool names still work
      // (they'll fail at runtime with a clear error from the server)
      bindings[server.namespace] = new Proxy(serverProxy, {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          // Return a function that attempts the call (will lazy-connect)
          return async (args?: Record<string, unknown>) => {
            if (signal?.aborted) throw new Error("Execution cancelled");
            return mcpClient.call(server.namespace, prop, args);
          };
        },
      });
    }
  }

  return bindings;
}