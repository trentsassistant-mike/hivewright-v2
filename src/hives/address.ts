const HIVE_ADDRESS_REGEX = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function generateHiveAddress(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function isValidHiveAddress(address: string): boolean {
  return HIVE_ADDRESS_REGEX.test(address);
}

export type HiveAddressValidationErrorCode = "empty" | "too_short";

export interface HiveAddressValidationError {
  code: HiveAddressValidationErrorCode;
  message: string;
}

export type HiveAddressValidationResult =
  | { ok: true; address: string }
  | { ok: false; error: HiveAddressValidationError };

export function validateHiveAddress(input: string): HiveAddressValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return {
      ok: false,
      error: {
        code: "empty",
        message: "Please enter a hive name to generate a hive address.",
      },
    };
  }

  const address = generateHiveAddress(input);

  if (address === "") {
    return {
      ok: false,
      error: {
        code: "empty",
        message: "We could not build a hive address from that name. Please use letters or numbers.",
      },
    };
  }

  if (!isValidHiveAddress(address)) {
    return {
      ok: false,
      error: {
        code: "too_short",
        message: "Hive addresses must be at least two characters long.",
      },
    };
  }

  return { ok: true, address };
}

export function hiveAddressesEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const normalizedA = generateHiveAddress(a);
  const normalizedB = generateHiveAddress(b);
  if (normalizedA === "" || normalizedB === "") return false;
  return normalizedA === normalizedB;
}
