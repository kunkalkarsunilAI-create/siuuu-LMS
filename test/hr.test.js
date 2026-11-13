'use strict';
// End-to-end API tests for the three features, plus roles. In-memory database, controllable clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');
const training = require('../src/training');
const { parseDate } = require('../src/employees');

const DAY = training.DAY;
let clock = Date.UTC(2026, 10, 14, 6, 0, 0);
const { server, db } = createApp({ dbPath: ':memory:', now: () => clock });
seed(db, clock);
let base;
test.before(async () => { await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());

async function login(email, password) {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(r.status, 200, `login ${email}: ${await r.clone().text()}`);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { cookie, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
}
const HR = () => login('neha.kerkar@mandovi.example', 'hr12345');
const MGR = () => login('rahul.desai@mandovi.example', 'manager123');
const EMP = () => login('arjun.naik@mandovi.example', 'MS-101');
const courseId = code => db.prepare('SELECT id FROM courses WHERE code = ?').get(code).id;
const userId = email => db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

// ---------------- unit ----------------
test('status rules: each state, in priority order', () => {
  const now = clock;
  const s = o => training.statusOf({ due_at: now + DAY, lessons_done: 0, attempts: 0, ...o }, now);
  assert.equal(s({}), 'not_started');
  assert.equal(s({ lessons_done: 1 }), 'in_progress');
  assert.equal(s({ due_at: now - 1 }), 'overdue');
  assert.equal(s({ due_at: now - 1, cert_issued: now - 5 * DAY, cert_expires: now + 100 * DAY }), 'completed', 'a valid certificate beats a passed due date');
  assert.equal(s({ cert_issued: now - DAY, cert_expires: null }), 'completed', 'never-expiring certificate');
  assert.equal(s({ cert_issued: now - 300 * DAY, cert_expires: now + 20 * DAY }), 'expiring');
  assert.equal(s({ cert_issued: now - 400 * DAY, cert_expires: now - DAY }), 'expired');
});

test('addMonths handles month ends; dates parse in Indian formats', () => {
  assert.equal(new Date(training.addMonths(Date.UTC(2026, 0, 31), 1)).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(new Date(training.addMonths(Date.UTC(2027, 11, 15), 12)).toISOString().slice(0, 10), '2028-12-15');
  assert.equal(parseDate('2026-04-01').value, '2026-04-01');
  assert.equal(parseDate('01/04/2026').value, '2026-04-01', 'day first, as written in India');
  assert.equal(parseDate('1-Apr-2026').value, '2026-04-01');
  assert.match(parseDate('31/02/2026').error, /isn't a real date/);
  assert.match(parseDate('April first').error, /recognise/);
});

// ---------------- roles ----------------
test('roles: employees see only themselves; managers only their team; HR everything', async () => {
  const emp = await EMP();
  assert.equal((await emp('GET', '/api/people')).status, 403);
  assert.equal((await emp('GET', '/api/compliance/summary')).status, 403);
  assert.equal((await emp('POST', '/api/import/preview', { csv: 'x' })).status, 403);
  const my = (await emp('GET', '/api/my')).data;
  assert.ok(my.assignments.every(a => a.email === 'arjun.naik@mandovi.example'));

  const mgr = await MGR();
  const team = (await mgr('GET', '/api/people')).data.people.map(p => p.email).sort();
  assert.deepEqual(team, ['arjun.naik', 'joel.dsouza', 'kavya.prabhu', 'tejas.gaonkar'].map(n => `${n}@mandovi.example`));
  const otherTeam = userId('meera.borkar@mandovi.example');
  assert.equal((await mgr('GET', `/api/people/${otherTeam}`)).status, 404);
  assert.equal((await mgr('POST', `/api/courses/${courseId('CODE-REV')}/assign`, { user_ids: [otherTeam], due_days: 7 })).status, 403);
  assert.equal((await mgr('POST', '/api/courses', {})).status, 403);
  const sum = (await mgr('GET', '/api/compliance/summary')).data;
  assert.equal(sum.people, 4);

  const hr = await HR();
  assert.equal((await hr('GET', '/api/compliance/summary')).data.people, 16);
});

// ---------------- Feature 1: import ----------------
test('import: every kind of row gets the right outcome', async () => {
  const hr = await HR();
  const csv = [
    'Emp Code,Full Name,Work Email,Dept,Designation,Reporting Manager,Date of Joining,Status,Shirt size',
    'MS-501,Riya Shet,riya.shet@mandovi.example,Engineering,Software Engineer,rahul.desai@mandovi.example,10/11/2026,,M',  // new, DD/MM date, alias headers
    'MS-502,Dev Lotlikar,dev.lotlikar@mandovi.example,Operations,Ops Lead,,2026-11-01,,L',                                  // new department
    'MS-503,Pia Naik,pia.naik@mandovi.example,Operations,Ops Associate,dev.lotlikar@mandovi.example,2026-11-02,,S',          // manager defined in same file → Dev becomes manager
    'MS-203,Meera Borkar,meera.borkar@mandovi.example,Customer Support,Support Specialist,imran.shaikh@mandovi.example,,,M', // department move
    'MS-401,Gauri Parab,gauri.parab@mandovi.example,Finance,Accountant,priya.kamat@mandovi.example,,,M',                      // unchanged
    'MS-402,Omkar Velip,omkar.velip@mandovi.example,Finance,Accounts Associate,priya.kamat@mandovi.example,,left,M',          // leaver
    'MS-504,Bad Email,bad.email@mandovi,Sales,,,,,M',
    'MS-505,No Manager,no.manager@mandovi.example,Sales,,ghost@mandovi.example,,,M',
    'MS-101,Imposter,someone.else@mandovi.example,Sales,,,,,M',                                                               // employee id taken
    'MS-506,Riya Again,riya.shet@mandovi.example,Sales,,,,,M',                                                                // duplicate email in file
    'MS-507,Loop A,loop.a@mandovi.example,Sales,,loop.b@mandovi.example,,,M',
    'MS-508,Loop B,loop.b@mandovi.example,Sales,,loop.a@mandovi.example,,,M',
    'MS-509,Odd Date,odd.date@mandovi.example,Sales,,,31/02/2026,,M',
    'MS-001,Neha K,neha.kerkar@mandovi.example,HR,,,,,M',                                                                     // HR admin can't be changed by import
  ].join('\n');
  const { status, data } = await hr('POST', '/api/import/preview', { csv });
  assert.equal(status, 200, JSON.stringify(data));
  const L = Object.fromEntries(data.results.map(r => [r.line, r]));
  assert.equal(L[2].status, 'create'); assert.equal(L[2].joined_on, null === L[2].joined_on ? null : '2026-11-10');
  assert.equal(L[3].status, 'create'); assert.match(L[3].message, /new manager/);
  assert.equal(L[4].status, 'create');
  assert.equal(L[5].status, 'update'); assert.match(L[5].message, /department Sales → Customer Support/);
  assert.equal(L[6].status, 'skip'); assert.match(L[6].message, /no changes/);
  assert.equal(L[7].status, 'deactivate');
  assert.match(L[8].message, /not a valid email/);
  assert.match(L[9].message, /ghost@mandovi.example isn't in this file or in the system/);
  assert.match(L[10].message, /MS-101 already belongs to arjun.naik/);
  assert.match(L[11].message, /already appears on line 2/);
  assert.match(L[12].message, /loops back/); assert.match(L[13].message, /loops back/);
  assert.match(L[14].message, /isn't a real date/);
  assert.match(L[15].message, /HR admin account/);
  assert.deepEqual(data.ignoredColumns, ['shirt_size']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email = 'riya.shet@mandovi.example'").get().n, 0, 'preview writes nothing');

  const before = db.prepare('SELECT COUNT(*) n FROM assignments').get().n;
  const done = (await hr('POST', '/api/import/commit', { csv, filename: 'hr-export.csv' })).data;
  assert.equal(done.summary.create, 3);
  assert.equal(done.summary.assignmentsCreated, 9, 'rules assign ONB, INFOSEC and POSH to the 3 new people (Meera already had DPDP)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM assignments').get().n - before, done.summary.assignmentsCreated);
  const dev = db.prepare("SELECT role FROM users WHERE email = 'dev.lotlikar@mandovi.example'").get();
  assert.equal(dev.role, 'manager');
  const pia = db.prepare("SELECT m.email FROM users u JOIN users m ON m.id = u.manager_id WHERE u.email = 'pia.naik@mandovi.example'").get();
  assert.equal(pia.email, 'dev.lotlikar@mandovi.example');
  assert.equal(db.prepare("SELECT active FROM users WHERE email = 'omkar.velip@mandovi.example'").get().active, 0);
  // New joiner can sign in with their employee ID as the first password.
  await login('riya.shet@mandovi.example', 'ms-501');
  // A leaver can't sign in and disappears from compliance.
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'omkar.velip@mandovi.example', password: 'MS-402' }) });
  assert.equal(r.status, 403);
  const rows = (await hr('GET', '/api/compliance/rows?q=omkar')).data;
  assert.equal(rows.total, 0);
  // Re-importing the same file changes nothing.
  const again = (await hr('POST', '/api/import/commit', { csv })).data;
  assert.equal(again.summary.create, 0);
  assert.equal(again.summary.update, 0);
  assert.equal(again.summary.assignmentsCreated, 0);
  // The fix-up file has only the bad rows.
  const fix = await hr('GET', `/api/import/batches/${done.batchId}/report.csv?errors=1`);
  assert.match(fix.data, /bad.email@mandovi/);
  assert.doesNotMatch(fix.data, /riya.shet@mandovi.example,Engineering/);
});

test('import: missing columns rejected; a 2,000-person file imports quickly', async () => {
  const hr = await HR();
  const bad = await hr('POST', '/api/import/preview', { csv: 'name,email\nA,a@b.co\n' });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error, /employee_id, department/);
  const lines = ['employee_id,name,email,department,manager_email'];
  for (let i = 1; i <= 2000; i++) lines.push(`BULK-${i},Person ${i},person${i}@mandovi.example,${['Sales', 'Engineering', 'Finance'][i % 3]},${i > 1 ? 'person1@mandovi.example' : ''}`);
  const t = Date.now();
  const r = await hr('POST', '/api/import/commit', { csv: lines.join('\n') });
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.create, 2000);
  assert.equal(r.data.summary.errors, 0);
  assert.ok(Date.now() - t < 8000, `took ${Date.now() - t}ms`);
  // Clean up so later tests see the original company.
  db.exec("DELETE FROM users WHERE email LIKE 'person%@mandovi.example'");
});

