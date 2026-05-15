import { defineConfig } from "vitest/config";
import path from "path";

const isIsolatedWorktreeRoot =
  __dirname.includes(`${path.sep}.worktrees${path.sep}`) ||
  __dirname.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`);

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      ...(isIsolatedWorktreeRoot ? [] : ["**/.worktrees/**", "**/.claude/worktrees/**"]),
    ],
    globalSetup: ["./vitest.global-setup.ts"],
    env: {
      AUTH_SECRET: "vitest-auth-secret",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
