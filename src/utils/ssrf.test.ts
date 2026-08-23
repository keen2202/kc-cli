// Direct unit tests for src/utils/ssrf.ts (round3 T07 / spec H2).
//
// ssrf.ts previously had zero direct tests; it was only exercised indirectly
// through WebFetchTool's mocked HTTP tests. These tests pin down the lexical
// classification contract (all address ranges), WHATWG URL normalization
// behavior (decimal/octal/hex host obfuscation), and the fail-closed
// assertFetchableUrl gate that closes the old parse-failure fail-open branch.
//
// NOTE on normalization: expectations below are pinned against Node's
// WHATWG URL parser (verified empirically), which canonicalizes hosts before
// isInternalUrl ever sees them.

import { describe, it, expect } from 'vitest';
import { isInternalUrl, assertFetchableUrl } from './ssrf';

describe('isInternalUrl', () => {
  describe('IPv4 loopback 127.0.0.0/8', () => {
    it.each([
      'http://127.0.0.1/',
      'http://127.0.0.0/',
      'http://127.1.2.3/',
      'http://127.255.255.254/',
      'http://127.0.0.1:8080/', // port must not matter
    ])('blocks %s', (url) => {
      expect(isInternalUrl(url)).toBe(true);
    });

    it.each(['http://126.255.255.255/', 'http://128.0.0.1/'])('allows %s', (url) => {
      expect(isInternalUrl(url)).toBe(false);
    });
  });

  describe('IPv4 private 10.0.0.0/8', () => {
    it.each(['http://10.0.0.1/', 'http://10.255.255.255/', 'http://10.1.2.3/'])('blocks %s', (url) => {
      expect(isInternalUrl(url)).toBe(true);
    });
    it('allows just-outside addresses', () => {
      expect(isInternalUrl('http://11.0.0.1/')).toBe(false);
      expect(isInternalUrl('http://9.255.255.255/')).toBe(false);
    });
  });

  describe('IPv4 private 172.16.0.0/12', () => {
    it.each(['http://172.16.0.0/', 'http://172.16.0.1/', 'http://172.20.1.2/', 'http://172.31.255.255/'])(
      'blocks %s',
      (url) => {
        expect(isInternalUrl(url)).toBe(true);
      }
    );
    it('enforces exact /12 boundaries', () => {
      expect(isInternalUrl('http://172.15.255.255/')).toBe(false);
      expect(isInternalUrl('http://172.32.0.0/')).toBe(false);
      expect(isInternalUrl('http://172.32.0.1/')).toBe(false);
    });
  });

  describe('IPv4 private 192.168.0.0/16', () => {
    it.each(['http://192.168.0.0/', 'http://192.168.1.1/', 'http://192.168.255.255/'])('blocks %s', (url) => {
      expect(isInternalUrl(url)).toBe(true);
    });
    it('enforces exact /16 boundaries', () => {
      expect(isInternalUrl('http://192.167.0.1/')).toBe(false);
      expect(isInternalUrl('http://192.169.0.1/')).toBe(false);
    });
  });

  describe('IPv4 link-local 169.254.0.0/16 (incl. cloud metadata)', () => {
    it.each([
      'http://169.254.0.0/',
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.255.255/',
    ])('blocks %s', (url) => {
      expect(isInternalUrl(url)).toBe(true);
    });
    it('enforces exact /16 boundaries', () => {
      expect(isInternalUrl('http://169.253.255.255/')).toBe(false);
      expect(isInternalUrl('http://169.255.0.1/')).toBe(false);
    });
  });

  describe('IPv4 0.0.0.0/8 ("this network")', () => {
    it.each(['http://0.0.0.0/', 'http://0.1.2.3/', 'http://0.42.42.42/'])('blocks %s', (url) => {
      expect(isInternalUrl(url)).toBe(true);
    });
    it('allows 1.0.0.0', () => {
      expect(isInternalUrl('http://1.0.0.0/')).toBe(false);
    });
  });

  describe('named internal hosts', () => {
    it('blocks localhost in any case', () => {
      expect(isInternalUrl('http://localhost/')).toBe(true);
      expect(isInternalUrl('http://LOCALHOST/')).toBe(true);
    });
    it('strips one trailing dot from rooted FQDN spellings', () => {
      // WHATWG keeps the dot in the hostname (`new URL('http://localhost./').hostname === 'localhost.'`)
      expect(isInternalUrl('http://localhost./')).toBe(true);
      expect(isInternalUrl('http://example.com./')).toBe(false); // still public
    });
  });

  describe('IPv6 loopback ::1', () => {
    it('blocks bracketed and full-form spellings', () => {
      expect(isInternalUrl('http://[::1]/')).toBe(true);
      // WHATWG canonicalizes the expanded form back to ::1
      expect(isInternalUrl('http://[0:0:0:0:0:0:0:1]/')).toBe(true);
    });
  });

  describe('IPv6 unspecified ::', () => {
    it('blocks the all-zeros address (connects to local host)', () => {
      expect(isInternalUrl('http://[::]/')).toBe(true);
    });
  });

  describe('IPv6 unique-local fc00::/7', () => {
    it.each(['http://[fc00::]/', 'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fdff:ffff::]/'])(
      'blocks %s',
      (url) => {
        expect(isInternalUrl(url)).toBe(true);
      }
    );
    it('enforces fc/fd prefix boundaries', () => {
      expect(isInternalUrl('http://[fbff::]/')).toBe(false);
      expect(isInternalUrl('http://[fe00::]/')).toBe(false);
    });
  });

  describe('IPv6 link-local fe80::/10', () => {
    it.each(['http://[fe80::]/', 'http://[fe80::1]/', 'http://[febf:ffff::]/'])('blocks %s', (url) => {
      expect(isInternalUrl(url)).toBe(true);
    });
    it('enforces fe80-febf prefix boundaries', () => {
      expect(isInternalUrl('http://[fe7f::]/')).toBe(false);
      expect(isInternalUrl('http://[fec0::]/')).toBe(false);
    });
  });

  describe('WHATWG host normalization (obfuscation resistance)', () => {
    it('treats normalized decimal hosts as their dotted-quad equivalents', () => {
      // new URL('http://2130706433').hostname === '127.0.0.1'
      expect(isInternalUrl('http://2130706433')).toBe(true);
      // 192.168.0.1
      expect(isInternalUrl('http://3232235521')).toBe(true);
      // 169.254.169.254 (metadata service)
      expect(isInternalUrl('http://2852039166')).toBe(true);
    });

    it('normalizes hex host forms', () => {
      expect(isInternalUrl('http://0x7f000001')).toBe(true); // -> 127.0.0.1
      expect(isInternalUrl('http://0x7f.0.0.1')).toBe(true); // -> 127.0.0.1
      expect(isInternalUrl('http://0xc0a80001')).toBe(true); // -> 192.168.0.1
    });

    it('normalizes octal host forms', () => {
      expect(isInternalUrl('http://0177.0.0.1')).toBe(true); // 0177 octal = 127
    });

    it('still allows public numeric-equivalent hosts', () => {
      expect(isInternalUrl('http://134744072')).toBe(false); // -> 8.8.8.8
      expect(isInternalUrl('http://0x08080808')).toBe(false);
    });
  });

  describe('IPv4-mapped IPv6 (::ffff:a.b.c.d)', () => {
    it('blocks mapped loopback/private targets via their hex serialization', () => {
      // Node serializes http://[::ffff:127.0.0.1] hostname as '[::ffff:7f00:1]'
      expect(isInternalUrl('http://[::ffff:127.0.0.1]/')).toBe(true);
      expect(isInternalUrl('http://[::ffff:10.0.0.1]/')).toBe(true);
      expect(isInternalUrl('http://[::ffff:7f00:1]/')).toBe(true);
    });
    it('allows mapped public targets', () => {
      expect(isInternalUrl('http://[::ffff:8.8.8.8]/')).toBe(false); // -> [::ffff:808:808]
    });
  });

  describe('public URLs pass through', () => {
    it.each([
      'http://example.com/',
      'https://github.com/',
      'http://8.8.8.8/',
      'http://172.15.0.1/', // outside every blocked range
      'http://[2001:db8::1]/', // documentation range, globally routable
      'http://sub.domain.example.co.uk/path?q=1',
    ])('allows %s', (url) => {
      expect(isInternalUrl(url)).toBe(false);
    });
  });

  describe('pure predicate semantics on unparseable input', () => {
    // Deliberate contract: isInternalUrl returns false ("not KNOWN internal")
    // for garbage input. Fail-closed rejection lives in assertFetchableUrl.
    it.each(['', 'not-a-url', 'http://', '//missing-scheme', 'http://[invalid'])(
      'returns false for %j (callers must use assertFetchableUrl)',
      (input) => {
        expect(isInternalUrl(input)).toBe(false);
      }
    );

    it('returns false for non-range schemes it cannot classify by host', () => {
      expect(isInternalUrl('ftp://example.com/file')).toBe(false);
      expect(isInternalUrl('file:///etc/passwd')).toBe(false);
    });
  });
});

