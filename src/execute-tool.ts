// execute-tool.ts — The execute_tools tool definition.
//
// This is the single tool that replaces most of Pi's built-in tools.
// The LLM writes TypeScript code that calls tools as typed functions.

import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { executeCode, type ExecutionResult } from "./sandbox.js";
import { createToolBindings, type ToolBindingsOptions } from "./tool-bindings.js";

export interface ExecuteToolOptions {
  /** TypeScript type definitions for the tool API */
  typeDefs: string;
  /** Options for creating tool bindings */
  bindingsOptions: Omit<ToolBindingsOptions, "signal" | "onUpdate">;
  /** Max execution timeout in ms */
  timeout?: number;
  /** Max output size in bytes */
  maxOutputSize?: number;
  /** Shell command prefix prepended to every $ command (from pi's shellCommandPrefix setting) */
  shellPrefix?: string;
  /** User-configured packages to inject as globals (varName → module) */
  userPackages?: Record<string, unknown>;
  /** Disable sandbox for full system access (DANGER: code runs unsandboxed) */
  unsandboxed?: boolean;
}

/**
 * Create the execute_tools tool definition.
 */
export function createExecuteTool(
  options: ExecuteToolOptions
): ToolDefinition {
  const { typeDefs, bindingsOptions, timeout, maxOutputSize, shellPrefix, userPackages, unsandboxed } = options;

  return {
    name: "execute_tools",
    label: "Execute Tools",
    description: `Execute TypeScript code with tools.* API, $\`shell\`, and npm packages. Type-checked before execution. print() for output, return for result.`,

    parameters: Type.Object({
      code: Type.String({
        description: "TypeScript code body (async context, top-level await)",
      }),
      strings: Type.Optional(Type.Record(Type.String(), Type.String(), {
        description: "String constants available as π.keyName — for content hard to quote in JS",
      })),
    }),

    async execute(
      toolCallId: string,
      params: { code: string; strings?: Record<string, string> },
      signal: AbortSignal | undefined,
      onUpdate: any,
      ctx: ExtensionContext
    ) {
      const bindings = createToolBindings({
        ...bindingsOptions,
        signal,
        onUpdate,
      });

      const result: ExecutionResult = await executeCode(
        params.code,
        typeDefs,
        bindings,
        { timeout, maxOutputSize, cwd: bindingsOptions.cwd, signal, onUpdate, shellPrefix, userPackages, strings: params.strings, unsandboxed }
      );

      if (!result.success) {
        const errorText = result.errors
          .map((e) => (e.line > 0 ? `L${e.line}: ${e.message}` : e.message))
          .join("\n");

        const prefix = result.errorKind === 'type' ? 'Type error (not executed)' : 'Runtime error';
        let text = `${prefix}:\n${errorText}`;

        // Include any logs captured before the error (for runtime errors)
        if (result.logs.length > 0) {
          text = `Output:\n${result.logs.join("\n")}\n\n${text}`;
        }

        return {
          content: [{ type: "text" as const, text }],
          isError: true,
          details: {
            errors: result.errors,
            logs: result.logs,
            elapsedMs: result.elapsedMs,
          },
        };
      }

      // Format success
      const parts: string[] = [];

      if (result.logs.length > 0) {
        parts.push(result.logs.join("\n"));
      }

      if (result.returnValue !== undefined) {
        let formatted: string;
        if (typeof result.returnValue === "string") {
          formatted = result.returnValue;
        } else {
          // Compact JSON for small results, pretty for large ones (saves tokens)
          const compact = JSON.stringify(result.returnValue);
          formatted = compact.length > 500 ? JSON.stringify(result.returnValue, null, 2) : compact;
        }
        parts.push(formatted);
      }

      const text = parts.join("\n\n") || "(no output)";

      return {
        content: [{ type: "text" as const, text }],
        details: {
          logs: result.logs,
          returnValue: result.returnValue,
          elapsedMs: result.elapsedMs,
        },
      };
    },

    renderCall(args: { code: string; strings?: Record<string, string> }, theme: any) {
      try {
        const { highlightCode } = require("@mariozechner/pi-coding-agent");
        const { Text } = require("@mariozechner/pi-tui");
        // highlightCode returns string[] (one per line), join them
        const highlighted = highlightCode(args.code.trim(), "typescript");
        let text = Array.isArray(highlighted) ? highlighted.join("\n") : String(highlighted);
        // Show string constants if present
        if (args.strings && Object.keys(args.strings).length > 0) {
          const stringsSection = Object.entries(args.strings).map(([key, val]) => {
            const preview = val.length > 200 ? val.slice(0, 200) + "..." : val;
            return theme.fg("dim", `π.${key}`) + " = " + theme.fg("dim", JSON.stringify(preview));
          }).join("\n");
          text = theme.fg("dim", "// String constants:") + "\n" + stringsSection + "\n\n" + text;
        }
        return new Text(text, 0, 0);
      } catch {
        const { Text } = require("@mariozechner/pi-tui");
        return new Text(String(args.code ?? ""), 0, 0);
      }
    },

    renderResult(
      result: any,
      options: { expanded: boolean; isPartial: boolean },
      theme: any
    ) {
      const { Text } = require("@mariozechner/pi-tui");
      const { isPartial, expanded } = options;

      if (isPartial) {
        const msg = result.details?.progress
          ? result.content?.[0]?.text ?? "Executing..."
          : "Executing...";
        return new Text(theme.fg("warning", msg), 0, 0);
      }

      const details = result.details ?? {};
      const isError = result.isError;
      const elapsed = details.elapsedMs
        ? ` ${theme.fg("dim", `(${Math.round(details.elapsedMs)}ms)`)}`
        : "";

      if (isError) {
        const errors = details.errors ?? [];
        const firstError = errors[0]?.message ?? "Unknown error";
        if (!expanded) {
          return new Text(
            theme.fg("error", `✗ ${firstError}`) + elapsed,
            0,
            0
          );
        }
        const lines = errors
          .map(
            (e: any) =>
              theme.fg("error", e.line > 0 ? `Line ${e.line}: ` : "") +
              e.message
          )
          .join("\n");
        return new Text(lines + elapsed, 0, 0);
      }

      // Success — trim to avoid leading/trailing blank lines
      const text = (result.content?.[0]?.text ?? "(no output)").trim();
      const lineCount = text.split("\n").length;

      if (!expanded && lineCount > 5) {
        const preview = text.split("\n").slice(0, 3).join("\n");
        return new Text(
          theme.fg("success", "✓ ") +
            preview +
            theme.fg("dim", `\n... ${lineCount - 3} more lines`) +
            elapsed,
          0,
          0
        );
      }

      return new Text(
        theme.fg("success", "✓ ") + text + elapsed,
        0,
        0
      );
    },
  } as unknown as ToolDefinition;
}
