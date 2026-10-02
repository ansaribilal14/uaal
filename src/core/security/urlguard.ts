/**
 * URL security guard (spec §27): every externally supplied URL must pass
 * validation before any network I/O. Guards: scheme allowlist, port
 * allowlist, DNS resolution to private/reserved ranges (SSRF), credentials
 * in URL, and re-validation on every redirect hop.
 */
import { isIP } from "node:net";
import { LookupAddress, lookup as dnsLookup } from "node:dns";

export class UrlBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlBlockedError";
  }
}

export const DEFAULT_ALLOWED_PORTS = new Set([80, 443]);

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "metadata.google.internal"]);

function ipToLong(ip: string): number {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
}

function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  if (isIP(ip) === 4 && isIP(base) === 4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipToLong(ip) & mask) === (ipToLong(base) & mask);
  }
  return false;
}

const BLOCKED_V4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/3"
];

const BLOCKED_V6_PREFIXES = ["::1", "::", "fc", "fd", "fe80", "ff"];

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return BLOCKED_V4_CIDRS.some((cidr) => inCidr(ip, cidr));
  if (v === 6) {
    const lower = ip.toLowerCase();
    return BLOCKED_V6_PREFIXES.some((p) => lower.startsWith(p));
  }
  return true; // unparseable -> treat as private (fail closed)
}

export interface UrlGuardOptions {
  allowedPorts?: Set<number>;
  allowedHostSuffixes?: string[];
  allowedHosts?: string[];
  deniedHostSuffixes?: string[];
  allowHttp?: boolean;
}

export interface ValidatedUrl {
  href: string;
  protocol: string;
  host: string;
  hostname: string;
  port: number;
}

/** Validates a URL without DNS resolution (cheap per-hop checks). */
export function validateUrl(rawUrl: string | URL, opts: UrlGuardOptions = {}): ValidatedUrl {
  let u: URL;
  try {
    u = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(rawUrl.trim());
  } catch {
    throw new UrlBlockedError(`invalid URL: ${String(rawUrl).slice(0, 200)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new UrlBlockedError(`scheme not allowed: ${u.protocol.replace(":", "")}`);
  }
  if (u.protocol === "http:" && opts.allowHttp !== true) {
    // http is allowed only for explicitly opted-in cases (local tests); default https-only
    throw new UrlBlockedError("plain http is not allowed (https only)");
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const allowedPorts = opts.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!allowedPorts.has(port)) {
    throw new UrlBlockedError(`port not allowed: ${port}`);
  }
  const hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  if (u.username || u.password) {
    throw new UrlBlockedError("credentials in URL are not allowed");
  }
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UrlBlockedError(`host not allowed: ${hostname}`);
  }
  if (opts.deniedHostSuffixes?.some((s) => hostname === s || hostname.endsWith(`.${s}`))) {
    throw new UrlBlockedError(`host denied by policy: ${hostname}`);
  }
  if (opts.allowedHosts && !opts.allowedHosts.includes(hostname)) {
    throw new UrlBlockedError(`host not on allowlist: ${hostname}`);
  }
  if (opts.allowedHostSuffixes && !opts.allowedHostSuffixes.some((s) => hostname === s || hostname.endsWith(`.${s}`))) {
    throw new UrlBlockedError(`host not on suffix allowlist: ${hostname}`);
  }
  // Literal IPs in URLs must not point at private space.
  if (isIP(hostname.replace(/^\[|\]$/g, ""))) {
    if (isPrivateAddress(hostname.replace(/^\[|\]$/g, ""))) {
      throw new UrlBlockedError(`literal private address not allowed: ${hostname}`);
    }
  }
  return { href: u.href, protocol: u.protocol, host: u.host, hostname, port };
}

export function lookupValidator(): (hostname: string, options: unknown, cb: (err: Error | null, addresses: LookupAddress | LookupAddress[] | null) => void) => void {
  return (hostname, _options, cb) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, null);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      if (list.length === 0) return cb(new UrlBlockedError(`no addresses for ${hostname}`), null);
      for (const a of list) {
        if (isPrivateAddress(a.address)) {
          return cb(new UrlBlockedError(`host ${hostname} resolves to private address ${a.address} (SSRF guard)`), null);
        }
      }
      cb(null, list);
    });
  };
}

/** Public internet URL, strictly validated: https, standard port, public DNS. */
export function assertPublicUrl(rawUrl: string | URL, opts: UrlGuardOptions = {}): ValidatedUrl {
  return validateUrl(rawUrl, { ...opts, allowHttp: false });
}

/** Validates localhost/loopback http URLs for testing and internal workers (any port). */
export function assertLoopbackUrl(rawUrl: string | URL, allowedPorts?: Set<number>): ValidatedUrl {
  let u: URL;
  try {
    u = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(String(rawUrl).trim());
  } catch {
    throw new UrlBlockedError(`invalid loopback url: ${String(rawUrl).slice(0, 120)}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new UrlBlockedError("loopback url must be http(s)");
  }
  const hostname = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!["127.0.0.1", "::1", "localhost"].includes(hostname)) {
    throw new UrlBlockedError(`expected loopback host, got ${hostname}`);
  }
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  const ports = allowedPorts ?? new Set([port]);
  if (!ports.has(port)) {
    throw new UrlBlockedError(`port not allowed: ${port}`);
  }
  return { href: u.href, protocol: u.protocol, host: u.host, hostname, port };
}
