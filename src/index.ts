// index.ts — Pi Code Mode extension entry point.
//
// Replaces Pi's tools with a single execute_tools tool that runs
// TypeScript code against typed tool APIs.
//
// MCP integration:
// - Tool metadata loaded from pi-mcp-adapter's cache (instant, no connections)
// - Full type signatures used by the type checker (catches wrong args)
// - Compact summary shown in system prompt (progressive disclosure)
// - Servers connect lazily on first actual tool call
//
// Search: MiniSearch FTS over all Pi + MCP tools (fuzzy, prefix, BM25 ranked)

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { initTypeChecker } from "./type-checker.js";
import {
  generateBuiltinTypeDefs,
  generateMcpServerTypeDefs,
  generateMcpSummaryForPrompt,
  generatePackageTypeDefs,
} from "./type-generator.js";
import { generateSystemPromptAddition } from "./system-prompt.js";
import { createExecuteTool } from "./execute-tool.js";
import { createMcpClient, type McpClient } from "./mcp-client.js";
import { buildSearchIndex } from "./search.js";
import { loadUserPackages, type ResolvedPackage } from "./package-resolver.js";
import { loadPackageTypes } from "./type-checker.js";

export default function codeMode(pi: ExtensionAPI) {
  // --- Configuration ---

  pi.registerFlag("no-codemode", {
    description: "Disable code mode (use normal tools)",
    type: "boolean",
    default: false,
  });

  // --- State ---

  let enabled = true;
  let originalTools: string[] = [];
  const builtinTypeDefs = generateBuiltinTypeDefs();
  let mcpClient: McpClient | undefined;

  // Initialize the TypeScript type checker (pre-loads lib files, ~50ms)
  initTypeChecker();

  // Initialize MCP client — reads config + cache, no connections
  try {
    mcpClient = createMcpClient();
    if (mcpClient.available) {
      const servers = mcpClient.getServers();
      const totalTools = servers.reduce((sum, s) => sum + s.tools.length, 0);

    }
  } catch (e: any) {
    console.warn(`Code Mode: MCP init failed: ${e.message}`);
  }

  // --- Load user-configured packages ---
  // Reads ~/.pi/agent/codemode.json (global) and .pi/codemode.json (project),
  // auto-installs into dedicated directories, and resolves modules.
  let userPackages: ResolvedPackage[] = [];
  let userPackageMap: Record<string, unknown> = {};
  try {
    const { packages, warnings } = loadUserPackages(process.cwd());
    userPackages = packages;
    userPackageMap = Object.fromEntries(packages.map(p => [p.varName, p.module]));
    for (const w of warnings) {
      console.warn(`Code Mode: ${w}`);
    }
    if (packages.length > 0) {
      // Load type definitions for packages that have them
      loadPackageTypes(packages);
    }
  } catch (e: any) {
    console.warn(`Code Mode: Failed to load user packages: ${e.message}`);
  }

  // Build type checker types: built-in + full MCP types + user package types
  const mcpServers = mcpClient?.getServers() ?? [];
  const mcpTypeDefs = generateMcpServerTypeDefs(mcpServers);
  const packageTypeDefs = generatePackageTypeDefs(userPackages);
  const typeCheckerTypeDefs = builtinTypeDefs + "\n" + mcpTypeDefs + "\n" + packageTypeDefs;

  // Build system prompt summary: compact MCP listing (not full types)
  const mcpSummary = generateMcpSummaryForPrompt(mcpServers);
  const userPackageInfo = userPackages.map(p => ({ varName: p.varName, specifier: p.specifier, description: p.description }));

  // --- Read shell command prefix from pi settings ---
  // This prefix (e.g., "export TERM=dumb CI=true ...") is prepended to every
  // shell command, matching pi's built-in bash tool behavior.
  let shellPrefix: string | undefined;
  try {
    const settings = SettingsManager.create();
    shellPrefix = settings.getShellCommandPrefix();
  } catch {
    // Settings not available — no prefix
  }

  // --- Register the execute_tools tool ---

  const executeTool = createExecuteTool({
    typeDefs: typeCheckerTypeDefs,
    bindingsOptions: {
      cwd: process.cwd(),
      mcpClient,
    },
    shellPrefix,
    userPackages: userPackageMap,
  });

  pi.registerTool(executeTool);

  // --- Session lifecycle ---

  pi.on("session_start", async (_event, ctx) => {
    const noCodemode = pi.getFlag("no-codemode") as boolean;
    if (noCodemode) {
      enabled = false;
      ctx.ui.notify("Code mode disabled via --no-codemode", "info");
      return;
    }

    // Store original tool set for toggling
    originalTools = pi.getActiveTools();

    // Build FTS index over all Pi tools + MCP tools
    const piTools = pi.getAllTools().map((t) => ({
      name: t.name,
      description: t.description,
    }));
    buildSearchIndex(piTools, mcpClient, userPackages.map(p => ({
      varName: p.varName,
      specifier: p.specifier,
      description: p.description,
    })));

    // Activate code mode: only execute_tools visible to LLM
    activateCodeMode();


  });

  // --- Shutdown ---

  pi.on("session_shutdown", async () => {
    if (mcpClient) {
      await mcpClient.shutdown();
    }
  });

  // --- System prompt injection ---

  pi.on("before_agent_start", async (event) => {
    if (!enabled) return;

    const addition = generateSystemPromptAddition(builtinTypeDefs, mcpSummary, userPackageInfo);
    return {
      systemPrompt: event.systemPrompt + "\n\n" + addition,
    };
  });

  // --- Toggle command ---

  pi.registerCommand("codemode", {
    description: "Toggle code mode on/off",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (enabled) {
        activateCodeMode();

        ctx.ui.notify("Code mode enabled", "info");
      } else {
        deactivateCodeMode();

        ctx.ui.notify("Code mode disabled — all tools available", "info");
      }
    },
  });

  // --- Helpers ---

  function activateCodeMode() {
    pi.setActiveTools(["execute_tools"]);
    enabled = true;
  }

  function deactivateCodeMode() {
    if (originalTools.length > 0) {
      pi.setActiveTools(originalTools);
    }
    enabled = false;
  }
}