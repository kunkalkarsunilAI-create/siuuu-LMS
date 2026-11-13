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

function createSession(db, userId, now = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, now + SESSION_TTL_MS);
  return token;
}

function userFromToken(db, token, now = Date.now()) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.roll_no, u.department
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, now);
  return row ? { ...row } : null;
}

function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = { INITIAL_ROLL_NO, checkLogin, hashPassword, verifyPassword,createSession, userFromToken, destroySession };
