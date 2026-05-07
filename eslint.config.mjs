import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated bundle
    "dispatcher-bundle.js",
    "public/sw.js",
    // Nested worktrees are separate checkouts; lint them in their own workspace.
    ".worktrees/**",
    ".claude/worktrees/**",
    // Design skill/reference snippets are not part of the app build surface.
    "skills-library/**",
  ]),
]);

export default eslintConfig;
