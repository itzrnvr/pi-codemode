// type-checker.ts — Full TypeScript type-checking of LLM-generated code against tool API declarations.
//
// Uses ts.createProgram with a virtual file system containing:
// - ES2022 lib .d.ts files (pre-parsed once at init)
// - @types/node, @types/fs-extra, @types/jsonfile (for full Node.js + fs-extra types)
// - zx .d.ts files (for $, ProcessPromise, ProcessOutput, etc.)
// - Tool type definitions (updated when MCP tools are discovered)
// - The user's code wrapped in an async IIFE
//
// Module resolution: Node10 with a virtual file system that maps paths to pre-loaded
// content. Handles .js → .d.ts extension mapping, package.json "types" resolution,
// and path normalization (leading "/" from getCurrentDirectory).
//
// Performance: ~5ms per check after warmup. Lib loading: ~150ms once.

import ts from "typescript";
import fsReal from "node:fs";
import pathReal from "node:path";

export interface TypeCheckError {
  /** Line number in user's code (1-indexed) */
  line: number;
  /** Column number (1-indexed) */
  col: number;
  /** TypeScript error message */
  message: string;
}

export interface TypeCheckResult {
  errors: TypeCheckError[];
}

// Pre-parsed SourceFile objects, keyed by virtual path (without leading /)
let sourceFiles: Map<string, ts.SourceFile> | null = null;
// Raw file content, keyed by virtual path (without leading /)
let fileContent: Map<string, string> | null = null;
// Directories that exist in the virtual FS (for directoryExists)
let directories: Set<string> | null = null;

const LIB_NAMES = [
  "lib.es5.d.ts",
  "lib.es2015.d.ts",
  "lib.es2015.promise.d.ts",
  "lib.es2015.iterable.d.ts",
  "lib.es2015.collection.d.ts",
  "lib.es2015.symbol.d.ts",
  "lib.es2015.symbol.wellknown.d.ts",
  "lib.es2015.core.d.ts",
  "lib.es2015.generator.d.ts",
  "lib.es2015.proxy.d.ts",
  "lib.es2015.reflect.d.ts",
  "lib.es2016.d.ts",
  "lib.es2016.array.include.d.ts",
  "lib.es2017.d.ts",
  "lib.es2017.string.d.ts",
  "lib.es2017.object.d.ts",
  "lib.es2017.sharedmemory.d.ts",
  "lib.es2017.intl.d.ts",
  "lib.es2017.typedarrays.d.ts",
  "lib.es2018.d.ts",
  "lib.es2018.asyncgenerator.d.ts",
  "lib.es2018.asynciterable.d.ts",
  "lib.es2018.intl.d.ts",
  "lib.es2018.promise.d.ts",
  "lib.es2018.regexp.d.ts",
  "lib.es2019.d.ts",
  "lib.es2019.array.d.ts",
  "lib.es2019.object.d.ts",
  "lib.es2019.string.d.ts",
  "lib.es2019.symbol.d.ts",
  "lib.es2019.intl.d.ts",
  "lib.es2020.d.ts",
  "lib.es2020.string.d.ts",
  "lib.es2020.symbol.wellknown.d.ts",
  "lib.es2020.bigint.d.ts",
  "lib.es2020.promise.d.ts",
  "lib.es2020.sharedmemory.d.ts",
  "lib.es2020.intl.d.ts",
  "lib.es2020.date.d.ts",
  "lib.es2020.number.d.ts",
  "lib.es2021.d.ts",
  "lib.es2021.promise.d.ts",
  "lib.es2021.string.d.ts",
  "lib.es2021.weakref.d.ts",
  "lib.es2021.intl.d.ts",
  "lib.es2022.d.ts",
  "lib.es2022.array.d.ts",
  "lib.es2022.error.d.ts",
  "lib.es2022.object.d.ts",
  "lib.es2022.string.d.ts",
  "lib.es2022.regexp.d.ts",
  "lib.es2022.intl.d.ts",
];

/**
 * Initialize the type checker by pre-parsing TS lib files, @types/*, and zx types.
 * Call once at extension load. Subsequent calls are no-ops.
 */
export function initTypeChecker(): void {
  if (sourceFiles) return;

  sourceFiles = new Map();
  fileContent = new Map();
  directories = new Set();

  // Load ES2022 lib files from TypeScript's lib directory
  const tsLibDir = pathReal.dirname(
    require.resolve("typescript/lib/lib.es2022.d.ts")
  );
  for (const name of LIB_NAMES) {
    const filePath = pathReal.join(tsLibDir, name);
    if (fsReal.existsSync(filePath)) {
      addFile(name, fsReal.readFileSync(filePath, "utf-8"));
    }
  }

  // Load @types packages and zx from node_modules.
  // Some @types packages restrict exports (e.g. @types/fs-extra), so we
  // can't use require.resolve() for all of them. Instead, derive the
  // node_modules path from typescript's location (which we already resolved
  // above), so this works even when the code is bundled or run from a temp dir.
  const ownNodeModules = pathReal.resolve(tsLibDir, "..", "..");

  const packagesToLoad = [
    { dir: "@types/node", prefix: "node_modules/@types/node" },
    { dir: "@types/fs-extra", prefix: "node_modules/@types/fs-extra" },
    { dir: "@types/jsonfile", prefix: "node_modules/@types/jsonfile" },
    { dir: "zx", prefix: "node_modules/zx" },
  ];

  for (const pkg of packagesToLoad) {
    const pkgDir = pathReal.join(ownNodeModules, pkg.dir);
    if (fsReal.existsSync(pkgDir)) {
      loadPackageDir(pkgDir, pkg.prefix);
    }
  }


}

