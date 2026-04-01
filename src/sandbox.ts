// sandbox.ts — Execute LLM-generated code in a Node.js vm context.
//
// Pipeline: type-check → esbuild strip types → vm.runInContext
// The vm provides a clean namespace with only our tool bindings and safe globals.
//
// Shell commands use zx's $ directly (no tools.bash wrapper).
// The $ instance is pre-configured with the working directory, abort signal,
// and output truncation (tail-truncate to last 2000 lines / 50KB).

import vm from "node:vm";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transformSync } from "esbuild";
import { typeCheck, type TypeCheckError } from "./type-checker.js";
import type { ToolBindings } from "./tool-bindings.js";
import * as zx from "zx";

// Suppress zx's default verbose logging (prints commands to stderr)
zx.$.verbose = false;
export interface ExecutionResult {
  success: boolean;
  /** Type errors or runtime errors */
  errors: TypeCheckError[];
  /** 'type' for type-check failures, 'runtime' for execution errors */
  errorKind?: 'type' | 'runtime';
  /** Captured console.log / print output */
  logs: string[];
  /** The return value of the code (if any) */
  returnValue: unknown;
  /** Execution time in ms */
  elapsedMs: number;
}

export interface SandboxOptions {
  /** Max execution time in ms (default: 120_000 = 2 minutes) */
  timeout?: number;
  /** Max output size in bytes (default: 50KB) */
  maxOutputSize?: number;
  /** Working directory for shell commands (default: process.cwd()) */
  cwd?: string;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback for streaming progress updates to the UI */
  onUpdate?: (update: { content: Array<{ type: string; text: string }>; details?: any }) => void;
  /** Shell command prefix prepended to every $ command (from pi's shellCommandPrefix setting) */
  shellPrefix?: string;
  /** User-configured packages to inject as globals (varName → module) */
  userPackages?: Record<string, unknown>;
  /** Named string constants injected as π.keyName — for file content that's hard to quote in JS */
  strings?: Record<string, string>;
  /** Disable sandbox and run code with full Node.js access (DANGER: LLM code runs unsandboxed) */
  unsandboxed?: boolean;
}

const DEFAULT_TIMEOUT = 120_000;
const DEFAULT_MAX_OUTPUT = 50 * 1024;

/** Max lines to keep from command output (tail truncation, matching pi's bash tool) */
const MAX_OUTPUT_LINES = 2000;
/** Max bytes to keep from command output */
const MAX_OUTPUT_BYTES = 50 * 1024;

/**
 * Generate a unique temp file path for storing full command output.
 */
function getTempFilePath(): string {
  const id = randomBytes(8).toString("hex");
  return path.join(tmpdir(), `pi-codemode-${id}.log`);
}

/**
 * Sanitize binary/control characters from command output.
 * Strips characters that crash string-width or cause TUI display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Unicode Format characters (crash string-width)
 * - Characters with undefined code points
 * Lone surrogates are handled by Array.from() which replaces them.
 */
