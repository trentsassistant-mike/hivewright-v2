import * as dns from "node:dns/promises";
import net from "node:net";

export class HttpWebhookBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpWebhookBlockedError";
  }
}

export interface HttpWebhookDestination {
  url: URL;
  hostname: string;
  addresses: string[];
}

type DnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

let dnsLookup: DnsLookup = dns.lookup as DnsLookup;

export function setHttpWebhookDnsLookupForTests(lookupForTests: DnsLookup | null): void {
  dnsLookup = lookupForTests ?? (dns.lookup as DnsLookup);
}

export function parseAllowedHostnames(value: unknown): string[] {
  if (typeof value !== "string") return [];

  const normalized = value
    .split(/[\s,]+/)
    .map(normalizeHostname)
    .filter((hostname): hostname is string => Boolean(hostname));

  return Array.from(new Set(normalized));
}

export async function validateHttpWebhookDestination(
  rawUrl: string,
  allowedHostnamesConfig: unknown,
): Promise<HttpWebhookDestination> {
  const allowedHostnames = parseAllowedHostnames(allowedHostnamesConfig);
  if (allowedHostnames.length === 0) {
    throw new HttpWebhookBlockedError(
      "http-webhook is disabled until Allowed hostnames is configured",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpWebhookBlockedError("http-webhook target URL is invalid");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpWebhookBlockedError("http-webhook only supports HTTP(S) URLs");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || !allowedHostnames.includes(hostname)) {
    throw new HttpWebhookBlockedError(
      `http-webhook hostname ${url.hostname} is not in Allowed hostnames`,
    );
  }

  let answers: Array<{ address: string }>;
  try {
    answers = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw new HttpWebhookBlockedError(
      `http-webhook DNS resolution failed for ${hostname}: ${(error as Error).message}`,
    );
  }

  if (answers.length === 0) {
    throw new HttpWebhookBlockedError(`http-webhook DNS returned no addresses for ${hostname}`);
  }

  const addresses = answers.map((answer) => answer.address);
  const unsafeAddress = addresses.find((address) => !isPublicIpAddress(address));
  if (unsafeAddress) {
    throw new HttpWebhookBlockedError(
      `http-webhook destination resolved to unsafe address ${unsafeAddress}`,
    );
  }

  return { url, hostname, addresses };
}

function normalizeHostname(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) return null;

  try {
    return new URL(`http://${trimmed}`).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

function isPublicIpAddress(address: string): boolean {
  const ipv4Mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (ipv4Mapped) return isPublicIpv4Address(ipv4Mapped[1]);

  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4Address(address);
  if (family === 6) return isPublicIpv6Address(address);
  return false;
}

function isPublicIpv4Address(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = octets;
  if (a === 0) return false;
  if (a === 10) return false;
  if (a === 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 192 && b === 0) return false;
  if (a === 192 && b === 0 && octets[2] === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0 && octets[2] === 113) return false;
  if (a >= 224) return false;

  return true;
}

function isPublicIpv6Address(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;

  const firstHextetText = normalized.startsWith("::")
    ? "0"
    : normalized.split(":")[0];
  const firstHextet = Number.parseInt(firstHextetText, 16);
  if (!Number.isFinite(firstHextet)) return false;

  if ((firstHextet & 0xffc0) === 0xfe80) return false;
  if ((firstHextet & 0xfe00) === 0xfc00) return false;
  if ((firstHextet & 0xff00) === 0xff00) return false;
  if ((firstHextet & 0xe000) !== 0x2000) return false;
  if (normalized.startsWith("2001:db8:") || normalized === "2001:db8::") {
    return false;
  }

  return true;
}