/**
 * Load additional package type definitions into the virtual file system.
 * Called after initTypeChecker() to add user-configured packages.
 *
 * For each package, loads .d.ts files from either:
 * - The package's own types (package.json "types"/"typings" field)
 * - @types/<package> from the same node_modules
 */
export function loadPackageTypes(packages: Array<{
  specifier: string;
  packageDir: string;
  hasTypes: boolean;
}>): void {
  if (!sourceFiles) initTypeChecker();

  for (const pkg of packages) {
    if (!pkg.hasTypes) continue;

    const nodeModulesDir = pathReal.dirname(pkg.packageDir);

    // Try loading the package's own types
    const pkgJsonPath = pathReal.join(pkg.packageDir, "package.json");
    if (fsReal.existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(fsReal.readFileSync(pkgJsonPath, "utf-8"));
        if (pkgJson.types || pkgJson.typings || pkgJson.exports?.["."]?.types) {
          // Package has its own type definitions — load the whole package dir
          const prefix = "node_modules/" + getPackageName(pkg.specifier);
          loadPackageDir(pkg.packageDir, prefix);
          continue; // Don't also load @types
        }
      } catch {}
    }

    // Try loading @types/<package>
    const baseName = pkg.specifier.startsWith("@")
      ? pkg.specifier.replace("@", "").replace("/", "__")
      : pkg.specifier.split("/")[0];
    const typesDir = pathReal.join(nodeModulesDir, "@types", baseName);
    if (fsReal.existsSync(typesDir)) {
      const prefix = "node_modules/@types/" + baseName;
      loadPackageDir(typesDir, prefix);
    }
  }
}

/**
 * Get the package name from a specifier (handles scoped packages).
 * "lodash" → "lodash"
 * "@scope/pkg" → "@scope/pkg"
 * "csv-parse/sync" → "csv-parse"
 */
function getPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

/** Add a file to the virtual file system. */
function addFile(virtualPath: string, content: string): void {
  fileContent!.set(virtualPath, content);
  sourceFiles!.set(
    virtualPath,
    ts.createSourceFile(virtualPath, content, ts.ScriptTarget.ESNext, true)
  );
  // Register all parent directories
  let dir = virtualPath;
  while (true) {
    const parent = dir.includes("/") ? dir.substring(0, dir.lastIndexOf("/")) : "";
    if (parent === dir) break;
    dir = parent;
    if (dir) directories!.add(dir);
  }
}

/** Load a package directory into the virtual FS (.d.ts files + package.json). */
function loadPackageDir(realDir: string, virtualPrefix: string): void {
  for (const entry of fsReal.readdirSync(realDir, { withFileTypes: true })) {
    const virtualPath = virtualPrefix + "/" + entry.name;
    if (entry.isFile()) {
      if (entry.name.endsWith(".d.ts") || entry.name === "package.json") {
        addFile(virtualPath, fsReal.readFileSync(pathReal.join(realDir, entry.name), "utf-8"));
      }
    } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
      loadPackageDir(pathReal.join(realDir, entry.name), virtualPath);
    }
  }
}

/**
 * Normalize a path from the compiler — strip leading "/" to match our virtual paths.
 * getCurrentDirectory() returns "/", so TS prepends it to relative paths.
 */
