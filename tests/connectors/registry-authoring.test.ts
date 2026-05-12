import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("connector registry authoring types", () => {
  it("does not keep optional operation safety metadata fallbacks in the normalizer", () => {
    const source = readFileSync(resolve(process.cwd(), "src/connectors/registry.ts"), "utf8");

    expect(source).not.toContain("ConnectorOperationDraft");
    expect(source).not.toContain("inputSchema: op.inputSchema ??");
    expect(source).not.toContain("outputSummary: op.outputSummary ??");
    expect(source).not.toContain("riskTier: op.governance.riskTier ??");
    expect(source).not.toContain("dryRunSupported: op.governance.dryRunSupported ??");
    expect(source).not.toContain("externalSideEffect: op.governance.externalSideEffect ??");
  });
});
