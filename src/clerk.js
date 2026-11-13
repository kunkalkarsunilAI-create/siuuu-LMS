'use strict';
// Clerk sign-in, verified on our server with no npm dependencies.
//
// Flow:
//   1. The browser signs in with Clerk's hosted widget and gets a short-lived session token (a JWT).
//   2. It POSTs that token to /api/auth/clerk.
//   3. We verify the JWT's RS256 signature against Clerk's public key (JWKS, or CLERK_JWT_KEY),
//      plus expiry and issuer, then ask Clerk's Backend API for the user's verified email.
//   4. The email is matched against our own users table, which decides the role.
//      Clerk proves WHO you are; the college roster decides WHAT you can do.
const crypto = require('node:crypto');

const CLOCK_SKEW_S = 5;

// Publishable keys look like pk_test_<base64("your-app.clerk.accounts.dev$")>.
function frontendApiFromKey(publishableKey) {
  const m = /^pk_(test|live)_(.+)$/.exec(String(publishableKey || '').trim());
  if (!m) return null;
  try {
    const decoded = Buffer.from(m[2], 'base64').toString('utf8');
    return decoded.endsWith('$') && /^[a-z0-9.-]+$/i.test(decoded.slice(0, -1)) ? decoded.slice(0, -1) : null;
  } catch { return null; }
}

const b64urlJson = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

class ClerkError extends Error {
  constructor(message, status = 401, code = 'clerk') { super(message); this.status = status; this.code = code; }
}

function createClerk({ publishableKey, secretKey, jwtKey, apiUrl = 'https://api.clerk.com', authorizedParties = [], fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const frontendApi = frontendApiFromKey(publishableKey);
  if (!frontendApi) throw new Error('CLERK_PUBLISHABLE_KEY is not a valid Clerk publishable key (pk_test_… or pk_live_…).');
  if (!secretKey) throw new Error('CLERK_SECRET_KEY is missing.');
  const issuer = `https://${frontendApi}`;
  const pemKey = jwtKey ? crypto.createPublicKey(jwtKey.replace(/\\n/g, '\n')) : null;
  let jwks = new Map();
  let jwksFetchedAt = 0;

  async function keyFor(kid) {
    if (pemKey) return pemKey;
    if (!jwks.has(kid) && now() - jwksFetchedAt > 60_000) { // refresh at most once a minute (key rotation)
      const res = await fetchImpl(`${issuer}/.well-known/jwks.json`);
      if (!res.ok) throw new ClerkError('Could not reach Clerk to check your sign-in. Try again in a moment.', 503, 'jwks');
      const body = await res.json();
      jwks = new Map((body.keys || []).filter(k => k.kty === 'RSA').map(k => [k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })]));
      jwksFetchedAt = now();
    }
    const key = jwks.get(kid);
    if (!key) throw new ClerkError('Your sign-in could not be verified. Please sign in again.', 401, 'unknown_key');
    return key;
  }

  async function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new ClerkError('Missing or malformed sign-in token.', 401, 'malformed');
    let header, claims;
    try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); }
    catch { throw new ClerkError('Missing or malformed sign-in token.', 401, 'malformed'); }
    if (header.alg !== 'RS256') throw new ClerkError('Unsupported sign-in token.', 401, 'alg');
    const key = await keyFor(header.kid);
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!ok) throw new ClerkError('Your sign-in could not be verified. Please sign in again.', 401, 'signature');
    const t = Math.floor(now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < t) throw new ClerkError('Your sign-in has expired. Please sign in again.', 401, 'expired');
    if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_S > t) throw new ClerkError('Your sign-in is not valid yet. Check your device clock.', 401, 'nbf');
    if (claims.iss !== issuer) throw new ClerkError('This sign-in came from a different Clerk app.', 401, 'issuer');
    if (claims.azp && authorizedParties.length && !authorizedParties.includes(claims.azp)) {
      throw new ClerkError('This sign-in was made on a different website.', 401, 'azp');
    }
    if (!claims.sub) throw new ClerkError('Sign-in token has no user.', 401, 'sub');
    return claims;
  }

  // Ask Clerk's Backend API who this is. Only a verified primary email counts.
  async function getUser(userId) {
    const res = await fetchImpl(`${apiUrl.replace(/\/$/, '')}/v1/users/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${secretKey}` },
    });
    if (res.status === 401 || res.status === 403) throw new ClerkError('The server\'s Clerk secret key is wrong. Ask the site owner to check CLERK_SECRET_KEY.', 500, 'secret');
    if (!res.ok) throw new ClerkError('Could not reach Clerk to look up your account. Try again in a moment.', 503, 'backend');
    const u = await res.json();
    const primary = (u.email_addresses || []).find(e => e.id === u.primary_email_address_id) || (u.email_addresses || [])[0];
    return {
      id: u.id,
      email: primary ? String(primary.email_address).toLowerCase() : null,
      verified: primary?.verification?.status === 'verified',
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || null,
    };
  }

  return { frontendApi, issuer, publishableKey, verifyToken, getUser };
}

function clerkFromEnv(env = process.env, opts = {}) {
  if (!env.CLERK_PUBLISHABLE_KEY && !env.CLERK_SECRET_KEY) return null;
  return createClerk({
    publishableKey: env.CLERK_PUBLISHABLE_KEY,
    secretKey: env.CLERK_SECRET_KEY,
    jwtKey: env.CLERK_JWT_KEY || null,
    apiUrl: env.CLERK_API_URL || undefined,
    authorizedParties: (env.CLERK_AUTHORIZED_PARTIES || '').split(',').map(s => s.trim()).filter(Boolean),
    ...opts,
  });
}

module.exports = { createClerk, clerkFromEnv, frontendApiFromKey, ClerkError };
