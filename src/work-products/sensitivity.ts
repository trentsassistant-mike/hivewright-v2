type Sensitivity = "public" | "internal" | "confidential" | "restricted";

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_REGEX = /(?:\+?61|0)\s?\d{3,4}\s?\d{3}\s?\d{3}/g;
const BSB_REGEX = /\b\d{3}-\d{3}\b/g;
const ACCOUNT_NUM_REGEX = /\b(?:account|acct)[:\s#]*\d{6,10}\b/gi;
const API_KEY_REGEX = /\b(?:sk-|pk-|api[_-]?key[:\s=]+)[a-zA-Z0-9_-]{10,}/gi;
const JWT_REGEX = /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g;
const PASSWORD_REGEX = /(?:password|passwd|secret)[:\s=]+\S{6,}/gi;

export function classifySensitivity(text: string): Sensitivity {
  if (containsCredentials(text)) return "restricted";
  if (EMAIL_REGEX.test(text) || PHONE_REGEX.test(text)) {
    EMAIL_REGEX.lastIndex = 0;
    PHONE_REGEX.lastIndex = 0;
    return "restricted";
  }
  if (BSB_REGEX.test(text) || ACCOUNT_NUM_REGEX.test(text)) {
    BSB_REGEX.lastIndex = 0;
    ACCOUNT_NUM_REGEX.lastIndex = 0;
    return "confidential";
  }
  return "internal";
}

export function redactPii(text: string): string {
  return text
    .replace(EMAIL_REGEX, "[REDACTED_EMAIL]")
    .replace(PHONE_REGEX, "[REDACTED_PHONE]");
}

export function containsCredentials(text: string): boolean {
  const has = API_KEY_REGEX.test(text) || JWT_REGEX.test(text) || PASSWORD_REGEX.test(text);
  API_KEY_REGEX.lastIndex = 0;
  JWT_REGEX.lastIndex = 0;
  PASSWORD_REGEX.lastIndex = 0;
  return has;
}
