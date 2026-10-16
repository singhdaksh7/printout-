import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordPolicyProblem } from '../src/password-policy.js';

describe('password-policy.ts', () => {
  // .gitleaks.toml allowlists this one file because its common-password denylist trips the generic secret rule. That makes
  // this test the guard for the file itself: it may contain nothing but the known weak entries, never a credential or token.
  it('contains only the known denylist entries as string literals (the file is allowlisted in .gitleaks.toml)', () => {
    const source = readFileSync(path.resolve(__dirname, '../src/password-policy.ts'), 'utf8');
    const literals = [...source.matchAll(/'([^'\n]*)'/g)].map((m) => m[1]);
    expect(literals).toEqual([
      'password1234',
      'password12345',
      'passwordpassword',
      'qwertyuiop12',
      'qwertyuiopas',
      'administrator',
      'administrator1',
      '123456789012',
      '1234567890123',
      'adminadmin12',
      'letmeinletmein',
      'iloveyouiloveyou',
      '@'
    ]);
    expect(source).not.toMatch(/"[^"\n]{8,}"|`[^`\n$]{20,}`/); // no other long literals either
  });

  it('enforces length, placeholder, repetition, denylist and email-name rules with the given label', () => {
    const problem = (pw: string, email?: string) => passwordPolicyProblem(pw, email, 'Password');
    expect(problem('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    expect(problem('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`);
    expect(problem('please-change-this-now')).toBe('Password looks like a placeholder');
    expect(problem('aaaaaaaaaaaaaaaa')).toBe('Password is too repetitive');
    expect(problem('PasswordPassword')).toBe('Password is a commonly used password');
    expect(problem('my-root-account-pw-1', 'root@x.test')).toBe('Password must not contain the email name');
    expect(problem('a-long-unrelated-passphrase-7', 'root@x.test')).toBeUndefined();
  });
});
