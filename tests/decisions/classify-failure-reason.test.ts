import { describe, it, expect } from "vitest";
import { classifyFailureReason } from "@/decisions/classify-failure-reason";

describe("classifyFailureReason", () => {
  describe("returns 'system_error' for infrastructure failures", () => {
    const infraReasons: [string, string][] = [
      ["codex TOML parse", 'Process exited with code 1: Error loading config.toml: invalid type: string "{...}"'],
      ["invalid type", "thread 'main' panicked at 'invalid type: string at line 5'"],
      ["spawn ENOENT", "Error: spawn codex ENOENT"],
      ["bare ENOENT", "ENOENT: no such file or directory, open '/tmp/missing'"],
      ["EACCES", "EACCES: permission denied"],
      ["command not found", "/bin/sh: 1: openclaw: command not found"],
      ["Cannot find module", "Error: Cannot find module '@modelcontextprotocol/server-github'"],
      ["Missing env var", 'Missing env var "OPENCLAW_GATEWAY_TOKEN"'],
      ["SecretRefResolutionError", "SecretRefResolutionError: Environment variable is missing or empty."],
      ["SECRETS_RELOADER_DEGRADED", "[secrets] [SECRETS_RELOADER_DEGRADED] gateway failed"],
      ["ECONNREFUSED", "Error: connect ECONNREFUSED 127.0.0.1:5433"],
      ["ETIMEDOUT", "Error: connect ETIMEDOUT 1.2.3.4:80"],
      ["postgres connection refused", "connection to server at \"localhost\" (127.0.0.1), port 5433 failed"],
      ["EMFILE", "EMFILE: too many open files"],
      ["ENOSPC", "ENOSPC: no space left on device"],
    ];

    it.each(infraReasons)("classifies %s as system_error", (_label, reason) => {
      expect(classifyFailureReason(reason)).toBe("system_error");
    });
  });

  describe("returns 'decision' for owner-actionable failures", () => {
    const decisionReasons: [string, string][] = [
      ["budget cap", "Budget cap reached for hive at $500/month — ship the remaining work anyway?"],
      ["ambiguous intent", "Two viable approaches exist for this goal and neither is strictly better"],
      ["scope question", "QA feedback indicates the acceptance criteria are unclear"],
      ["generic exit", "Process exited with code 1"],
      ["doctor replan failure", "Doctor completed but suggested approach conflicts with prior sprint work"],
      ["empty string", ""],
    ];

    it.each(decisionReasons)("classifies %s as decision", (_label, reason) => {
      expect(classifyFailureReason(reason)).toBe("decision");
    });

    it("returns 'decision' for null/undefined", () => {
      expect(classifyFailureReason(null)).toBe("decision");
      expect(classifyFailureReason(undefined)).toBe("decision");
    });
  });

  it("matches case-insensitively on textual patterns", () => {
    expect(classifyFailureReason("MISSING ENV VAR")).toBe("system_error");
    expect(classifyFailureReason("missing env var")).toBe("system_error");
  });

  it("does not match ENOENT inside unrelated words", () => {
    expect(classifyFailureReason("component tenONENT is broken")).toBe("decision");
  });
});
