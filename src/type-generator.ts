// type-generator.ts — Generate TypeScript type definitions for the tool API.
//
// Three outputs:
// 1. Built-in tool types (read, write, search_tools, progress) + zx shell — hand-crafted
// 2. MCP server types — full typed interfaces from JSON Schema (for type checker)
// 3. MCP server summary — compact server/tool listing (for system prompt)

import type { McpServerInfo } from "./mcp-client.js";

/**
 * Generate the type definition string for built-in tools.
 * MCP server namespaces are injected separately via generateMcpServerTypeDefs().
 */
export function generateBuiltinTypeDefs(): string {
  return `\
/** Tool API available inside execute_tools code blocks. */
declare const tools: BuiltinTools & McpServerNamespaces;

interface BuiltinTools {
  /**
   * Read a file and return its content as a string.
   * Each line is prefixed with line number and hash for reference.
   * Default limit: 2000 lines or 50KB.
   */
  read(params: {
    /** Path to the file (relative or absolute) */
    path: string;
    /** Line number to start from (1-indexed) */
    offset?: number;
    /** Maximum lines to read */
    limit?: number;
  }): Promise<string>;

  /**
   * Write content to a file. Creates parent directories automatically.
   * Overwrites the file if it already exists.
   */
  write(params: {
    /** Path to the file (relative or absolute) */
    path: string;
    /** Content to write */
    content: string;
  }): Promise<void>;

  /**
   * Edit a file by finding and replacing exact text.
   * The oldText must match exactly (including whitespace).
   * Returns a success message. Throws if text not found or ambiguous.
   */
  edit(params: {
    /** Path to the file to edit (relative or absolute) */
    path: string;
    /** Exact text to find and replace (must match exactly) */
    oldText: string;
    /** New text to replace the old text with */
    newText: string;
  }): Promise<string>;

  /**
   * Search for tools by name or description.
   * Returns matching tool names, descriptions, and call signatures.
   */
  search_tools(params: {
    /** Search query — matches tool names, descriptions, and parameter names */
    query: string;
  }): Promise<string>;

  /**
   * Browse available tools. Two modes:
   * - List tools in a namespace: describe_tools({ namespace: "slack" })
   * - Show a tool's full parameters: describe_tools({ namespace: "slack", tool: "channels_me" })
   */
  describe_tools(params: {
    /** MCP server namespace (e.g. "slack", "things", "google_workspace") */
    namespace: string;
    /** Tool name to get full parameter details. Omit to list all tools in the namespace. */
    tool?: string;
  }): Promise<string>;

  /** Report progress to the user (streamed to UI in real-time). */
  progress(message: string): void;
}

/** Print output to include in the result returned to you. */
declare function print(...args: any[]): void;

// --- zx shell scripting (resolved from real zx .d.ts via module resolution) ---

import type { ProcessPromise, ProcessOutput, $ as Shell } from 'zx';
import type { cd as CdFn, within as WithinFn, kill as KillFn, quote as QuoteFn, quotePowerShell as QuotePowerShellFn } from 'zx';
import type { sleep as SleepFn, retry as RetryFn, spinner as SpinnerFn, echo as EchoFn, stdin as StdinFn } from 'zx';
import type { glob as GlobFn } from 'zx';
import type { chalk as ChalkInstance } from 'zx';
import type { nothrow as NothrowFn, quiet as QuietFn } from 'zx';

/** zx shell command — execute shell commands with template literals. Arguments are automatically escaped for safety. */
declare const $: typeof Shell;

/** Change the current working directory for subsequent $ commands. */
declare const cd: typeof CdFn;

/** Run callback in an isolated zx context (separate cwd, env, etc). */
declare const within: typeof WithinFn;

/** Suppress errors from a process — returns the ProcessOutput even on non-zero exit. */
declare const nothrow: typeof NothrowFn;

/** Suppress stdout output from a process. */
declare const quiet: typeof QuietFn;

/** Retry a function with exponential backoff. */
declare const retry: typeof RetryFn;

/** Sleep for a given duration (ms or string like '5s'). */
declare const sleep: typeof SleepFn;

/** chalk — terminal string styling. */
declare const chalk: typeof ChalkInstance;

/** Find the path of an executable. */
declare function which(cmd: string): Promise<string>;

/** Escape a string for safe shell use. */
declare const quote: typeof QuoteFn;

/** Find files using glob patterns. */
declare const glob: typeof GlobFn;

/** Node.js os module. */
declare const os: typeof import('os');

/** Node.js path module. */
declare const path: typeof import('path');

/** Node.js fs-extra module (fs + extra utilities). */
declare const fs: typeof import('fs-extra');

// Re-export types so user code can reference ProcessOutput/ProcessPromise by name
type _ProcessOutput = ProcessOutput;
type _ProcessPromise = ProcessPromise;
// Fix zx's ProcessPromise.then() — upstream defaults E to ProcessOutput instead of never,
// which pollutes the resolved type when using .then() without an onrejected handler.
// This matches standard Promise semantics and our sandbox wrapper's runtime behavior.
declare module 'zx' {
  interface ProcessPromise {
    then<R = ProcessOutput, E = never>(
      onfulfilled?: ((value: ProcessOutput) => PromiseLike<R> | R) | undefined | null,
      onrejected?: ((reason: ProcessOutput) => PromiseLike<E> | E) | undefined | null
    ): Promise<R | E>;
  }
}

/** Named string constants passed via the 'strings' parameter. Use for file content that's hard to quote in JS. */
declare const π: Readonly<Record<string, string>>;
`;
}