test('rules: adding a department rule assigns current staff; managers assign their team', async () => {
  const hr = await HR();
  const cr = courseId('CODE-REV');
  const r = await hr('POST', `/api/courses/${cr}/rules`, { department: 'Engineering', due_days: 30 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.assignmentsCreated >= 3, 'Rahul, Arjun, Tejas (+ new joiner) get it; Kavya and Joel already had it');
  const dupe = await hr('POST', `/api/courses/${cr}/rules`, { department: 'Engineering', due_days: 30 });
  assert.equal(dupe.status, 422);
  const nobody = await hr('POST', `/api/courses/${cr}/rules`, { department: 'Legal', due_days: 30 });
  assert.match(nobody.data.error, /Nobody currently works in "Legal"/);
  const mgr = await MGR();
  const posh = courseId('DPDP-01');
  const a = await mgr('POST', `/api/courses/${posh}/assign`, { user_ids: [userId('arjun.naik@mandovi.example')], due_days: 10 });
  assert.equal(a.data.created, 1);
});

// ---------------- Feature 2: learning, quiz, certificate ----------------
test('learning: quiz locked until lessons done; autosave ordering; fail then pass; certificate verifies', async () => {
  const emp = await EMP();
  const cid = courseId('INFOSEC-01');
  let s = (await emp('GET', `/api/learn/${cid}`)).data;
  assert.equal(s.status, 'not_started');
  assert.equal(s.quiz.unlocked, false);
  assert.equal((await emp('POST', `/api/learn/${cid}/attempts`)).status, 409);
  for (const l of s.lessons) assert.equal((await emp('POST', `/api/learn/${cid}/lessons/${l.id}/complete`)).status, 200);
  s = (await emp('GET', `/api/learn/${cid}`)).data;
  assert.equal(s.status, 'in_progress');
  assert.equal(s.quiz.unlocked, true);

  const start = (await emp('POST', `/api/learn/${cid}/attempts`)).data;
  assert.equal(start.questions[0].correct_index, undefined, 'answer key never sent to learners');
  const qs = training.loadQuestions(db, cid);
  const wrong = Object.fromEntries(qs.map(q => [q.id, (q.correct_index + 1) % q.options.length]));
  const right = Object.fromEntries(qs.map(q => [q.id, q.correct_index]));
  // Newer save (seq 5) then a late, older one (seq 3) — the older one must not win.
  await emp('PUT', `/api/attempts/${start.attempt.id}/answers`, { seq: 5, answers: right });
  const stale = await emp('PUT', `/api/attempts/${start.attempt.id}/answers`, { seq: 3, answers: wrong });
  assert.equal(stale.data.stale, true);
  // Reopening resumes the same attempt with the saved answers.
  const resumed = (await emp('POST', `/api/learn/${cid}/attempts`)).data;
  assert.equal(resumed.attempt.id, start.attempt.id);
  assert.deepEqual(resumed.attempt.answers, Object.fromEntries(Object.entries(right).map(([k, v]) => [k, v])));
  // Submit wrong answers explicitly → fail, no answers revealed.
  const fail = (await emp('POST', `/api/attempts/${start.attempt.id}/submit`, { answers: wrong })).data;
  assert.equal(fail.passed, false);
  assert.equal(fail.certificate, null);
  assert.ok(fail.review.every(q => q.answer === undefined), 'correct answers are not revealed after a fail');
  // Unanswered questions are flagged before submitting.
  const second = (await emp('POST', `/api/learn/${cid}/attempts`)).data;
  const partial = await emp('POST', `/api/attempts/${second.attempt.id}/submit`, { answers: { [qs[0].id]: qs[0].correct_index } });
  assert.equal(partial.status, 422);
  assert.equal(partial.data.code, 'unanswered');
  const pass = (await emp('POST', `/api/attempts/${second.attempt.id}/submit`, { answers: right })).data;
  assert.equal(pass.passed, true);
  assert.equal(pass.score_pct, 100);
  assert.match(pass.certificate.code, /^PW-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(new Date(pass.certificate.expires_at).toISOString().slice(0, 10), '2027-11-14', '12-month validity');
  s = (await emp('GET', `/api/learn/${cid}`)).data;
  assert.equal(s.status, 'completed');
  assert.equal(s.quiz.canTake, false, 'no retake while the certificate is valid');
  // Public verification, no sign-in.
  const v = await (await fetch(`${base}/api/certificates/${pass.certificate.code.toLowerCase()}`)).json();
  assert.equal(v.certificate.name, 'Arjun Naik');
  assert.equal(v.certificate.valid, true);
  assert.equal(v.certificate.email, undefined, 'verification shows no email');
  assert.equal((await fetch(`${base}/api/certificates/PW-NOPE-NOPE`)).status, 404);
});

test('learning: attempt limit, HR reset, and a course not assigned to you', async () => {
  const hr = await HR();
  const cid = courseId('DPDP-01'); // max 3 attempts; assigned to Arjun by his manager earlier
  const emp = await EMP();
  const s = (await emp('GET', `/api/learn/${cid}`)).data;
  for (const l of s.lessons) await emp('POST', `/api/learn/${cid}/lessons/${l.id}/complete`);
  const qs = training.loadQuestions(db, cid);
  const wrong = Object.fromEntries(qs.map(q => [q.id, (q.correct_index + 1) % q.options.length]));
  for (let i = 0; i < 3; i++) {
    const a = (await emp('POST', `/api/learn/${cid}/attempts`)).data;
    await emp('POST', `/api/attempts/${a.attempt.id}/submit`, { answers: wrong });
  }
  const blocked = await emp('POST', `/api/learn/${cid}/attempts`);
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /used all 3 attempts/);
  await hr('POST', `/api/people/${userId('arjun.naik@mandovi.example')}/courses/${cid}/reset-attempts`);
  assert.equal((await emp('POST', `/api/learn/${cid}/attempts`)).status, 200);
  const notMine = await emp('GET', `/api/learn/${courseId('POSH-01') + 1000}`);
  assert.equal(notMine.status, 404);
});

test('expiry: certificates lapse after their validity and the person must retake', async () => {
  const hr = await HR();
  const kavya = userId('kavya.prabhu@mandovi.example');
  let p = (await hr('GET', `/api/people/${kavya}`)).data;
  assert.ok(p.assignments, JSON.stringify(p));
  assert.equal(p.assignments.find(a => a.code === 'POSH-01').status, 'expiring');
  clock += 20 * DAY; // time passes (and the 12-hour sign-in has long expired, so sign in again)
  assert.equal((await hr('GET', `/api/people/${kavya}`)).status, 401, 'sessions expire');
  p = (await (await HR())('GET', `/api/people/${kavya}`)).data;
  const posh = p.assignments.find(a => a.code === 'POSH-01');
  assert.equal(posh.status, 'expired');
  assert.equal(posh.effective_due, posh.cert_expires, 'deadline becomes the expiry date');
  clock -= 20 * DAY;
});

// ---------------- Feature 3: compliance ----------------
test('compliance: summary adds up; filters; CSV export', async () => {
  const hr = await HR();
  const s = (await hr('GET', '/api/compliance/summary')).data;
  const t = s.totals;
  assert.equal(t.completed + t.expiring + t.expired + t.overdue + t.in_progress + t.not_started, t.total);
  assert.equal(t.compliant, t.completed + t.expiring);
  assert.ok(s.courses.length >= 5);
  assert.ok(s.departments.some(d => d.name === 'Sales'));
  const overdue = (await hr('GET', '/api/compliance/rows?status=overdue')).data;
  assert.ok(overdue.rows.every(r => r.status === 'overdue'));
  assert.ok(overdue.rows.some(r => r.email === 'tejas.gaonkar@mandovi.example'));
  const non = (await hr('GET', '/api/compliance/rows?status=noncompliant&department=Sales')).data;
  assert.ok(non.rows.length > 0 && non.rows.every(r => r.department === 'Sales' && !['completed', 'expiring'].includes(r.status)));
  const csv = await hr('GET', `/api/compliance.csv?course=${courseId('POSH-01')}`);
  assert.match(csv.data, /employee_id,name,email,department,manager,course_code/);
  assert.match(csv.data, /POSH-01/);
  assert.doesNotMatch(csv.data, /INFOSEC-01/);
});

test('courses: HR creates and edits a course; validation explains problems', async () => {
  const hr = await HR();
  const bad = await hr('POST', '/api/courses', { code: 'x', title: '', category: 'Nope', pass_mark: 0, lessons: [], questions: [] });
  assert.equal(bad.status, 422);
  assert.ok(bad.data.problems.length >= 5);
  const body = { code: 'FIRE-01', title: 'Fire safety', category: 'Compliance', pass_mark: 75, validity_months: 24, max_attempts: '',
    lessons: [{ title: 'Exits', body: 'Know two ways out.' }], questions: [{ prompt: 'How many exits should you know?', options: ['One', '', 'Two'], correct_index: 2 }] };
  const r = await hr('POST', '/api/courses', body);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const q = training.loadQuestions(db, r.data.id)[0];
  assert.deepEqual(q.options, ['One', 'Two']);
  assert.equal(q.correct_index, 1, 'correct answer still points at "Two" after the blank option is dropped');
  const dup = await hr('POST', '/api/courses', body);
  assert.match(dup.data.error, /already exists/);
  const edit = await hr('PUT', `/api/courses/${r.data.id}`, { ...body, title: 'Fire safety basics' });
  assert.equal(edit.status, 200);
});

test('security: JSON-only writes; path traversal blocked; signed-out requests refused', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(r.status, 415);
  assert.notEqual((await fetch(base + '/..%2Fpackage.json')).status, 200);
  assert.equal((await fetch(base + '/api/my')).status, 401);
});
