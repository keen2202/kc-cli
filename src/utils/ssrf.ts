// SSRF protection — internal/private network URL detection.
//
// Shared by WebFetchTool (initial URL + every redirect hop) and the permission
// engine's security-critical check. Keeping this in utils avoids a layering
// inversion where the permissions core would depend on a tool module.

/**
 * Determine whether a URL targets an internal, loopback, private, or
 * link-local network address that must not be fetched (SSRF protection).
 *
 * Covered ranges:
 *   - localhost, 0.0.0.0/8
 *   - IPv4 loopback 127.0.0.0/8
 *   - RFC 1918 private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - Link-local 169.254.0.0/16
 *   - IPv6 loopback ::1
 *   - IPv6 unique-local fc00::/7 (fc00:: – fdff::)
 *   - IPv6 link-local fe80::/10 (fe80:: – febf::)
 *
 * @param input URL string or URL object
 * @returns true if the host resolves to an internal/private range
 */
export function isInternalUrl(input: string | URL): boolean {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    // Unparseable input is not treated as internal; callers validate separately.
    return false;
  }

  // Normalize: lowercase + strip IPv6 brackets ([::1] -> ::1)
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (!hostname) return false;

  // Named internal hosts
  if (hostname === 'localhost' || hostname === '0.0.0.0') return true;

  // IPv6 loopback / unique-local / link-local
  if (hostname === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(hostname)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(hostname)) return true; // fe80::/10

  // IPv4 dotted-quad checks
  const ip = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const o1 = parseInt(ip[1], 10);
    const o2 = parseInt(ip[2], 10);
    if (o1 === 0) return true; // 0.0.0.0/8
    if (o1 === 127) return true; // loopback
    if (o1 === 10) return true; // private 10/8
    if (o1 === 192 && o2 === 168) return true; // private 192.168/16
    if (o1 === 169 && o2 === 254) return true; // link-local 169.254/16
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true; // private 172.16/12
  }

  return false;
}