/**
 * Generate full TypeScript declarations for MCP server namespaces.
 * Used by the TYPE CHECKER — includes all tool signatures from inputSchema.
 * This is NOT injected into the system prompt (too large).
 */
export function generateMcpServerTypeDefs(servers: McpServerInfo[]): string {
  if (servers.length === 0) {
    return `\
/** No MCP servers are configured. */
interface McpServerNamespaces {}
`;
  }

  const parts: string[] = [];

  // Generate the McpServerNamespaces interface
  parts.push(`interface McpServerNamespaces {`);
  for (const server of servers) {
    parts.push(`  /** MCP server: ${server.serverName} (${server.tools.length} tools) */`);
    parts.push(`  ${server.namespace}: ${serverInterfaceName(server.namespace)};`);
  }
  parts.push(`}`);
  parts.push(``);

  // Generate each server's interface with typed tool methods
  for (const server of servers) {
    const ifaceName = serverInterfaceName(server.namespace);
    parts.push(`interface ${ifaceName} {`);
    for (const tool of server.tools) {
      if (tool.description) {
        // Escape JSDoc-breaking chars
        const desc = tool.description.replace(/\*\//g, "* /").replace(/\n/g, " ");
        parts.push(`  /** ${desc} */`);
      }
      const paramsType = tool.inputSchema
        ? jsonSchemaToTypeString(tool.inputSchema, "  ")
        : "Record<string, unknown>";
      const safeName = safePropName(tool.name);
      const argsOptional = !hasRequiredProperties(tool.inputSchema);
      parts.push(`  ${safeName}(args${argsOptional ? "?" : ""}: ${paramsType}): Promise<string>;`);
    }
    parts.push(`}`);
    parts.push(``);
  }

  return parts.join("\n");
}

/**
 * Generate a compact MCP server summary for the system prompt.
 * Lists server namespaces only — the LLM uses describe_tools() and search_tools() for details.
 */
export function generateMcpSummaryForPrompt(servers: McpServerInfo[]): string {
  if (servers.length === 0) return "";

  const lines: string[] = [];
  lines.push(`### MCP Servers`);
  lines.push(``);
  lines.push(`The following MCP servers are available as typed namespaces on \`tools\`.`);
  lines.push(`Use \`describe_tools\` to browse tools in a namespace and see their parameters.`);
  lines.push(`Use \`search_tools\` to find tools by keyword across all servers.`);
  lines.push(``);

  for (const server of servers) {
    const count = server.tools.length;
    if (count === 0) {
      lines.push(`- **tools.${server.namespace}** — ${server.serverName} (connect on first call)`);
    } else {
      lines.push(`- **tools.${server.namespace}** — ${server.serverName} (${count} tools)`);
    }
  }

  return lines.join("\n");
}

function serverInterfaceName(namespace: string): string {
  const pascal = namespace
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return `Mcp${pascal}Tools`;
}

/**
 * Generate a TypeScript call signature for a single MCP tool.
 * Used by describe_tools and MCP error messages.
 */
export function generateToolSignature(
  namespace: string,
  toolName: string,
  description: string | undefined,
  inputSchema: unknown
): string {
  const lines: string[] = [];
  if (description) {
    lines.push(`/** ${description.replace(/\*\//g, "* /").replace(/\n/g, " ")} */`);
  }
  const paramsType = inputSchema
    ? jsonSchemaToTypeString(inputSchema, "")
    : "Record<string, unknown>";
  const argsOptional = !hasRequiredProperties(inputSchema);
  lines.push(`tools.${namespace}.${toolName}(args${argsOptional ? "?" : ""}: ${paramsType}): Promise<string>`);
  return lines.join("\n");
}

/**
 * Generate a compact parameter summary for MCP error messages.
 * Shows required and optional params with types.
 */
export function generateParamSummary(inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== "object") return "No parameters defined.";
  const s = inputSchema as Record<string, unknown>;
  if (s.type !== "object" || !s.properties || typeof s.properties !== "object") {
    return "No parameters defined.";
  }
  const props = s.properties as Record<string, Record<string, unknown>>;
  const required = Array.isArray(s.required) ? (s.required as string[]) : [];
  const entries = Object.entries(props);
  if (entries.length === 0) return "No parameters defined.";

  const lines: string[] = ["Parameters:"];
  for (const [name, prop] of entries) {
    const isReq = required.includes(name);
    const type = jsonSchemaToTypeString(prop, "  ");
    let line = `  ${name}${isReq ? " (required)" : ""}: ${type}`;
    if (prop.description) {
      line += ` — ${String(prop.description).replace(/\n/g, " ")}`;
    }
    if (prop.enum && Array.isArray(prop.enum)) {
      line += ` [values: ${prop.enum.map((v: unknown) => JSON.stringify(v)).join(", ")}]`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/**
 * Auto-generate a TypeScript type definition from a JSON Schema.
 */
export function generateMcpTypeDef(
  toolName: string,
  description: string,
  inputSchema: unknown
): string {
  const lines: string[] = [];

  if (description) {
    lines.push(`/** ${description} */`);
  }

  const params = jsonSchemaToTypeString(inputSchema);
  lines.push(
    `declare function ${sanitizeIdentifier(toolName)}(params: ${params}): Promise<unknown>;`
  );

  return lines.join("\n");
}

/**
 * Convert a JSON Schema to a TypeScript type string.
 */
function jsonSchemaToTypeString(schema: unknown, indent: string = ""): string {
  if (!schema || typeof schema !== "object") return "Record<string, unknown>";

  const s = schema as Record<string, unknown>;

  // Object with properties
  if (s.type === "object" && s.properties && typeof s.properties === "object") {
    const props = s.properties as Record<string, unknown>;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    const entries = Object.entries(props);

    if (entries.length === 0) return "{}";

    const nextIndent = indent + "  ";
    const propLines: string[] = [];

    for (const [name, propSchema] of entries) {
      const isRequired = required.includes(name);
      const propType = jsonSchemaToTypeString(propSchema, nextIndent);
      const desc = getDescription(propSchema);
      if (desc) {
        // Escape JSDoc-breaking chars
        const safeDesc = desc.replace(/\*\//g, "* /").replace(/\n/g, " ");
        propLines.push(`${nextIndent}/** ${safeDesc} */`);
      }
      const opt = isRequired ? "" : "?";
      propLines.push(`${nextIndent}${safePropName(name)}${opt}: ${propType};`);
    }

    return `{\n${propLines.join("\n")}\n${indent}}`;
  }

  // Array
  if (s.type === "array") {
    const itemType = s.items
      ? jsonSchemaToTypeString(s.items, indent)
      : "unknown";
    return `${itemType}[]`;
  }

  // Enum
  if (Array.isArray(s.enum)) {
    return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  // Union types (anyOf/oneOf)
  if (Array.isArray(s.anyOf)) {
    return s.anyOf
      .map((sub) => jsonSchemaToTypeString(sub, indent))
      .join(" | ");
  }
  if (Array.isArray(s.oneOf)) {
    return s.oneOf
      .map((sub) => jsonSchemaToTypeString(sub, indent))
      .join(" | ");
  }

  // Primitive types
  if (s.type === "string") return "string";
  if (s.type === "number" || s.type === "integer") return "number";
  if (s.type === "boolean") return "boolean";
  if (s.type === "null") return "null";

  // Array of types
  if (Array.isArray(s.type)) {
    return s.type.map((t) => jsonSchemaToTypeString({ type: t }, indent)).join(" | ");
  }

  return "unknown";
}

/**
 * Check if a JSON Schema has any required properties.
 * Returns false for undefined/null/empty schemas or schemas with no required array.
 */
function hasRequiredProperties(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const s = schema as Record<string, unknown>;
  return Array.isArray(s.required) && s.required.length > 0;
}

function getDescription(schema: unknown): string | undefined {
  if (schema && typeof schema === "object" && "description" in schema) {
    return (schema as { description?: string }).description;
  }
  return undefined;
}

function sanitizeIdentifier(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

function safePropName(name: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return name;
  return JSON.stringify(name);
}

/**
 * Generate TypeScript type declarations for user-configured packages.
 *
 * For packages with types: generates import + declare const referencing the real types.
 * For packages without types: generates declare const as any.
 */
export function generatePackageTypeDefs(
  packages: Array<{ specifier: string; varName: string; hasTypes: boolean }>
): string {
  if (packages.length === 0) return "";

  const lines: string[] = [];
  lines.push("// --- User-configured packages ---");
  lines.push("");

  for (const pkg of packages) {
    if (pkg.hasTypes) {
      // Import the real types so the type checker can validate usage
      const importName = `_pkg_${sanitizeIdentifier(pkg.varName)}`;
      lines.push(`import type * as ${importName} from '${pkg.specifier}';`);
      lines.push(`declare const ${pkg.varName}: typeof ${importName};`);
    } else {
      // No types available — expose as any
      lines.push(`declare const ${pkg.varName}: any;`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
