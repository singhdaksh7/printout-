/**
 * Password policy shared by the admin CLI tools (bootstrap-admin, update-admin) and the admin account API, so every
 * path that sets a platform-admin password enforces the same rules.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
const PLACEHOLDER = /change-?this|change-?me|replace|placeholder|your-?password|example/i;
const COMMON = new Set([
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
  'iloveyouiloveyou'
]);

/** Returns a human-readable reason when the password is not acceptable, otherwise undefined. `label` prefixes the message. */
export function passwordPolicyProblem(password: string, email: string | undefined, label: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `${label} must be at most ${MAX_PASSWORD_LENGTH} characters`;
  if (PLACEHOLDER.test(password)) return `${label} looks like a placeholder`;
  if (new Set(password).size < 5) return `${label} is too repetitive`;
  if (COMMON.has(password.toLowerCase())) return `${label} is a commonly used password`;
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) return `${label} must not contain the email name`;
  return undefined;
}
