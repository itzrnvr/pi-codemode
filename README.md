# pi-codemode

**What if your coding agent could write real code to call its own tools — with type-checking, parallelism, and shell access — in a single round-trip?**

[![npm version](https://img.shields.io/npm/v/@georgebashi/pi-codemode?style=for-the-badge)](https://www.npmjs.com/package/@georgebashi/pi-codemode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

## Why

- **Fewer round-trips** — "read file A, grep for X, read matches, extract Y" takes 5+ individual tool calls. In code mode, it's one call.
- **Type-safe** — TypeScript type-checking catches wrong parameter types, missing fields, and non-existent tools *before* any code runs.
- **Tiny context usage** — installing lots of MCP tools normally costs thousands of tokens. Code mode keeps it constant: one tool definition + compact type defs. MCP details are discovered on-demand.
- **Any npm package as a tool** — Add `simple-git`, `octokit`, `yaml`, `csv-parse`, or any npm package to the sandbox. Auto-installed, auto-typed, available as globals.
- **Shell built in** — zx template literals with automatic argument escaping and output truncation.

Inspired by Cloudflare's [Code Mode](https://blog.cloudflare.com/code-mode/) pattern.

## Install

```bash
pi install npm:@georgebashi/pi-codemode
```

Run once without installing:

```bash
pi -e npm:@georgebashi/pi-codemode
```

> **Note:** pi-codemode bundles [pi-mcp-adapter](https://github.com/nichochar/pi-mcp-adapter) for MCP integration. If you have `pi-mcp-adapter` installed separately, uninstall it first (`pi uninstall pi-mcp-adapter`). Your MCP config files will be picked up by this extension and provided to the TypeScript sandbox.

## Quick Start

Once loaded, code mode replaces Pi's individual tools with a single `execute_tools` tool. The LLM writes TypeScript that calls tools as functions:

```typescript
// Read 3 files at once
const [pkg, readme, config] = await Promise.all([
  tools.read({ path: "package.json" }),
  tools.read({ path: "README.md" }),
  tools.read({ path: "tsconfig.json" }),
]);
return Object.keys(JSON.parse(pkg).dependencies || {});
```

```typescript
// Shell commands with automatic escaping
const result = await $\`grep -rn "TODO" --include='*.ts' src\`;
print(result.stdout);
```

```typescript
// Discover and call MCP tools
const details = await tools.describe_tools({ namespace: "slack", tool: "post_message" });
await tools.slack.post_message({ channel: "#general", text: "Hello!" });
```

## Adding Packages

Any npm package can be injected into the sandbox as a global. Packages are auto-installed into a dedicated directory — your project's `node_modules` is never touched. TypeScript types are resolved automatically.

**Project-local** — `.pi/codemode.json`:

```jsonc
{
  "packages": {
    "simple-git": { "version": "^3.33.0", "as": "git" },
    "yaml": { "version": "^2.8.0", "as": "YAML" },
    "@octokit/graphql": { "version": "^8.0.0", "as": "graphql" },
    "csv-parse": { "version": "^5.0.0", "as": "csvParse" }
  }
}
```

**Global** (all projects) — `~/.pi/agent/codemode.json`, same format.

Then the LLM can use them directly:

```typescript
// Git operations
const status = await git.status();
const log = await git.log({ maxCount: 5 });

// YAML parsing
const config = YAML.parse(await tools.read({ path: "config.yml" }));

// GitHub GraphQL API — request exactly the fields you need
const { repository } = await graphql(`{
  repository(owner: "org", name: "repo") {
    pullRequests(last: 10, states: OPEN) {
      nodes { title, author { login }, createdAt }
    }
  }
}`, { headers: { authorization: `bearer ${process.env.GITHUB_TOKEN}` } });
return repository.pullRequests.nodes;
```

## Commands

| Command | Description |
|---------|-------------|
| `/codemode` | Toggle code mode on/off |
| `--no-codemode` | Disable code mode entirely (CLI flag) |

## License

MIT
