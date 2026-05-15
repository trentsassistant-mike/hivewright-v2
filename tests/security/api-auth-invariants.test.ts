import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMissingApiAuthInvariants } from "@/security/api-auth-invariants";

const PUBLIC_API_PREFIXES = [
  "src/app/api/auth/",
  "src/app/api/oauth/callback/",
  "src/app/api/voice/twiml/",
  "src/app/api/voice/ws/",
];

const AUTH_INVARIANT_TOKENS = [
  "requireApiAuth",
  "requireApiUser",
  "requireSystemOwner",
];

const tempDirs: string[] = [];

async function writeRepoFile(rootDir: string, relativePath: string, source: string) {
  const file = path.join(rootDir, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
}

async function createRepoFixture(files: Record<string, string>) {
  const rootDir = await mkdtemp(path.join(tmpdir(), "api-auth-invariants-"));
  tempDirs.push(rootDir);

  await Promise.all(
    Object.entries(files).map(([relativePath, source]) => writeRepoFile(rootDir, relativePath, source)),
  );

  return rootDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("findMissingApiAuthInvariants", () => {
  it("does not flag route wrappers that delegate to a local handler with auth invariants", async () => {
    const rootDir = await createRepoFixture({
      "src/app/api/brief/route.ts":
        'import { createBriefGetHandler } from "./get-handler";\nexport const GET = createBriefGetHandler();\n',
      "src/app/api/brief/get-handler.ts":
        'import { requireApiUser } from "../_lib/auth";\nexport function createBriefGetHandler() { return async function GET() { return requireApiUser(); }; }\n',
    });

    const missing = findMissingApiAuthInvariants({
      repoRoot: rootDir,
      routeFiles: ["src/app/api/brief/route.ts"],
      publicApiPrefixes: PUBLIC_API_PREFIXES,
      authInvariantTokens: AUTH_INVARIANT_TOKENS,
    });

    expect(missing).toEqual([]);
  });

  it("still flags wrappers when the delegated local handler lacks auth invariants", async () => {
    const rootDir = await createRepoFixture({
      "src/app/api/brief/route.ts":
        'import { createBriefGetHandler } from "./get-handler";\nexport const GET = createBriefGetHandler();\n',
      "src/app/api/brief/get-handler.ts":
        'export function createBriefGetHandler() { return async function GET() { return Response.json({ ok: true }); }; }\n',
    });

    const missing = findMissingApiAuthInvariants({
      repoRoot: rootDir,
      routeFiles: ["src/app/api/brief/route.ts"],
      publicApiPrefixes: PUBLIC_API_PREFIXES,
      authInvariantTokens: AUTH_INVARIANT_TOKENS,
    });

    expect(missing).toEqual(["src/app/api/brief/route.ts"]);
  });
});