function sanitizeOutput(str: string): string {
  return Array.from(str)
    .filter((char) => {
      const code = char.codePointAt(0);
      if (code === undefined) return false;
      // Allow tab, newline, carriage return
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      // Filter control characters (0x00-0x1F)
      if (code <= 0x1f) return false;
      // Filter Unicode format characters (crash string-width)
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

/**
 * Truncate a string from the end of a byte buffer, keeping maxBytes from the tail.
 * Handles multi-byte UTF-8 characters correctly by finding a valid character boundary.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;

  let start = buf.length - maxBytes;
  // Advance to a valid UTF-8 character boundary
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return buf.slice(start).toString("utf-8");
}

interface TruncationResult {
  /** The (possibly truncated) text */
  text: string;
  /** Whether truncation occurred */
  wasTruncated: boolean;
  /** Path to temp file with full output (only if truncated) */
  fullOutputPath?: string;
}

/**
 * Truncate a string from the tail (keep the last N lines / bytes).
 * Matches the behavior of pi's built-in bash tool:
 * - Tail truncation: keeps last 2000 lines or 50KB
 * - Edge case: if a single line exceeds the byte limit, keeps the tail bytes of that line
 * - Writes full output to a temp file when truncated
 * - Includes actionable notice with line range and temp file path
 * - Sanitizes binary/control characters
 */
function truncateFromTail(rawText: string): TruncationResult {
  // Sanitize binary/control characters first
  const text = sanitizeOutput(rawText);

  const totalBytes = Buffer.byteLength(text, "utf-8");
  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalLines <= MAX_OUTPUT_LINES && totalBytes <= MAX_OUTPUT_BYTES) {
    return { text, wasTruncated: false };
  }

  // Write full output to temp file before truncating
  const fullOutputPath = getTempFilePath();
  try {
    writeFileSync(fullOutputPath, text, "utf-8");
  } catch {
    // If we can't write the temp file, continue without it
  }

  // Work backwards, keeping lines that fit within both limits
  const kept: string[] = [];
  let keptBytes = 0;

  for (let i = lines.length - 1; i >= 0 && kept.length < MAX_OUTPUT_LINES; i--) {
    const lineBytes = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0);
    if (keptBytes + lineBytes > MAX_OUTPUT_BYTES) {
      // Edge case: if we haven't kept ANY lines yet and this single line exceeds
      // the byte limit, keep the tail bytes of this line (partial truncation)
      if (kept.length === 0) {
        const partialLine = truncateStringToBytesFromEnd(lines[i], MAX_OUTPUT_BYTES);
        kept.unshift(partialLine);
        keptBytes = Buffer.byteLength(partialLine, "utf-8");
      }
      break;
    }
    kept.unshift(lines[i]);
    keptBytes += lineBytes;
  }

  const startLine = totalLines - kept.length + 1;
  const endLine = totalLines;
  let notice: string;
  if (kept.length === 1 && kept[0] !== lines[totalLines - 1]) {
    // Partial single-line case
    const keptSize = formatSize(keptBytes);
    const fullSize = formatSize(totalBytes);
    notice = `\n\n[Showing last ${keptSize} of line ${endLine} (${fullSize} total). Full output: ${fullOutputPath}]`;
  } else {
    notice = `\n\n[Showing lines ${startLine}-${endLine} of ${totalLines}. Full output: ${fullOutputPath}]`;
  }

  return {
    text: kept.join("\n") + notice,
    wasTruncated: true,
    fullOutputPath,
  };
}

/**
 * Format bytes as human-readable size.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * String methods that should be forwarded to the full text when accessed
 * on a TruncatedString. These methods may be used by the LLM to extract
 * specific portions of command output (e.g., `.slice(-500)`, `.split('\n')`).
 */
const FORWARDED_STRING_METHODS = new Set([
  'slice', 'substring', 'substr', 'split', 'match', 'matchAll',
  'search', 'replace', 'replaceAll', 'indexOf', 'lastIndexOf',
  'includes', 'startsWith', 'endsWith', 'charAt', 'charCodeAt',
  'codePointAt', 'at', 'trim', 'trimStart', 'trimEnd',
  'padStart', 'padEnd', 'repeat', 'normalize',
  'toUpperCase', 'toLowerCase', 'toLocaleLowerCase', 'toLocaleUpperCase',
]);

/**
 * Create a string-like Proxy that operates on full text for string methods
 * but returns truncated text when serialized.
 *
 * This solves the problem where the LLM proactively limits output with patterns
 * like `result.stdout.slice(-500)` — without this, `.slice(-500)` would operate
 * on the truncated text (which includes a "[Showing lines...]" notice at the end),
 * giving the LLM the notice instead of the actual data.
 *
 * Behavior:
 * - String methods (.slice, .split, .includes, etc.) → operate on full text
 * - Serialization (toString, valueOf, template literals, JSON.stringify) → truncated text
 * - Numeric index access ([0], [1], etc.) → full text
 * - .length → full text length
 *
 * The returned Proxy has typeof "object" (not "string"), but this is acceptable
 * because LLMs rarely check typeof on stdout — they just use it as a string.
 */
