import { describe, it, expect } from "vitest";
import { createCredentialFingerprint, encrypt, decrypt } from "@/credentials/encryption";

const TEST_KEY = "p6-cred-test-encryption-key";

describe("encrypt / decrypt", () => {
  it("round-trips plaintext correctly", () => {
    const plaintext = "my-secret-api-key";
    const encrypted = encrypt(plaintext, TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different IVs on each call (non-deterministic)", () => {
    const plaintext = "same-value";
    const enc1 = encrypt(plaintext, TEST_KEY);
    const enc2 = encrypt(plaintext, TEST_KEY);
    expect(enc1).not.toBe(enc2);
    // Both still decrypt correctly
    expect(decrypt(enc1, TEST_KEY)).toBe(plaintext);
    expect(decrypt(enc2, TEST_KEY)).toBe(plaintext);
  });

  it("throws when decrypting with wrong key", () => {
    const encrypted = encrypt("secret", TEST_KEY);
    expect(() => decrypt(encrypted, "wrong-key")).toThrow();
  });

  it("handles empty string plaintext", () => {
    const encrypted = encrypt("", TEST_KEY);
    const decrypted = decrypt(encrypted, TEST_KEY);
    expect(decrypted).toBe("");
  });
});

describe("createCredentialFingerprint", () => {
  it("is deterministic for equivalent normalized provider and base URL inputs", () => {
    const first = createCredentialFingerprint({
      provider: " OpenRouter ",
      baseUrl: " HTTPS://OpenRouter.AI/api/v1/ ",
      secretValue: "secret-token",
    });
    const second = createCredentialFingerprint({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      secretValue: "secret-token",
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(second);
  });

  it("uses an empty token for missing base URLs", () => {
    const omitted = createCredentialFingerprint({
      provider: "anthropic",
      secretValue: "secret-token",
    });
    const blank = createCredentialFingerprint({
      provider: " anthropic ",
      baseUrl: "  ",
      secretValue: "secret-token",
    });

    expect(omitted).toBe(blank);
  });

  it("changes when provider, base URL, or secret changes", () => {
    const baseline = createCredentialFingerprint({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      secretValue: "secret-token",
    });

    expect(createCredentialFingerprint({
      provider: "openrouter",
      baseUrl: "https://api.anthropic.com",
      secretValue: "secret-token",
    })).not.toBe(baseline);
    expect(createCredentialFingerprint({
      provider: "anthropic",
      baseUrl: "https://gateway.example.com",
      secretValue: "secret-token",
    })).not.toBe(baseline);
    expect(createCredentialFingerprint({
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      secretValue: "different-secret",
    })).not.toBe(baseline);
  });
});
