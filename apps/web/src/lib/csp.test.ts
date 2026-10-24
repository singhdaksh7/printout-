// @vitest-environment node
// Regression guard for the production CSP (deploy/nginx-web.conf): Firebase phone sign-in loads the reCAPTCHA scripts and Google
// sign-in loads gapi, so exactly those script origins must be allowed, and nothing broader.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const conf = readFileSync(resolve(__dirname, '../../../../deploy/nginx-web.conf'), 'utf8');
const policies = [...conf.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]!);

function directive(policy: string, name: string): string[] {
  const d = policy.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `));
  return d ? d.split(/\s+/).slice(1) : [];
}

/** Host-source match as a browser does it: scheme + host exact, path prefix when the source ends in "/". */
function allows(sources: string[], url: string): boolean {
  const u = new URL(url);
  return sources.some((s) => {
    if (s === "'self'") return false; // the page's own origin is not under test here
    const src = new URL(s);
    if (src.origin !== u.origin) return false;
    return src.pathname === '/' || (s.endsWith('/') ? u.pathname.startsWith(src.pathname) : u.pathname === src.pathname);
  });
}

describe('nginx Content-Security-Policy', () => {
  it('is set on the HTML location', () => {
    expect(policies.length).toBeGreaterThan(0);
  });

  for (const policy of policies) {
    const scripts = directive(policy, 'script-src');

    it('allows the Firebase phone reCAPTCHA and Google sign-in scripts', () => {
      expect(scripts).toContain("'self'");
      expect(allows(scripts, 'https://www.google.com/recaptcha/api.js')).toBe(true);
      expect(allows(scripts, 'https://www.gstatic.com/recaptcha/releases/abc/recaptcha__en.js')).toBe(true);
      expect(allows(scripts, 'https://apis.google.com/js/api.js')).toBe(true);
    });

    it('keeps unrelated script origins blocked', () => {
      expect(allows(scripts, 'https://evil.example.com/x.js')).toBe(false);
      expect(allows(scripts, 'https://www.google.com/other/x.js')).toBe(false);
      expect(allows(scripts, 'https://www.gstatic.com/other/x.js')).toBe(false);
      expect(allows(scripts, 'https://cdn.jsdelivr.net/npm/x.js')).toBe(false);
      expect(allows(scripts, 'https://google.com.evil.example/recaptcha/api.js')).toBe(false);
    });

    it('adds no wildcards or unsafe script sources', () => {
      expect(scripts.filter((s) => s.includes('*') || s === 'https:' || s === 'http:' || s === 'data:')).toEqual([]);
      expect(scripts).not.toContain("'unsafe-inline'");
      expect(scripts).not.toContain("'unsafe-eval'");
    });

    it('keeps the other hardening directives', () => {
      expect(directive(policy, 'object-src')).toEqual(["'none'"]);
      expect(directive(policy, 'base-uri')).toEqual(["'self'"]);
      expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
    });
  }
});