function normalizePath(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

/**
 * Type-check user code against the provided type definitions.
 *
 * @param userCode - The code body written by the LLM (no function wrapper needed)
 * @param typeDefs - TypeScript declaration string for the tool API
 * @returns TypeCheckResult with any errors found
 */
export function typeCheck(
  userCode: string,
  typeDefs: string
): TypeCheckResult {
  if (!sourceFiles) {
    initTypeChecker();
  }

  const typeDefLineCount = typeDefs.split("\n").length;
  // +1 for the "(async () => {" wrapper line
  const prefixLineCount = typeDefLineCount + 1;

  const fullSource =
    typeDefs + "\n(async () => {\n" + userCode + "\n})();\n";
  const fileName = "codemode.ts";
  const sourceFile = ts.createSourceFile(
    fileName,
    fullSource,
    ts.ScriptTarget.ESNext,
    true
  );

  const host: ts.CompilerHost = {
    getSourceFile: (name: string) => {
      if (name === fileName) return sourceFile;
      const normalized = normalizePath(name);
      return sourceFiles!.get(name) ?? sourceFiles!.get(normalized);
    },
    getDefaultLibFileName: () => "lib.es5.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f: string) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f: string) => {
      if (f === fileName) return true;
      const normalized = normalizePath(f);
      return fileContent!.has(f) || fileContent!.has(normalized);
    },
    readFile: (f: string) => {
      const normalized = normalizePath(f);
      return fileContent!.get(f) ?? fileContent!.get(normalized);
    },
    directoryExists: (dir: string) => {
      const normalized = normalizePath(dir);
      return directories!.has(dir) || directories!.has(normalized);
    },
    getDirectories: (dir: string) => {
      const normalized = normalizePath(dir);
      const prefix = normalized ? normalized + "/" : "";
      const subdirs = new Set<string>();
      for (const d of directories!) {
        if (d.startsWith(prefix) && d !== normalized) {
          const rest = d.slice(prefix.length);
          const firstSegment = rest.split("/")[0];
          if (firstSegment) subdirs.add(firstSegment);
        }
      }
      return [...subdirs];
    },
    // Needed so TS resolves parent of getCurrentDirectory
    realpath: (f: string) => f,
  };

  const program = ts.createProgram(
    [fileName, ...sourceFiles!.keys()],
    {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      typeRoots: ["node_modules/@types"],
      types: ["node"],
    },
    host
  );

  const checker = program.getTypeChecker();

  // Only get diagnostics for our file, not lib files
  const syntaxDiags = program.getSyntacticDiagnostics(sourceFile);
  const semanticDiags = program.getSemanticDiagnostics(sourceFile);
  const allDiags = [...syntaxDiags, ...semanticDiags];

  const errors: TypeCheckError[] = allDiags.map((d) => {
    let msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      // Try to enrich type errors with parameter documentation
      msg = enrichErrorMessage(msg, d, sourceFile, checker);

      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      // Adjust line number: subtract type def prefix and IIFE wrapper
      const userLine = pos.line - prefixLineCount;
      return {
        line: Math.max(1, userLine + 1),
        col: pos.character + 1,
        message: msg,
      };
    }
    return { line: 0, col: 0, message: msg };
  });

  return { errors };
}


/**
 * Enrich a type error with contextual documentation from JSDoc/descriptions.
 *
 * When an error occurs on a property assignment like `limit: 2`,
 * find the property's JSDoc in the type definitions and append it
 * so the LLM knows the expected format (e.g., "1d", "50").
 */
function enrichErrorMessage(
  msg: string,
  diagnostic: ts.Diagnostic,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker
): string {
  try {
    if (diagnostic.start === undefined) return msg;

    // Find the AST node at the error position
    const node = findNodeAtPosition(sourceFile, diagnostic.start);
    if (!node) return msg;

    // Case 1: Error on a property assignment value (e.g., `limit: 2`)
    // The error is on the value `2`, parent is PropertyAssignment
    const propAssignment = findParentOfKind(node, ts.SyntaxKind.PropertyAssignment);
    if (propAssignment && ts.isPropertyAssignment(propAssignment)) {
      const propName = propAssignment.name.getText(sourceFile);

      // Walk up to find the object literal, then the call expression,
      // then resolve the expected type to find the property's doc
      const objectLiteral = propAssignment.parent;
      if (objectLiteral && ts.isObjectLiteralExpression(objectLiteral)) {
        const contextualType = checker.getContextualType(objectLiteral);
        if (contextualType) {
          const propSymbol = contextualType.getProperty(propName);
          if (propSymbol) {
            const doc = ts.displayPartsToString(
              propSymbol.getDocumentationComment(checker)
            ).trim();
            if (doc) {
              return msg + `\n  Hint: ${propName} — ${doc}`;
            }
          }
        }
      }
    }

    // Case 2: Error on the property name itself (e.g., unknown property)
    // Already handled well by TS ("does not exist in type '...'") with
    // the Did-you-mean suggestion. No enrichment needed.

  } catch {
    // Don't let enrichment errors break type checking
  }
  return msg;
}

/** Find the innermost AST node at a given position. */
function findNodeAtPosition(
  sourceFile: ts.SourceFile,
  position: number
): ts.Node | undefined {
  function visit(node: ts.Node): ts.Node | undefined {
    if (position < node.getStart(sourceFile) || position >= node.getEnd()) {
      return undefined;
    }
    // Try children first (innermost wins)
    let best: ts.Node | undefined;
    ts.forEachChild(node, (child) => {
      const found = visit(child);
      if (found) best = found;
    });
    return best ?? node;
  }
  return visit(sourceFile);
}

/** Walk up the AST to find a parent of a specific kind. */
function findParentOfKind(
  node: ts.Node,
  kind: ts.SyntaxKind
): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current.kind === kind) return current;
    current = current.parent;
  }
  return undefined;
}