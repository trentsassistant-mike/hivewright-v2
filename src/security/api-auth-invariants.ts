import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROUTE_EXPORT_IDENTIFIER = /export\s+const\s+(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*=\s*([A-Za-z_$][\w$]*)/g;
const NAMED_IMPORT = /import\s*{\s*([^}]+)\s*}\s*from\s*["']([^"']+)["']/g;

type ApiAuthInvariantOptions = {
  repoRoot: string;
  routeFiles: string[];
  publicApiPrefixes: string[];
  authInvariantTokens: string[];
};

function hasAuthInvariantToken(content: string, authInvariantTokens: string[]) {
  return authInvariantTokens.some((token) => content.includes(token));
}

function isPublicApiRoute(file: string, publicApiPrefixes: string[]) {
  return publicApiPrefixes.some((prefix) => file.startsWith(prefix));
}

function parseNamedImports(content: string) {
  const importMap = new Map<string, string>();

  for (const match of content.matchAll(NAMED_IMPORT)) {
    const importedNames = match[1]?.split(",") ?? [];
    const source = match[2]?.trim();
    if (!source) continue;

    for (const importedName of importedNames) {
      const specifier = importedName.trim();
      if (!specifier) continue;

      const aliasMatch = specifier.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliasMatch) {
        importMap.set(aliasMatch[2], source);
        continue;
      }

      importMap.set(specifier, source);
    }
  }

  return importMap;
}

function exportedRouteIdentifiers(content: string) {
  const identifiers = new Set<string>();

  for (const match of content.matchAll(ROUTE_EXPORT_IDENTIFIER)) {
    const identifier = match[1]?.trim();
    if (identifier) identifiers.add(identifier);
  }

  return identifiers;
}

function resolveLocalModulePath(routeFile: string, source: string) {
  const routeDir = path.dirname(routeFile);
  const absoluteBase = path.resolve(routeDir, source);
  const candidates = [
    absoluteBase,
    `${absoluteBase}.ts`,
    `${absoluteBase}.tsx`,
    path.join(absoluteBase, "index.ts"),
    path.join(absoluteBase, "index.tsx"),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function delegatedModuleHasAuthInvariant(
  routeFile: string,
  routeContent: string,
  authInvariantTokens: string[],
) {
  const importMap = parseNamedImports(routeContent);
  const identifiers = exportedRouteIdentifiers(routeContent);

  for (const identifier of identifiers) {
    const importSource = importMap.get(identifier);
    if (!importSource || !importSource.startsWith(".")) continue;

    const delegatedModule = resolveLocalModulePath(routeFile, importSource);
    if (!delegatedModule) continue;

    const delegatedContent = readFileSync(delegatedModule, "utf8");
    if (hasAuthInvariantToken(delegatedContent, authInvariantTokens)) {
      return true;
    }
  }

  return false;
}

export function findMissingApiAuthInvariants({
  repoRoot,
  routeFiles,
  publicApiPrefixes,
  authInvariantTokens,
}: ApiAuthInvariantOptions) {
  return routeFiles
    .filter((file) => !isPublicApiRoute(file, publicApiPrefixes))
    .filter((file) => {
      const absoluteFile = path.join(repoRoot, file);
      const content = readFileSync(absoluteFile, "utf8");
      if (hasAuthInvariantToken(content, authInvariantTokens)) {
        return false;
      }

      return !delegatedModuleHasAuthInvariant(absoluteFile, content, authInvariantTokens);
    });
}