function createTruncatedString(fullText: string, truncatedText: string): string {
  // Use a plain object as the proxy target to avoid String's
  // non-configurable 'length' property constraint
  const target = {} as Record<string | symbol, unknown>;

  return new Proxy(target, {
    get(_target, prop, _receiver) {
      // .length → full text
      if (prop === 'length') return fullText.length;

      // String methods → forward to full text
      if (typeof prop === 'string' && FORWARDED_STRING_METHODS.has(prop)) {
        return (...args: unknown[]) => (fullText as any)[prop](...args);
      }

      // Numeric index access → full text
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        return fullText[Number(prop)];
      }

      // Serialization → truncated text
      if (prop === 'toString' || prop === 'valueOf') {
        return () => truncatedText;
      }
      if (prop === Symbol.toPrimitive) {
        return () => truncatedText;
      }
      if (prop === 'toJSON') {
        return () => truncatedText;
      }

      // Iteration → full text
      if (prop === Symbol.iterator) {
        return function*() { yield* fullText; };
      }

      if (prop === Symbol.toStringTag) return 'String';

      return undefined;
    },

    has(_target, prop) {
      // Support 'in' operator for numeric indices
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        return Number(prop) < fullText.length;
      }
      return prop === 'length' || prop === 'toString' || prop === 'valueOf'
        || (typeof prop === 'string' && FORWARDED_STRING_METHODS.has(prop));
    },
  }) as unknown as string;
}

/**
 * Wrap a ProcessOutput in a Proxy that returns TruncatedString for stdout/stderr/stdall.
 *
 * zx defines stdout/stderr/stdall as non-configurable lazy getters on ProcessOutput,
 * so we can't redefine them with Object.defineProperty. Instead we use a Proxy that
 * intercepts property access and returns TruncatedString values for those three properties.
 *
 * The TruncatedString objects are string-like proxies that:
 * - Return truncated text when serialized (toString, template literals, JSON.stringify)
 * - Forward string methods (.slice, .split, etc.) to the full text
 *
 * This means `result.stdout.slice(-500)` returns the last 500 chars of the FULL output,
 * while `print(result.stdout)` or `return result.stdout` returns the truncated output.
 */
function truncateProcessOutput(output: zx.ProcessOutput): zx.ProcessOutput {
  // Access raw values (triggers the lazy join from buffer chunks)
  const rawStdout = output.stdout;
  const rawStderr = output.stderr;
  const rawStdall = output.stdall;

  const truncStdout = truncateFromTail(rawStdout);
  const truncStderr = truncateFromTail(rawStderr);
  const truncStdall = truncateFromTail(rawStdall);

  // Short-circuit if nothing was truncated (sanitization may still differ)
  if (!truncStdout.wasTruncated && !truncStderr.wasTruncated) {
    // Even if not truncated, sanitization may have changed the text
    if (truncStdout.text === rawStdout && truncStderr.text === rawStderr) {
      return output;
    }
  }

  // Build TruncatedString proxies: string methods use full text, serialization uses truncated
  const stdoutStr = truncStdout.wasTruncated
    ? createTruncatedString(sanitizeOutput(rawStdout), truncStdout.text)
    : truncStdout.text;
  const stderrStr = truncStderr.wasTruncated
    ? createTruncatedString(sanitizeOutput(rawStderr), truncStderr.text)
    : truncStderr.text;
  const stdallStr = truncStdall.wasTruncated
    ? createTruncatedString(sanitizeOutput(rawStdall), truncStdall.text)
    : truncStdall.text;

  // Return a Proxy that intercepts stdout/stderr/stdall access
  return new Proxy(output, {
    get(target, prop, receiver) {
      if (prop === 'stdout') return stdoutStr;
      if (prop === 'stderr') return stderrStr;
      if (prop === 'stdall') return stdallStr;
      return Reflect.get(target, prop, receiver);
    }
  });
}

/**
 * Create a $ that pre-configures cwd + signal, truncates output, and streams
 * partial output to the UI via onUpdate.
 *
 * Wraps zx's Shell so that:
 * - Resolved ProcessOutput objects have stdout/stderr/stdall tail-truncated
 * - As commands run, partial output is streamed to the UI via onUpdate
 * - cwd and abort signal are pre-configured
 */