describe('assertFetchableUrl', () => {
  describe('accepts fetchable public HTTP(S) URLs', () => {
    it('returns the parsed URL on success', () => {
      const verdict = assertFetchableUrl('https://example.com/page?a=1');
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.url).toBeInstanceOf(URL);
        expect(verdict.url.hostname).toBe('example.com');
      }
    });

    it('accepts pre-parsed URL objects (redirect-hop shape)', () => {
      const verdict = assertFetchableUrl(new URL('/next', 'https://public.example.com'));
      expect(verdict.ok).toBe(true);
    });
  });

  describe('rejects unparseable URLs (fail-closed)', () => {
    it.each(['', 'not-a-url', 'http://', '//missing-scheme', 'http://[invalid', 'ht!tp://weird'])(
      'blocks %j with reason unparseable-url',
      (input) => {
        const verdict = assertFetchableUrl(input);
        expect(verdict.ok).toBe(false);
        if (!verdict.ok) {
          expect(verdict.reason).toBe('unparseable-url');
          expect(verdict.message).toMatch(/unparseable/i);
        }
      }
    );

    it('blocks zone-id hosts that WHATWG parsing rejects', () => {
      const verdict = assertFetchableUrl('http://[fe80::1%25eth0]/');
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('unparseable-url');
    });

    it('truncates oversized raw input in the error message', () => {
      // NOTE: a merely-long hostname still parses (WHATWG has no parse-time
      // length limit), so use a long input that genuinely fails to parse.
      const verdict = assertFetchableUrl(`http://[${'a'.repeat(500)}`);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toBe('unparseable-url');
        expect(verdict.message.length).toBeLessThan(300);
      }
    });
  });

  describe('rejects non-fetchable schemes', () => {
    it.each([
      ['file:///etc/passwd', 'file:'],
      ['ftp://example.com/file.txt', 'ftp:'],
      ['javascript:alert(1)', 'javascript:'],
      ['data:text/html,hello', 'data:'],
    ])('blocks %s (%s)', (input, protocol) => {
      const verdict = assertFetchableUrl(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toBe('unsupported-protocol');
        expect(verdict.message).toContain(protocol);
      }
    });
  });

  describe('rejects internal-network targets', () => {
    it.each([
      'http://127.0.0.1/',
      'http://10.1.2.3/',
      'http://172.20.1.2/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/',
      'http://localhost/',
      'http://localhost./',
      'http://2130706433', // WHATWG-normalized decimal loopback
      'http://0177.0.0.1', // octal loopback
      'http://[::1]/',
      'http://[::]/',
      'http://[fd12:3456::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/', // IPv4-mapped loopback
    ])('blocks %s with reason internal-network', (input) => {
      const verdict = assertFetchableUrl(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.reason).toBe('internal-network');
        expect(verdict.message).toMatch(/ssrf|internal/i);
      }
    });

    it('blocks internal URL objects passed directly', () => {
      const verdict = assertFetchableUrl(new URL('/admin', 'http://10.0.0.5'));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('internal-network');
    });
  });

  describe('combination order (parse > protocol > range)', () => {
    it('reports unparseable-url before any scheme/range evaluation', () => {
      const verdict = assertFetchableUrl('totally not a url');
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('unparseable-url');
    });
  });
});
