/** A post-login destination is honoured only when it is an in-app shop path. Anything else (other origins, protocol-relative, backslashes) falls back to /shop. */
export function safeShopRedirect(from: string | undefined | null): string {
  if (!from || typeof from !== 'string') return '/shop';
  if (/[\\\u0000-\u001f\u007f]/.test(from)) return '/shop';
  if (!/^\/shop(?:[/?#]|$)/.test(from)) return '/shop';
  if (/^\/shop\/login(?:[/?#]|$)/.test(from)) return '/shop';
  if (from.includes('//')) return '/shop';
  return from;
}
