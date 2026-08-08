import { isIP } from "node:net";
import { resolve4, resolve6 } from "node:dns/promises";

export class DailyProviderConfigurationError extends Error {
  readonly code = "daily_provider_configuration";
  constructor(message = "Daily Story provider configuration is invalid.") {
    super(message);
  }
}

export class DailyProviderDnsError extends Error {
  readonly code = "daily_provider_dns";
  constructor(message = "Daily Story provider address is not allowed.") {
    super(message);
  }
}

export type DailyProviderTarget = {
  baseUrl: URL;
  hostname: string;
  origin: string;
  basePath: string;
};

export type DailyProviderUrlPolicy = {
  production: boolean;
  /** Finite server-owned origins. Production rejects every other dynamic URL. */
  allowedOrigins: readonly string[];
};

type DnsResolver = {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
};

const nodeResolver: DnsResolver = { resolve4, resolve6 };

/** Parse once. Dynamic URLs must be canonical HTTPS DNS names with no escape hatches. */
export function parseDailyProviderBaseUrl(value: string): DailyProviderTarget {
  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch {
    throw new DailyProviderConfigurationError();
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.port !== "" && baseUrl.port !== "443")
  ) {
    throw new DailyProviderConfigurationError();
  }

  const hostname = baseUrl.hostname.toLowerCase().replace(/\.+$/, "");
  if (
    !hostname ||
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".local")
  ) {
    throw new DailyProviderConfigurationError();
  }
  // URL normalizes Unicode to punycode. Keep host syntax intentionally small.
  if (
    hostname.length > 253 ||
    !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new DailyProviderConfigurationError();
  }

  baseUrl.hostname = hostname;
  baseUrl.port = "";
  const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
  baseUrl.pathname = basePath;
  return { baseUrl, hostname, origin: baseUrl.origin, basePath };
}

/** URL joins cannot escape a provider's configured base path. */
export function joinDailyProviderPath(target: DailyProviderTarget, path: string) {
  if (!path || !path.startsWith("/") || path.includes("\\")) {
    throw new DailyProviderConfigurationError();
  }
  const joined = new URL(path.slice(1), target.baseUrl);
  if (joined.origin !== target.origin || !joined.pathname.startsWith(target.basePath)) {
    throw new DailyProviderConfigurationError();
  }
  return joined;
}

/**
 * Production accepts only finite server-owned origins. Arbitrary browser-supplied
 * hosts remain disabled until the Bun transport proof is shipped in release CI.
 */
export function assertDailyProviderUrlAllowed(value: string, policy: DailyProviderUrlPolicy) {
  const target = parseDailyProviderBaseUrl(value);
  if (!policy.production) return target;
  const allowedOrigins = new Set(
    policy.allowedOrigins.flatMap((origin) => {
      try {
        return [parseDailyProviderBaseUrl(origin).origin];
      } catch {
        return [];
      }
    }),
  );
  if (!allowedOrigins.has(target.origin)) throw new DailyProviderConfigurationError();
  return target;
}

/** Resolve all records on every request attempt; one unsafe answer fails whole set. */
export async function resolveDailyProviderPublicAddresses(
  hostname: string,
  resolver: DnsResolver = nodeResolver,
) {
  const [v4, v6] = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const addresses = [
    ...(v4.status === "fulfilled" ? v4.value : []),
    ...(v6.status === "fulfilled" ? v6.value : []),
  ];
  if (addresses.length === 0 || addresses.some((address) => !isPublicInternetAddress(address))) {
    throw new DailyProviderDnsError();
  }
  return addresses.map((address) => ({ address, family: isIP(address) as 4 | 6 }));
}

export function isPublicInternetAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168 || b === 88 || b === 175)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

function isPublicIpv6(address: string) {
  const value = ipv6ToBigInt(address);
  if (value === undefined || value === 0n || value === 1n) return false;
  // IPv4-mapped answers are not useful as IPv6 transport and evade v4 policy.
  if (inIpv6Range(value, "00000000000000000000ffff00000000", 96)) return false;
  if (inIpv6Range(value, "fc000000000000000000000000000000", 7)) return false; // ULA
  if (inIpv6Range(value, "fe800000000000000000000000000000", 10)) return false; // link-local
  if (inIpv6Range(value, "ff000000000000000000000000000000", 8)) return false; // multicast
  if (inIpv6Range(value, "20010db8000000000000000000000000", 32)) return false; // documentation
  if (inIpv6Range(value, "20010002000000000000000000000000", 48)) return false; // benchmarking
  if (inIpv6Range(value, "3fff0000000000000000000000000000", 20)) return false; // documentation
  return true;
}

function inIpv6Range(value: bigint, baseHex: string, prefixBits: number) {
  const base = BigInt(`0x${baseHex}`);
  const shift = BigInt(128 - prefixBits);
  return value >> shift === base >> shift;
}

function ipv6ToBigInt(value: string) {
  const lower = value.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(lower)) return undefined;
  const [leftRaw, rightRaw, ...extra] = lower.split("::");
  if (extra.length > 0) return undefined;
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if (
    left.some((part) => !part || part.length > 4) ||
    right.some((part) => !part || part.length > 4)
  ) {
    return undefined;
  }
  const missing = 8 - left.length - right.length;
  const groups = lower.includes("::") ? [...left, ...Array(missing).fill("0"), ...right] : left;
  if (missing < 1 && lower.includes("::")) return undefined;
  if (groups.length !== 8) return undefined;
  try {
    return groups.reduce((result, group) => (result << 16n) + BigInt(`0x${group}`), 0n);
  } catch {
    return undefined;
  }
}
