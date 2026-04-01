// package-resolver.ts — Resolve user-configured packages for the codemode sandbox.
//
// Supports two configuration locations:
// 1. Global: ~/.pi/agent/codemode.json → auto-installs into ~/.pi/agent/codemode-packages/
// 2. Project: $PROJECT/.pi/codemode.json → auto-installs into $PROJECT/.pi/codemode-packages/
//
// Packages are npm-installed into dedicated directories (never touching the user's
// project node_modules or pi-codemode's own node_modules). Each scope has its own
// independent node_modules tree — no cross-tree dependency resolution.
//
// Override order (last wins): built-ins < global < project.
// Users can override built-in packages (e.g., replace simple-git with isomorphic-git).

import { execSync } from "node:child_process";
import fsReal from "node:fs";
import pathReal from "node:path";
import { homedir } from "node:os";

/** A resolved package ready for injection into the sandbox. */
export interface ResolvedPackage {
  /** The npm specifier (e.g., "lodash", "csv-parse") */
  specifier: string;
  /** Version range from config (e.g., ">=4.17.21", "*") */
  versionRange: string;
  /** Variable name in the sandbox (e.g., "lodash", "csvParse") */
  varName: string;
  /** The resolved module (result of require()) */
  module: unknown;
  /** Path to the package's directory in node_modules */
  packageDir: string;
  /** Whether this package has .d.ts type definitions */
  hasTypes: boolean;
  /** Which scope this came from */
  scope: "global" | "project";
  /** Human-readable description (from config or package.json) */
  description: string;
}

/** Raw config format from codemode.json */
export interface CodemodeConfig {
  packages?: Record<string, string | PackageSpec>;
}

export interface PackageSpec {
  version: string;
  as?: string;
  /** Description shown in search_tools results and system prompt */
  description?: string;
}

/**
 * Load and resolve all user-configured packages.
 *
 * Reads global (~/.pi/agent/codemode.json) and project ($cwd/.pi/codemode.json) configs,
 * ensures packages are installed, and returns resolved modules ready for the sandbox.
 *
 * @param cwd - Project directory
 * @returns Resolved packages and any warnings
 */