function createTruncating$(
  cwd: string,
  signal?: AbortSignal,
  onUpdate?: SandboxOptions["onUpdate"],
  shellPrefix?: string
) {
  const opts: Record<string, unknown> = { cwd };
  if (signal) opts.signal = signal;

  // zx defaults to bash with "set -euo pipefail;" prefix on all platforms.
  // On Windows, zx automatically finds and uses Git Bash (bash.exe).
  // We only need to customize the prefix if the user provided a shellPrefix.
  // Do NOT override shell on Windows - zx's bash default works correctly.
  if (shellPrefix) {
    const normalized = shellPrefix.trimEnd().replace(/;$/, "");
    // Prefix is always bash syntax since zx uses bash on all platforms
    opts.prefix = `set -euo pipefail; ${normalized}; `;
  }

  // Hook into zx's log system to stream partial output to the UI.
  // zx calls $.log({ kind: "stdout", data: Buffer }) for each chunk of output.
  // We accumulate a rolling buffer and send truncated snapshots via onUpdate.
  if (onUpdate) {
    const streamChunks: Buffer[] = [];
    let streamBytes = 0;
    const maxStreamBytes = MAX_OUTPUT_BYTES * 2; // keep 2x for truncation headroom

    opts.log = (entry: any) => {
      if (entry.kind === "stdout" || entry.kind === "stderr") {
        const data = entry.data as Buffer;
        streamChunks.push(data);
        streamBytes += data.length;

        // Trim old chunks if rolling buffer is too large
        while (streamBytes > maxStreamBytes && streamChunks.length > 1) {
          const removed = streamChunks.shift()!;
          streamBytes -= removed.length;
        }

        // Send truncated snapshot to the UI
        const fullBuffer = Buffer.concat(streamChunks);
        const fullText = sanitizeOutput(fullBuffer.toString("utf-8"));
        const lines = fullText.split("\n");
        // Quick tail truncation for the streaming preview
        let preview: string;
        if (lines.length > MAX_OUTPUT_LINES) {
          preview = lines.slice(-MAX_OUTPUT_LINES).join("\n");
        } else if (Buffer.byteLength(fullText, "utf-8") > MAX_OUTPUT_BYTES) {
          // Just take the tail bytes
          preview = truncateStringToBytesFromEnd(fullText, MAX_OUTPUT_BYTES);
        } else {
          preview = fullText;
        }

        onUpdate({
          content: [{ type: "text", text: preview }],
          details: { streaming: true },
        });
      }
    };
  } else {
    // Suppress all log output when not streaming
    opts.log = () => {};
  }

  const base$ = zx.$(opts as any);

  // Return a tagged template function that wraps the ProcessPromise
  const wrapped = function(pieces: TemplateStringsArray, ...args: any[]) {
    const proc: any = base$(pieces, ...args);

    // Wrap .then to intercept the ProcessOutput and truncate it
    const origThen = proc.then.bind(proc);
    proc.then = function<T1 = any, T2 = never>(
      onFulfill?: ((value: any) => T1 | PromiseLike<T1>) | null,
      onReject?: ((reason: any) => T2 | PromiseLike<T2>) | null
    ): Promise<T1 | T2> {
      return origThen(
        (output: any) => {
          const truncated = truncateProcessOutput(output);
          return onFulfill ? onFulfill(truncated) : truncated;
        },
        (err: any) => {
          // On error, zx throws a ProcessOutput — truncate it too
          if (err instanceof zx.ProcessOutput) {
            err = truncateProcessOutput(err);
          }
          if (onReject) return onReject(err);
          throw err;
        }
      );
    } as any;

    return proc;
  };

  // Copy over the options/config interface so $({...}) chaining still works
  return Object.assign(wrapped, base$) as typeof base$;
}

/**
 * Execute TypeScript code in a sandboxed vm context with tool bindings.
 *
 * @param tsCode - The TypeScript code body (no function wrapper needed)
 * @param typeDefs - TypeScript declarations for the tool API
 * @param bindings - Runtime tool functions
 * @param options - Timeout and output limits
 */
