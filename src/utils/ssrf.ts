// SSRF protection — internal/private network URL detection.
//
// Shared by WebFetchTool (initial URL + every redirect hop) and the permission
// engine's security-critical check. Keeping this in utils avoids a layering
// inversion where the permissions core would depend on a tool module.
//
// ─── Threat-model boundary (accepted limitation) ─────────────────────────────
//
// This module is purely LEXICAL: it classifies the WHATWG-normalized hostname
// of a URL string. It performs NO DNS resolution whatsoever. Consequently:
//
//   * A hostname whose DNS records point at an internal address
//     (e.g. `internal.corp` -> 10.0.0.5) is NOT detected here.
//   * DNS rebinding / TOCTOU between this check and the actual connect is out
//     of scope by design: a public-looking name that resolves to a public IP
//     during this check and to 127.0.0.1 at fetch time defeats this guard.
//   * Non-special schemes and hosts with zone identifiers (`fe80::1%eth0`)
//     fail WHATWG parsing entirely and are only handled by the fail-closed
//     `assertFetchableUrl` gate below, never by `isInternalUrl`.
//
// These gaps are documented as an accepted limitation in
// docs/specs/audit-remediation-round3-spec.md §H2 ("SSRF fail-open 收紧 +
// DNS 局限文档化"); a pre-fetch `dns.lookup` + IP re-check is tracked there as
// a P2 follow-up and is deliberately NOT implemented in this module so that it
// stays synchronous, dependency-free, and trivially unit-testable.
//
// Fail-open / fail-closed contract:
//   * `isInternalUrl` is a pure predicate and returns FALSE for unparseable
//     input (it cannot classify what it cannot parse). That return value means
//     "not known to be internal", NOT "safe to fetch".
//   * Callers that need fail-closed semantics MUST go through
//     `assertFetchableUrl`, which treats unparseable URLs as not fetchable and
//     pins the allowed schemes. WebFetchTool routes every fetch target (the
//     initial URL and each redirect hop) through it.

/**
 * Determine whether a URL targets an internal, loopback, private, or
 * link-local network address that must not be fetched (SSRF protection).
 *
 * Covered ranges (after WHATWG URL normalization):
 *   - localhost, 0.0.0.0/8 ("this host" range)
 *   - IPv4 loopback 127.0.0.0/8
 *   - RFC 1918 private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - Link-local 169.254.0.0/16 (incl. cloud metadata 169.254.169.254)
 *   - IPv6 unspecified :: and loopback ::1
 *   - IPv6 unique-local fc00::/7 (fc00:: – fdff::)
 *   - IPv6 link-local fe80::/10 (fe80:: – febf::)
 *   - IPv4-mapped IPv6 (::ffff:a.b.c.d), incl. its hex serialization
 *
 * WHATWG normalization notes (verified against Node's URL parser):
 *   `http://2130706433`, `http://0x7f000001` and `http://0177.0.0.1` all
 *   normalize to hostname `127.0.0.1`; `[0:0:0:0:0:0:0:1]` to `[::1]` — so
 *   decimal/hex/octal host-obfuscation forms are caught by the same checks as
 *   their canonical spellings. A single trailing dot (`localhost.`) is stripped
 *   before matching so rooted FQDN spellings cannot dodge the named-host list.
 *
 * @param input URL string or URL object
 * @returns true if the host resolves to an internal/private range;
 *          false for unparseable input (use {@link assertFetchableUrl} to
 *          reject those instead)
 */
export function isInternalUrl(input: string | URL): boolean {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    // Pure predicate semantics: unparseable input is "not known internal".
    // Fail-closed callers use assertFetchableUrl instead.
    return false;
  }

  // Normalize: lowercase + strip IPv6 brackets ([::1] -> ::1)
  // + strip one trailing dot (FQDN root form: `localhost.` -> `localhost`).
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');

  if (!hostname) return false;

  // Named internal hosts
  if (hostname === 'localhost' || hostname === '0.0.0.0') return true;

  // IPv6 unspecified / loopback / unique-local / link-local
  if (hostname === '::' || hostname === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(hostname)) return true; // fe80::/10

  // IPv4-mapped IPv6 (::ffff:a.b.c.d). Node serializes the mapped form with
  // hex hextets ([::ffff:127.0.0.1] -> [::ffff:7f00:1]), so classify the
  // embedded v4 bytes with the same range rules; the dotted spelling inside
  // the brackets is handled defensively in case a parser preserves it.
  const mappedHex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const g1 = parseInt(mappedHex[1], 16);
    if (isInternalIpv4Range((g1 >> 8) & 0xff, g1 & 0xff)) return true;
  }
  const mappedDotted = hostname.match(/^::ffff:(\d{1,3})\.(\d{1,3})(?:\.|$)/);
  if (mappedDotted && isInternalIpv4Range(parseInt(mappedDotted[1], 10), parseInt(mappedDotted[2], 10))) {
    return true;
  }

  // IPv4 dotted-quad checks
  const ip = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip && isInternalIpv4Range(parseInt(ip[1], 10), parseInt(ip[2], 10))) {
    return true;
  }

  return false;
}

/** Classify an IPv4 address by its first two octets against the blocked ranges. */
function isInternalIpv4Range(o1: number, o2: number): boolean {
  if (o1 === 0) return true; // 0.0.0.0/8 ("this network")
  if (o1 === 127) return true; // loopback 127.0.0.0/8
  if (o1 === 10) return true; // private 10.0.0.0/8
  if (o1 === 192 && o2 === 168) return true; // private 192.168.0.0/16
  if (o1 === 169 && o2 === 254) return true; // link-local 169.254.0.0/16
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // private 172.16.0.0/12
  return false;
}

export type FetchabilityVerdict =
  | { readonly ok: true; readonly url: URL }
  | {
      readonly ok: false;
      /** Machine-readable rejection cause. */
      readonly reason: 'unparseable-url' | 'unsupported-protocol' | 'internal-network';
      /** Human-readable explanation suitable for tool-error/deny messages. */
      readonly message: string;
    };

const FETCHABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Fail-closed combination gate for fetch targets: parse + scheme pinning +
 * internal-range classification in one step.
 *
 * Unlike {@link isInternalUrl}, unparseable URLs are REJECTED here instead of
 * falling through the lexical predicate as "external". This closes the
 * round3-H2 fail-open branch: WebFetchTool must never treat garbage input as
 * fetchable just because it cannot be classified.
 *
 * Still a pure function (no fetch/DNS) — see the threat-model note at the top
 * of this file: a passing verdict does not protect against DNS rebinding.
 */
export function assertFetchableUrl(input: string | URL): FetchabilityVerdict {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    const raw = (typeof input === 'string' ? input : input.href).slice(0, 200);
    return {
      ok: false,
      reason: 'unparseable-url',
      message: `Blocked unparseable URL (SSRF fail-closed): ${JSON.stringify(raw)}`,
    };
  }

  if (!FETCHABLE_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      reason: 'unsupported-protocol',
      message: `Unsupported URL scheme "${url.protocol}" — only http: and https: are fetchable`,
    };
  }

  if (isInternalUrl(url)) {
    return {
      ok: false,
      reason: 'internal-network',
      message: `SSRF blocked: ${url.hostname} targets an internal/private network address`,
    };
  }

  return { ok: true, url };
}
