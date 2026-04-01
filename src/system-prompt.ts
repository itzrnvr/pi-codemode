// system-prompt.ts — System prompt injection for code mode.
//
// The system prompt gets:
// 1. Built-in tool type declarations (compact, ~400 tokens)
// 2. MCP server namespace listing (names + tool counts only)
// 3. Usage examples showing describe_tools → call workflow
//
// Full MCP type signatures live only in the type checker — the LLM uses
// describe_tools() to browse and search_tools() to search before calling.

/** Info about a user-configured package for the system prompt. */
interface PackageInfo {
  varName: string;
  specifier: string;
  description: string;
}

/**
 * Generate the system prompt addition for code mode.
 *
 * @param builtinTypeDefs - TypeScript type declarations for built-in tools only
 * @param mcpSummary - Compact MCP server summary (namespace names only)
 * @param userPackages - User-configured packages with descriptions
 */
export function generateSystemPromptAddition(
  builtinTypeDefs: string,
  mcpSummary: string,
  userPackages?: PackageInfo[]
): string {
  return `\
## Code Mode

Write TypeScript code via \`execute_tools\` to call tools, run shell commands, and process data.
Code is type-checked before execution. Only \`print()\` output and \`return\` values enter context — intermediate data stays local, saving tokens.

### API

\`\`\`typescript
${builtinTypeDefs}
\`\`\`

### Patterns

\`\`\`typescript
// Parallel reads — always use Promise.all for independent calls
const [pkg, config] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "tsconfig.json" }),
]);
return { deps: Object.keys(JSON.parse(pkg).dependencies || {}) };
\`\`\`

\`\`\`typescript
// Chain: discover → fan out → filter (all in one execution, only final result enters context)
const found = await $\`find src -name '*.ts'\`;
const files = found.stdout.split('\\n').filter(Boolean);
const contents = await Promise.all(files.map(f => tools.read({ path: f })));
const matches = contents.flatMap((c, i) => c.includes("TODO") ? [files[i]] : []);
return matches;
\`\`\`

\`\`\`typescript
// Check ports / HTTP services — use fetch(), NOT shell commands like netstat or curl
const ports = [8080, 8081, 11434];
const results = await Promise.all(ports.map(async (p: number) => {
  try {
    const r = await fetch("http://localhost:" + p, { signal: AbortSignal.timeout(3000) });
    return { port: p, running: true, status: r.status };
  } catch { return { port: p, running: false }; }
}));
return results.filter((r: any) => r.running);
\`\`\`
${mcpSummary ? `
${mcpSummary}

Use \`tools.describe_tools({ namespace })\` to browse tools, \`tools.search_tools({ query })\` to search.
` : ""}${userPackages && userPackages.length > 0 ? '\n### Packages\n\n' + userPackages.map(p => '- \`' + p.varName + '\` — ' + p.description).join('\n') + '\n' : ''}
### Rules
- **Parallelize** independent calls with \`Promise.all\` — sequential awaits waste time
- **Filter locally** — process data in code, return only what matters (huge token savings)
- **Always \`await\`** shell commands: \`const r = await $\\\`cmd\\\`\` — unawaited \`$\` returns nothing
- \`$\\\`cmd\\\`\` runs **bash** via Git Bash on ALL platforms. Use Unix commands (\`grep\`, \`ls\`, \`cat\`, \`git\`). **Windows commands hang** (\`taskkill\`, \`netstat\`, \`tasklist\`, \`powershell\`, \`cmd\`)
- **If a command times out or hangs** — use Node.js APIs instead: \`fetch()\` for HTTP, \`require('net')\` for sockets, \`require('child_process')\` for process management, \`os.*\` for system info
- **\`spawn()\` without \`.on('error', ...)\` can crash the agent** (unsandboxed mode). Always attach error handlers when spawning processes
- **\`start\` is a cmd builtin, not an executable** — it won't work through \`execSync\` or \`spawn\`. Run the \`.exe\` path directly, or use \`execSync('cmd /c start ...')\`
- Use \`π.keyName\` (via \`strings\` param) for content with backticks, template literals, or nested quotes
- Configured packages are **pre-loaded globals** — use directly (e.g. \`axios.get(...)\`), not via \`require()\`
`;
}
