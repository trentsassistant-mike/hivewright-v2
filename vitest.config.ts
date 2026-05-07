import { defineConfig } from "vitest/config";
import path from "path";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://hivewright:hivewright@localhost:5432/hivewright_test";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    exclude: ["**/node_modules/**", "**/dist/**", "**/.worktrees/**", "**/.claude/worktrees/**"],
    globalSetup: ["./vitest.global-setup.ts"],
    env: {
      AUTH_SECRET: "vitest-auth-secret",
      DATABASE_URL: TEST_DATABASE_URL,
      TEST_DATABASE_URL,
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
