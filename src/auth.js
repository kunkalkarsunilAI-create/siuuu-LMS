'use strict';
const crypto = require('node:crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours: long enough for an exam day

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Marker stored for imported students who have never signed in: their password is their roll number.
const INITIAL_ROLL_NO = 'initial$roll_no';

// Checks a password for a user row. Upgrades the first-login marker to a real hash on success.
function checkLogin(db, user, password) {
  if (user.password_hash === INITIAL_ROLL_NO) {
    const ok = !!user.roll_no && String(password).trim().toUpperCase() === user.roll_no.toUpperCase();
    if (ok) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(user.roll_no.toUpperCase()), user.id);
    return ok;
  }
  return verifyPassword(password, user.password_hash);
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Sessions are signed cookies, not database rows, so a sign-in stays valid when a host
// (e.g. Vercel) sends the next request to a different copy of the app.
//   token = base64url(userId.expiresAt.email) . HMAC-SHA256(secret, payload)
// The secret comes from the SESSION_SECRET environment variable. Without it, a random
// secret is generated once and stored in the database (fine for local use).
function sessionSecret(db) {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get();
  if (row) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('session_secret', ?)").run(secret);
  return db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get().value;
}
const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

function createSession(db, userId, now = Date.now()) {
  const u = db.prepare('SELECT email FROM users WHERE id = ?').get(userId);
  const payload = Buffer.from(`${userId}.${now + SESSION_TTL_MS}.${u.email}`).toString('base64url');
  return `${payload}.${sign(sessionSecret(db), payload)}`;
}

function userFromToken(db, token, now = Date.now()) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(sessionSecret(db), payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  const [id, expires, ...emailParts] = Buffer.from(payload, 'base64url').toString().split('.');
  if (!(Number(expires) > now)) return null;
  const row = db.prepare('SELECT id, email, name, role, roll_no, department FROM users WHERE id = ?').get(Number(id));
  // The email check stops a token from one copy of the app matching a different person
  // who happens to have the same id in another copy's database.
  return row && row.email === emailParts.join('.') ? { ...row } : null;
}

// Signing out clears the cookie (done by the caller). Signed tokens can't be revoked
// server-side; they expire after SESSION_TTL_MS.
function destroySession() {}

module.exports = { INITIAL_ROLL_NO, checkLogin, hashPassword, verifyPassword,createSession, userFromToken, destroySession };
