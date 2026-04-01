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
${mcpSummary ? `
${mcpSummary}

Use \`tools.describe_tools({ namespace })\` to browse tools, \`tools.search_tools({ query })\` to search.
` : ""}${userPackages && userPackages.length > 0 ? '\n### Packages\n\n' + userPackages.map(p => '- \`' + p.varName + '\` — ' + p.description).join('\n') + '\n' : ''}
### Rules
- **Parallelize** independent calls with \`Promise.all\` — sequential awaits waste time
- **Filter locally** — process data in code, return only what matters (huge token savings)
- **Always \`await\`** shell commands: \`const r = await $\\\`cmd\\\`\` — unawaited \`$\` returns nothing
- \`$\\\`cmd\\\`\` runs **bash** (zx) on ALL platforms including Windows (via Git Bash). Use Unix commands (\`grep\`, \`curl\`, \`ls\`), NOT Windows-specific ones (\`findstr\`, \`tasklist /FI\`, \`netstat\`). For process/port inspection, prefer \`fetch()\` or Node.js APIs (\`require('http')\`, \`require('net')\`)
- Use \`π.keyName\` (via \`strings\` param) for content with backticks, template literals, or nested quotes
- Configured packages are **pre-loaded globals** — use directly (e.g. \`axios.get(...)\`), not via \`require()\`
`;
}