export async function executeCode(
  tsCode: string,
  typeDefs: string,
  bindings: ToolBindings,
  options?: SandboxOptions
): Promise<ExecutionResult> {
  const start = performance.now();
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const maxOutput = options?.maxOutputSize ?? DEFAULT_MAX_OUTPUT;

  const cwd = options?.cwd ?? process.cwd();
  const signal = options?.signal;
  const onUpdate = options?.onUpdate;
  const shellPrefix = options?.shellPrefix;
  const userPackages = options?.userPackages ?? {};
  const strings = options?.strings ?? {};
  const unsandboxed = options?.unsandboxed ?? false;

  // Set zx's working directory for this execution
  zx.$.cwd = cwd;

  // Step 1: Type-check (also for unsandboxed mode - catches errors early)
  const checkResult = typeCheck(tsCode, typeDefs);
  if (checkResult.errors.length > 0) {
    return {
      success: false,
      errorKind: 'type',
      errors: checkResult.errors,
      logs: [],
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }

  // Step 2: Strip types via esbuild
  const wrappedTs = `(async () => {\n${tsCode}\n})`;
  let jsCode: string;
  try {
    const result = transformSync(wrappedTs, {
      loader: "ts",
      target: "esnext",
    });
    // esbuild may add a trailing semicolon after the arrow function
    jsCode = result.code.trim().replace(/;$/, "");
  } catch (e: any) {
    return {
      success: false,
      errorKind: 'type',
      errors: [
        {
          line: 0,
          col: 0,
          message: `esbuild transform error: ${e.message}`,
        },
      ],
      logs: [],
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }

  // UNSANDBOXED MODE: Run code directly with full Node.js access
  if (unsandboxed) {
    return await executeUnsandboxed(jsCode, bindings, cwd, signal, onUpdate, shellPrefix, userPackages, strings, timeout, start);
  }

  // Step 3: Create vm context with bindings and safe globals
  const logs: string[] = [];
  let totalLogSize = 0;

  const captureLog = (...args: unknown[]) => {
    const line = args
      .map((a) =>
        typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)
      )
      .join(" ");
    totalLogSize += line.length;
    if (totalLogSize <= maxOutput) {
      logs.push(line);
    } else if (logs[logs.length - 1] !== "[output truncated]") {
      logs.push("[output truncated]");
    }
  };

  const context = vm.createContext({
    // Tool bindings
    tools: bindings,
    print: captureLog,

    // Console (captured)
    console: {
      log: captureLog,
      warn: captureLog,
      error: captureLog,
      info: captureLog,
    },

    // Safe globals
    Promise,
    setTimeout,
    clearTimeout,
    JSON,
    Array,
    Object,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Math,
    Date,
    RegExp,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    Number,
    String,
    Boolean,
    Symbol,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    undefined,
    NaN,
    Infinity,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    queueMicrotask,
    atob,
    btoa,

    // Process (limited safe properties)
    process: {
      env: process.env,
      cwd: () => cwd,
      platform: process.platform,
      version: process.version,
      arch: process.arch,
      uptime: process.uptime,
      memoryUsage: process.memoryUsage,
      hrtime: process.hrtime,
      nextTick: process.nextTick,
    },

    // Buffer for binary data
    Buffer,

    // zx shell scripting utilities — $ is configured with cwd, abort signal, and shell prefix
    $: createTruncating$(cwd, signal, onUpdate, shellPrefix),
    cd: zx.cd,
    within: zx.within,
    nothrow: zx.nothrow,
    quiet: zx.quiet,
    retry: zx.retry,
    sleep: zx.sleep,
    chalk: zx.chalk,
    which: zx.which,
    quote: zx.quote,
    glob: zx.glob,
    os: zx.os,
    path: zx.path,
    fs: zx.fs,
    ProcessOutput: zx.ProcessOutput,

    // Named string constants (from the 'strings' parameter)
    π: Object.freeze(strings),

    // User-configured packages (override built-ins if same name)
    ...userPackages,
  });

  // Step 4: Execute in vm
  try {
    // Compile and get the async function
    const fn = vm.runInContext(jsCode, context, {
      timeout,
      filename: "codemode.js",
    });

    // Execute the async function (vm timeout doesn't cover async,
    // so we also race against a timeout promise and abort signal)
    const racePromises: Promise<any>[] = [
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Execution timed out after ${timeout}ms`)),
          timeout
        )
      ),
    ];

    // If we have an abort signal, race against it too
    if (signal) {
      racePromises.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("Execution cancelled"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("Execution cancelled")), { once: true });
        })
      );
    }

    const returnValue = await Promise.race(racePromises);

    return {
      success: true,
      errors: [],
      logs,
      returnValue,
      elapsedMs: performance.now() - start,
    };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    // Try to extract line number from stack trace
    const stackMatch = message.match(/codemode\.js:(\d+)/);
    const line = stackMatch ? parseInt(stackMatch[1], 10) - 1 : 0; // -1 for wrapper

    return {
      success: false,
      errorKind: 'runtime',
      errors: [{ line: Math.max(1, line), col: 0, message }],
      logs, // Include any logs captured before the error
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }
}

/**
 * Execute code without sandbox - FULL SYSTEM ACCESS.
 * This runs the code directly with Node.js, giving it access to:
 * - require() any module
 * - Full process object
 * - File system without restrictions
 * - Network access
 * - All system calls
 *
 * DANGER: Only use this if you trust the code being executed!
 */
async function executeUnsandboxed(
  jsCode: string,
  bindings: ToolBindings,
  cwd: string,
  signal?: AbortSignal,
  onUpdate?: SandboxOptions["onUpdate"],
  shellPrefix?: string,
  userPackages?: Record<string, unknown>,
  strings?: Record<string, string>,
  timeout: number = DEFAULT_TIMEOUT,
  start: number = performance.now()
): Promise<ExecutionResult> {
  const logs: string[] = [];
  let totalLogSize = 0;

  const captureLog = (...args: unknown[]) => {
    const line = args
      .map((a) =>
        typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)
      )
      .join(" ");
    totalLogSize += line.length;
    if (totalLogSize <= 50 * 1024) {
      logs.push(line);
    } else if (logs[logs.length - 1] !== "[output truncated]") {
      logs.push("[output truncated]");
    }
  };

  // Create the global context with EVERYTHING available
  const globalContext: Record<string, any> = {
    // Tool bindings
    tools: bindings,
    print: captureLog,

    // Console (captured)
    console: {
      log: captureLog,
      warn: captureLog,
      error: captureLog,
      info: captureLog,
    },

    // Node.js built-ins (full access!)
    require,
    process,
    Buffer,
    global,
    __dirname: cwd,
    __filename: path.join(cwd, "codemode.js"),
    module: { exports: {} },
    exports: {},

    // URL and Web APIs
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
    queueMicrotask,
    atob,
    btoa,
    fetch: globalThis.fetch,

    // zx shell scripting
    $: createTruncating$(cwd, signal, onUpdate, shellPrefix),
    cd: zx.cd,
    within: zx.within,
    nothrow: zx.nothrow,
    quiet: zx.quiet,
    retry: zx.retry,
    sleep: zx.sleep,
    chalk: zx.chalk,
    which: zx.which,
    quote: zx.quote,
    glob: zx.glob,
    os: zx.os,
    path: zx.path,
    fs: zx.fs,
    ProcessOutput: zx.ProcessOutput,

    // Named string constants
    π: Object.freeze(strings ?? {}),

    // User packages
    ...userPackages,
  };

  try {
    // Create a function with all globals as parameters, then call it
    const globalKeys = Object.keys(globalContext);
  const globalValues = Object.values(globalContext);

  // Build the function - unwrap the IIFE that esbuild created
  // jsCode is like: (async () => { ...code... })  (note: no trailing call)
    const fn = new Function(
      ...globalKeys,
      `"use strict";\nreturn (${jsCode})();`
    );

    // Execute with timeout and abort signal
    const racePromises: Promise<any>[] = [
      Promise.resolve(fn(...globalValues)),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Execution timed out after ${timeout}ms`)),
          timeout
        )
      ),
    ];

    if (signal) {
      racePromises.push(
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("Execution cancelled"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("Execution cancelled")), { once: true });
        })
      );
    }

    const returnValue = await Promise.race(racePromises);

    return {
      success: true,
      errors: [],
      logs,
      returnValue,
      elapsedMs: performance.now() - start,
    };
  } catch (e: any) {
    const message = e?.message ?? String(e);
    // Try to extract line number from stack trace
    const stackMatch = message.match(/codemode\.js:(\d+)/);
    const line = stackMatch ? parseInt(stackMatch[1], 10) - 1 : 0;

    return {
      success: false,
      errorKind: 'runtime',
      errors: [{ line: Math.max(1, line), col: 0, message }],
      logs,
      returnValue: undefined,
      elapsedMs: performance.now() - start,
    };
  }
}