export function loadUserPackages(cwd: string): {
  packages: ResolvedPackage[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const allPackages = new Map<string, ResolvedPackage>(); // varName → package

  // 1. Load global config
  const globalConfigPath = pathReal.join(homedir(), ".pi", "agent", "codemode.json");
  const globalInstallDir = pathReal.join(homedir(), ".pi", "agent", "codemode-packages");
  const globalConfig = loadConfig(globalConfigPath, warnings);
  if (globalConfig && globalConfig.packages && Object.keys(globalConfig.packages).length > 0) {
    const resolved = ensureInstalledAndResolve(globalConfig, globalInstallDir, "global", warnings);
    for (const pkg of resolved) {
      allPackages.set(pkg.varName, pkg);
    }
  }

  // 2. Load project config (overrides global for same varName)
  const projectConfigPath = pathReal.join(cwd, ".pi", "codemode.json");
  const projectInstallDir = pathReal.join(cwd, ".pi", "codemode-packages");
  const projectConfig = loadConfig(projectConfigPath, warnings);
  if (projectConfig && projectConfig.packages && Object.keys(projectConfig.packages).length > 0) {
    const resolved = ensureInstalledAndResolve(projectConfig, projectInstallDir, "project", warnings);
    for (const pkg of resolved) {
      allPackages.set(pkg.varName, pkg);
    }
  }

  return {
    packages: [...allPackages.values()],
    warnings,
  };
}

/**
 * Load a codemode.json config file. Returns null if not found.
 */
function loadConfig(configPath: string, warnings: string[]): CodemodeConfig | null {
  if (!fsReal.existsSync(configPath)) return null;

  try {
    const raw = fsReal.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed as CodemodeConfig;
  } catch (e: any) {
    warnings.push(`Failed to parse ${configPath}: ${e.message}`);
    return null;
  }
}

/**
 * Normalize a package config entry into specifier, version, and variable name.
 */
function normalizeEntry(
  specifier: string,
  value: string | PackageSpec
): { version: string; varName: string; description?: string } {
  if (typeof value === "string") {
    return {
      version: value,
      varName: specifierToVarName(specifier),
    };
  }
  return {
    version: value.version,
    varName: value.as ?? specifierToVarName(specifier),
    description: value.description,
  };
}

/**
 * Convert an npm specifier to a valid JS variable name.
 * "lodash" → "lodash"
 * "csv-parse" → "csvParse"
 * "@scope/foo-bar" → "fooBar"
 */
function specifierToVarName(specifier: string): string {
  // Strip scope
  let name = specifier.replace(/^@[^/]+\//, "");
  // Strip deep import paths
  name = name.split("/")[0];
  // camelCase hyphenated names
  name = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  // Remove any remaining invalid chars
  name = name.replace(/[^a-zA-Z0-9_$]/g, "");
  // Ensure starts with a letter
  if (/^[0-9]/.test(name)) name = "_" + name;
  return name;
}

/**
 * Ensure packages are installed in the target directory and resolve them.
 *
 * Compares desired packages against what's already in the install dir's package.json.
 * Only runs npm install if something changed.
 */
function ensureInstalledAndResolve(
  config: CodemodeConfig,
  installDir: string,
  scope: "global" | "project",
  warnings: string[]
): ResolvedPackage[] {
  const packages = config.packages ?? {};
  const entries = Object.entries(packages);
  if (entries.length === 0) return [];

  // Build desired dependencies (including @types/* for type checking)
  const desiredDeps: Record<string, string> = {};
  let optionalTypeDeps: Record<string, string> | undefined;
  const entryMap = new Map<string, { version: string; varName: string; description?: string }>();

  for (const [specifier, value] of entries) {
    const normalized = normalizeEntry(specifier, value);
    desiredDeps[specifier] = normalized.version;
    entryMap.set(specifier, normalized);

    // Auto-add @types/* as optional dependency for type checking
    // (optional so npm doesn't fail if @types/* doesn't exist for a package)
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      const baseName = specifier.startsWith("@")
        ? specifier.replace("@", "").replace("/", "__")
        : specifier.split("/")[0];
      if (!optionalTypeDeps) optionalTypeDeps = {};
      optionalTypeDeps["@types/" + baseName] = "*";
    }
  }

  // Check if install is needed
  const pkgJsonPath = pathReal.join(installDir, "package.json");
  let needsInstall = false;

  if (!fsReal.existsSync(pkgJsonPath)) {
    needsInstall = true;
  } else {
    try {
      const existing = JSON.parse(fsReal.readFileSync(pkgJsonPath, "utf-8"));
      const existingDeps = existing.dependencies ?? {};
      const existingOptDeps = existing.optionalDependencies ?? {};
      const desiredOptDeps = optionalTypeDeps ?? {};
      // Compare: same keys and same values?
      const existingKeys = Object.keys(existingDeps).sort();
      const desiredKeys = Object.keys(desiredDeps).sort();
      const existingOptKeys = Object.keys(existingOptDeps).sort();
      const desiredOptKeys = Object.keys(desiredOptDeps).sort();
      if (
        existingKeys.length !== desiredKeys.length ||
        existingKeys.some((k, i) => k !== desiredKeys[i]) ||
        existingKeys.some((k) => existingDeps[k] !== desiredDeps[k]) ||
        existingOptKeys.length !== desiredOptKeys.length ||
        existingOptKeys.some((k, i) => k !== desiredOptKeys[i]) ||
        existingOptKeys.some((k) => existingOptDeps[k] !== desiredOptDeps[k])
      ) {
        needsInstall = true;
      }
    } catch {
      needsInstall = true;
    }
  }

  if (needsInstall) {
    try {
      // Create the install directory
      fsReal.mkdirSync(installDir, { recursive: true });

      // Write package.json
      const pkgJson: Record<string, unknown> = {
        name: "pi-codemode-user-packages",
        version: "0.0.0",
        private: true,
        description: "Auto-managed by pi-codemode. Do not edit.",
        dependencies: desiredDeps,
      };
      if (optionalTypeDeps && Object.keys(optionalTypeDeps).length > 0) {
        pkgJson.optionalDependencies = optionalTypeDeps;
      }
      fsReal.writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

      // Run npm install
      execSync("npm install --no-audit --no-fund", {
        cwd: installDir,
        stdio: "pipe",
        timeout: 60_000,
      });
    } catch (e: any) {
      warnings.push(`Failed to install packages in ${installDir}: ${e.message}`);
      return [];
    }
  }

  // Resolve each package
  const resolved: ResolvedPackage[] = [];
  const nodeModulesDir = pathReal.join(installDir, "node_modules");

  for (const [specifier, entry] of entryMap) {
    try {
      // Resolve the package's main entry from the install dir
      const resolvedPath = require.resolve(specifier, { paths: [installDir] });
      const mod = require(resolvedPath);

      // Find the package directory for type checking
      const pkgDir = findPackageDir(specifier, nodeModulesDir);
      const hasTypes = pkgDir ? packageHasTypes(specifier, pkgDir, nodeModulesDir) : false;

      // Resolve description: config description > package.json description > npm specifier
      let description = entry.description;
      if (!description && pkgDir) {
        try {
          const pkgJsonPath = pathReal.join(pkgDir, "package.json");
          const pkgJson = JSON.parse(fsReal.readFileSync(pkgJsonPath, "utf-8"));
          description = pkgJson.description;
        } catch {}
      }
      if (!description) {
        description = specifier;
      }

      resolved.push({
        specifier,
        versionRange: entry.version,
        varName: entry.varName,
        module: mod,
        packageDir: pkgDir ?? pathReal.dirname(resolvedPath),
        hasTypes,
        scope,
        description,
      });
    } catch (e: any) {
      warnings.push(`Failed to resolve package "${specifier}": ${e.message}`);
    }
  }

  return resolved;
}

/**
 * Find the package directory in node_modules.
 */
function findPackageDir(specifier: string, nodeModulesDir: string): string | null {
  // Handle scoped packages: @scope/pkg → node_modules/@scope/pkg
  const pkgDir = pathReal.join(nodeModulesDir, specifier.split("/")[0].startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0]);

  return fsReal.existsSync(pkgDir) ? pkgDir : null;
}

/**
 * Check if a package has TypeScript type definitions available.
 */
function packageHasTypes(specifier: string, pkgDir: string, nodeModulesDir: string): boolean {
  // Check the package's own types/typings field (top-level or exports["."].types)
  const pkgJsonPath = pathReal.join(pkgDir, "package.json");
  if (fsReal.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fsReal.readFileSync(pkgJsonPath, "utf-8"));
      if (pkgJson.types || pkgJson.typings) return true;
      // Modern packages use exports["."].types (e.g., yaml, csv-parse)
      if (pkgJson.exports?.["."]?.types) return true;
    } catch {}
  }

  // Check for @types package
  const baseName = specifier.startsWith("@")
    ? specifier.replace("@", "").replace("/", "__")
    : specifier.split("/")[0];
  const typesDir = pathReal.join(nodeModulesDir, "@types", baseName);
  return fsReal.existsSync(typesDir);
}

/**
 * Get the install directory for a given scope.
 */
export function getInstallDir(scope: "global" | "project", cwd: string): string {
  if (scope === "global") {
    return pathReal.join(homedir(), ".pi", "agent", "codemode-packages");
  }
  return pathReal.join(cwd, ".pi", "codemode-packages");
}
