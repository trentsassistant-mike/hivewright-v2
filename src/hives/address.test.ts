import { describe, expect, it } from "vitest";
import {
  generateHiveAddress,
  hiveAddressesEqual,
  isValidHiveAddress,
  validateHiveAddress,
} from "./address";

describe("hive addresses", () => {
  it("generates a lowercase dash-separated address from an owner-facing name", () => {
    expect(generateHiveAddress("  Trent's New Hive!  ")).toBe("trent-s-new-hive");
  });

  it("validates generated and custom hive addresses", () => {
    expect(isValidHiveAddress("trent-hive-2")).toBe(true);
    expect(isValidHiveAddress("Trent Hive")).toBe(false);
    expect(isValidHiveAddress("a")).toBe(false);
  });

  describe("generateHiveAddress stability", () => {
    it("produces the same address when called repeatedly with the same input", () => {
      const input = "Trent's New Hive";
      const first = generateHiveAddress(input);
      const second = generateHiveAddress(input);
      const third = generateHiveAddress(input);

      expect(first).toBe(second);
      expect(second).toBe(third);
      expect(first).toBe("trent-s-new-hive");
    });

    it("normalizes inputs that already look like addresses to the same value", () => {
      expect(generateHiveAddress("trent-hive")).toBe("trent-hive");
      expect(generateHiveAddress(generateHiveAddress("My Hive"))).toBe(generateHiveAddress("My Hive"));
    });
  });

  describe("validateHiveAddress", () => {
    it("returns the normalized address for a normal hive name", () => {
      const result = validateHiveAddress("Trent's Cool Hive");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.address).toBe("trent-s-cool-hive");
    });

    it("rejects an empty input as empty", () => {
      const result = validateHiveAddress("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("empty");
        expect(typeof result.error.message).toBe("string");
        expect(result.error.message.length).toBeGreaterThan(0);
      }
    });

    it("rejects whitespace-only input as empty", () => {
      const result = validateHiveAddress("   ");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("empty");
    });

    it("rejects names whose normalization is empty", () => {
      const result = validateHiveAddress("!!!---!!!");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("empty");
    });

    it("rejects normalized addresses that are too short", () => {
      const result = validateHiveAddress("a");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("too_short");
    });

    it("normalizes a manually-entered custom address with mixed case", () => {
      const result = validateHiveAddress("MY-Custom-Hive");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.address).toBe("my-custom-hive");
    });

    it("strips disallowed punctuation from a manually-entered custom address", () => {
      const result = validateHiveAddress("hello@world!");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.address).toBe("hello-world");
    });

    it("never produces an address that fails isValidHiveAddress on success", () => {
      for (const input of ["My Hive", "Trent's Hive", "ab", "X-Y-Z", "a1b2"]) {
        const result = validateHiveAddress(input);
        if (result.ok) {
          expect(isValidHiveAddress(result.address)).toBe(true);
        }
      }
    });
  });

  describe("hiveAddressesEqual", () => {
    it("treats two addresses with different cases as duplicates", () => {
      expect(hiveAddressesEqual("trent-hive", "Trent-Hive")).toBe(true);
    });

    it("treats addresses that normalize to the same value as duplicates", () => {
      expect(hiveAddressesEqual("Trent's Hive", "trent-s-hive")).toBe(true);
    });

    it("treats different addresses as not equal", () => {
      expect(hiveAddressesEqual("trent-hive", "trent-hive-2")).toBe(false);
    });

    it("returns false when either side normalizes to empty", () => {
      expect(hiveAddressesEqual("", "trent-hive")).toBe(false);
      expect(hiveAddressesEqual("!!!", "trent-hive")).toBe(false);
      expect(hiveAddressesEqual("", "")).toBe(false);
    });
  });
});
