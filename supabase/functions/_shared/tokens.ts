const PREFIX = 'amm_';

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return PREFIX + b64url;
}

/** Lowercase hex SHA-256 of the token. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function looksLikeToken(s: string): boolean {
  return /^amm_[A-Za-z0-9_-]{43}$/.test(s);
}
