import { describe, it, expect } from "vitest";
import { classifySensitivity, redactPii, containsCredentials } from "@/work-products/sensitivity";

describe("classifySensitivity", () => {
  it("classifies clean hive text as internal", () => {
    expect(classifySensitivity("Revenue was up 15% this quarter")).toBe("internal");
  });

  it("detects PII and classifies as restricted", () => {
    expect(classifySensitivity("Customer email: john@example.com, phone: 0412345678")).toBe("restricted");
  });

  it("detects API keys and classifies as restricted", () => {
    expect(classifySensitivity("Use API key sk-abc123def456ghi789")).toBe("restricted");
  });

  it("detects BSB numbers and classifies as confidential", () => {
    expect(classifySensitivity("BSB: 062-000, Account: 12345678")).toBe("confidential");
  });
});

describe("redactPii", () => {
  it("redacts email addresses", () => {
    const result = redactPii("Contact john@example.com for details");
    expect(result).not.toContain("john@example.com");
    expect(result).toContain("[REDACTED_EMAIL]");
  });

  it("redacts phone numbers", () => {
    const result = redactPii("Call 0412 345 678 or +61 412 345 678");
    expect(result).toContain("[REDACTED_PHONE]");
  });
});

describe("containsCredentials", () => {
  it("detects API key patterns", () => {
    expect(containsCredentials("sk-abc123def456ghi789jkl")).toBe(true);
  });

  it("detects JWT patterns", () => {
    expect(containsCredentials("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toBe(true);
  });

  it("returns false for normal text", () => {
    expect(containsCredentials("This is a normal report about Q1 revenue")).toBe(false);
  });
});
