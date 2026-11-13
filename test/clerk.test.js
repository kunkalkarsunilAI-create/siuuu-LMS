'use strict';
// Clerk sign-in, tested against a fake Clerk: real RSA keys, real JWT signatures,
// fake JWKS + Backend API responses. No network needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createClerk, frontendApiFromKey } = require('../src/clerk');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

const FAPI = 'proud-otter-12.clerk.accounts.dev';
const PK = 'pk_test_' + Buffer.from(FAPI + '$').toString('base64');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'ins_test', alg: 'RS256', use: 'sig' };

function sign(claims, { key = privateKey, kid = 'ins_test', alg = 'RS256' } = {}) {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg, kid, typ: 'JWT' });
  const body = enc(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const good = (sub = 'user_1', extra = {}) => sign({ sub, iss: `https://${FAPI}`, exp: nowS() + 60, nbf: nowS() - 5, iat: nowS(), sid: 'sess_1', ...extra });

// Fake Clerk: JWKS + Backend API users.
const USERS = {
  user_1: { email: 'priya.naik@dempo.edu', verified: true, first: 'Priya', last: 'Naik' },
  user_2: { email: 'stranger@gmail.com', verified: true, first: 'Some', last: 'One' },
  user_3: { email: 'unverified@dempo.edu', verified: false },
  user_4: { email: 'principal@dempo.edu', verified: true, first: 'The', last: 'Principal' },
};
const calls = [];
async function fakeFetch(url, opts = {}) {
  calls.push(url);
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  if (url === `https://${FAPI}/.well-known/jwks.json`) return json(200, { keys: [JWK] });
  const m = /\/v1\/users\/(.+)$/.exec(url);
  if (m) {
    if (opts.headers?.authorization !== 'Bearer sk_test_secret') return json(401, {});
    const u = USERS[decodeURIComponent(m[1])];
    if (!u) return json(404, {});
    return json(200, { id: m[1], first_name: u.first, last_name: u.last, primary_email_address_id: 'e1',
      email_addresses: [{ id: 'e1', email_address: u.email, verification: { status: u.verified ? 'verified' : 'unverified' } }] });
  }
  return json(404, {});
}
const clerk = createClerk({ publishableKey: PK, secretKey: 'sk_test_secret', fetchImpl: fakeFetch });

test('clerk: frontend API is derived from the publishable key', () => {
  assert.equal(frontendApiFromKey(PK), FAPI);
  assert.equal(frontendApiFromKey('nonsense'), null);
  assert.throws(() => createClerk({ publishableKey: 'pk_bad', secretKey: 'x' }), /not a valid Clerk publishable key/);
});

test('clerk: valid token accepted; forged, expired, wrong-app and wrong-alg tokens rejected', async () => {
  assert.equal((await clerk.verifyToken(good())).sub, 'user_1');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  await assert.rejects(clerk.verifyToken(good().slice(0, -4) + 'AAAA'), /could not be verified/);
  await assert.rejects(clerk.verifyToken(sign({ sub: 'user_1', iss: `https://${FAPI}`, exp: nowS() + 60 }, { key: other })), /could not be verified/);
  await assert.rejects(clerk.verifyToken(good('user_1', { exp: nowS() - 60 })), /expired/);
  await assert.rejects(clerk.verifyToken(good('user_1', { iss: 'https://evil.clerk.accounts.dev' })), /different Clerk app/);
  await assert.rejects(clerk.verifyToken(sign({ sub: 'x' }, { alg: 'none' })), /Unsupported/);
  await assert.rejects(clerk.verifyToken('not-a-jwt'), /malformed/);
});

test('clerk: authorized parties are enforced when configured', async () => {
  const strict = createClerk({ publishableKey: PK, secretKey: 'sk_test_secret', fetchImpl: fakeFetch, authorizedParties: ['https://siuuu-lms.vercel.app'] });
  assert.ok(await strict.verifyToken(good('user_1', { azp: 'https://siuuu-lms.vercel.app' })));
  await assert.rejects(strict.verifyToken(good('user_1', { azp: 'https://phish.example' })), /different website/);
});

test('clerk: CLERK_JWT_KEY (PEM) verifies without fetching JWKS', async () => {
  const before = calls.length;
  const pemOnly = createClerk({ publishableKey: PK, secretKey: 'sk_test_secret', jwtKey: publicKey.export({ type: 'spki', format: 'pem' }), fetchImpl: fakeFetch });
  assert.equal((await pemOnly.verifyToken(good())).sub, 'user_1');
  assert.equal(calls.slice(before).filter(u => u.includes('jwks')).length, 0);
});

// ---- the /api/auth/clerk endpoint ----
async function startApp(opts) {
  const { server, db } = createApp({ dbPath: ':memory:', clerk, ...opts });
  seed(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => {
    const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, data: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const get = async (url, cookie) => { const r = await fetch(base + url, { headers: { cookie } }); return { status: r.status, data: await r.json() }; };
  return { server, db, post, get };
}

test('auth/clerk: a roster email signs in with its own role; config exposes only the publishable key', async () => {
  const app = await startApp({ adminEmails: [] });
  try {
    const cfg = await app.get('/api/config');
    assert.equal(cfg.data.clerk.publishableKey, PK);
    assert.equal(cfg.data.clerk.frontendApi, FAPI);
    assert.doesNotMatch(JSON.stringify(cfg.data), /sk_test/);
    assert.equal(cfg.data.passwordLogin, false, 'password sign-in is off once Clerk is set up (outside demo mode)');
    const r = await app.post('/api/auth/clerk', { token: good('user_1') });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.role, 'faculty');
    const me = await app.get('/api/me', r.cookie);
    assert.equal(me.data.user.email, 'priya.naik@dempo.edu');
    // Password login is refused when Clerk is the sign-in method.
    const pw = await app.post('/api/login', { email: 'admin@dempo.edu', password: 'admin123' });
    assert.equal(pw.status, 403);
  } finally { app.server.close(); }
});

test('auth/clerk: unknown email is refused (production) or offered demo roles (demo mode)', async () => {
  const prod = await startApp({});
  try {
    const r = await prod.post('/api/auth/clerk', { token: good('user_2'), demoRole: 'admin' });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'not_on_roster');
    assert.deepEqual(r.data.demoRoles, []);
    assert.match(r.data.error, /stranger@gmail.com.*isn't on the college roster/);
  } finally { prod.server.close(); }

  const demo = await startApp({ demoMode: true });
  try {
    const first = await demo.post('/api/auth/clerk', { token: good('user_2') });
    assert.deepEqual(first.data.demoRoles, ['student', 'faculty', 'admin']);
    const asStudent = await demo.post('/api/auth/clerk', { token: good('user_2'), demoRole: 'student' });
    assert.equal(asStudent.status, 200);
    assert.equal(asStudent.data.user.email, 'aisha.dsouza@dempo.edu');
    assert.equal(asStudent.data.asDemo, true);
    const bogus = await demo.post('/api/auth/clerk', { token: good('user_2'), demoRole: 'superuser' });
    assert.equal(bogus.status, 403);
  } finally { demo.server.close(); }
});

test('auth/clerk: unverified email refused; ADMIN_EMAILS bootstraps an exam-office account', async () => {
  const app = await startApp({ adminEmails: ['Principal@dempo.edu'] });
  try {
    const unv = await app.post('/api/auth/clerk', { token: good('user_3') });
    assert.equal(unv.status, 403);
    assert.match(unv.data.error, /Verify unverified@dempo.edu/);
    const adm = await app.post('/api/auth/clerk', { token: good('user_4') });
    assert.equal(adm.status, 200);
    assert.equal(adm.data.user.role, 'admin');
    assert.equal(adm.data.user.name, 'The Principal');
    // That account has no password; password sign-in for it always fails.
    const row = app.db.prepare("SELECT password_hash FROM users WHERE email = 'principal@dempo.edu'").get();
    assert.equal(row.password_hash, 'clerk$only');
    const bad = await app.post('/api/auth/clerk', { token: 'garbage' });
    assert.equal(bad.status, 401);
  } finally { app.server.close(); }
});

test('auth/clerk: without Clerk configured the endpoint is off and password sign-in stays on', async () => {
  const { server, db } = createApp({ dbPath: ':memory:' }); seed(db);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cfg = await (await fetch(base + '/api/config')).json();
    assert.equal(cfg.clerk, null);
    assert.equal(cfg.passwordLogin, true);
    const r = await fetch(base + '/api/auth/clerk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 404);
  } finally { server.close(); }
});
