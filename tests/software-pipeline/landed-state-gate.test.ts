import { describe, expect, it } from "vitest";
import { verifyLandedState } from "../../src/software-pipeline/landed-state-gate";

describe("verifyLandedState", () => {
  it("accepts a clean main worktree containing the expected commit", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: ["abc123"],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "main\n";
        if (args.join(" ") === "status --porcelain") return "";
        if (args.join(" ") === "merge-base --is-ancestor abc123 HEAD") return "";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("fails when verification is run from a task branch instead of main", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: [],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "hw/task/example-dev-agent\n";
        if (args.join(" ") === "status --porcelain") return "";
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("Expected current branch main, got hw/task/example-dev-agent.");
  });

  it("fails when the required work commit is not landed on the current branch", async () => {
    const result = await verifyLandedState({
      expectedBranch: "main",
      requiredAncestors: ["2ac34ff"],
      git: async (args) => {
        if (args.join(" ") === "branch --show-current") return "main\n";
        if (args.join(" ") === "status --porcelain") return "";
        if (args.join(" ") === "merge-base --is-ancestor 2ac34ff HEAD") {
          throw Object.assign(new Error("not ancestor"), { status: 1 });
        }
        throw new Error(`unexpected git args: ${args.join(" ")}`);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain("Required commit 2ac34ff is not an ancestor of HEAD.");
  });
});
