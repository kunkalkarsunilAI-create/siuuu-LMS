'use strict';
// End-to-end tests against a real HTTP server with an in-memory database and a controllable clock.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../src/app');
const { seed } = require('../src/seed');

let clock = Date.now();
const { server, db } = createApp({ dbPath: ':memory:', now: () => clock });
seed(db, clock);
let base;

test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

async function login(email, password) {
  const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  assert.equal(res.status, 200, `login ${email}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { cookie, ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) }, body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  return call;
}

// ---------------- Roles & permissions ----------------
test('roles: students cannot import, see other courses, or open the gradebook of others', async () => {
  const student = await login('aisha.dsouza@dempo.edu', '23CS001');
  assert.equal((await student('POST', '/api/roster/preview', { csv: 'x' })).status, 403);
  const courses = (await student('GET', '/api/courses')).data.courses.map(c => c.code);
  assert.deepEqual(courses, ['CS201', 'CS202']);
  const ma = db.prepare("SELECT id FROM courses WHERE code='MA201'").get().id;
  assert.equal((await student('GET', `/api/courses/${ma}`)).status, 404);
  const gb = (await student('GET', '/api/courses/1/gradebook')).data;
  assert.equal(gb.rows.length, 1, 'a student only sees their own row');
  assert.equal(gb.rows[0].student.email, 'aisha.dsouza@dempo.edu');
  assert.equal((await student('PUT', '/api/courses/1/marks', { entries: [] })).status, 403);
});

test('roles: faculty cannot manage a course they do not teach', async () => {
  const rahul = await login('rahul.kamat@dempo.edu', 'faculty123');
  assert.equal((await rahul('GET', '/api/courses/1/gradebook')).status, 404);
  assert.equal((await rahul('POST', '/api/courses/1/exams', {})).status, 404);
});

test('wrong password is rejected with a helpful message', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@dempo.edu', password: 'nope' }) });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /do not match/);
});

// ---------------- Feature 1: roster import ----------------
test('roster: sample file with mistakes — every row gets the right outcome', async () => {
  const admin = await login('admin@dempo.edu', 'admin123');
  const csv = fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'students-with-errors.csv'), 'utf8');
  const { status, data } = await admin('POST', '/api/roster/preview', { csv });
  assert.equal(status, 200);
  const byLine = Object.fromEntries(data.results.map(r => [r.line, r]));
  assert.equal(byLine[2].status, 'create');                       // new student
  assert.equal(byLine[3].status, 'enrol');                        // same student, 2nd course
  assert.equal(byLine[4].status, 'create');                       // quoted name with comma, lowercase course code
  assert.equal(byLine[4].name, 'Fernandes, Liam');
  assert.match(byLine[5].message, /not a valid email/);
  assert.match(byLine[6].message, /name is empty/);
  assert.match(byLine[7].message, /CS999" does not exist/);
  assert.equal(byLine[8].status, 'skip');                         // exact duplicate row
  assert.match(byLine[9].message, /has roll_no 24CS9001 on line 2/); // same email, different roll
  assert.match(byLine[10].message, /has 7 columns but the header has 6/);
  assert.equal(byLine[11].status, 'skip');                        // already enrolled
  assert.equal(byLine[12].status, 'enrol');                       // existing student, new course
  assert.match(byLine[13].message, /already belongs to rohan.naik/); // roll number taken
  assert.match(byLine[14].message, /roll_no "X!"/);
  assert.match(byLine[15].message, /belongs to a admin account/);
  assert.deepEqual(data.ignoredColumns, ['phone']);
  assert.equal(data.summary.errors, 8);
});

test('roster: preview writes nothing; import is partial and re-import is idempotent', async () => {
  const admin = await login('admin@dempo.edu', 'admin123');
  const count = () => db.prepare('SELECT COUNT(*) n FROM enrollments').get().n;
  const before = count();
  const csv = 'roll_no,name,email,course_code\n24CS7001,Nia Pai,nia.pai@dempo.edu,CS201\n24CS7002,Bad Email,bad@,CS201\n';
  await admin('POST', '/api/roster/preview', { csv });
  assert.equal(count(), before);
  const r1 = await admin('POST', '/api/roster/import', { csv, filename: 't.csv' });
  assert.equal(r1.status, 200);
  assert.equal(count(), before + 1);
  const r2 = await admin('POST', '/api/roster/import', { csv, filename: 't.csv' });
  assert.equal(r2.data.summary.skipped, 1);
  assert.equal(count(), before + 1, 'no duplicates on re-upload');
  // The new student can sign in with their roll number.
  await login('nia.pai@dempo.edu', '24CS7001');
  // The error report only contains the bad row.
  const rep = await admin('GET', `/api/roster/batches/${r1.data.batchId}/report.csv?errors=1`);
  assert.match(rep.data, /bad@/);
  assert.doesNotMatch(rep.data, /nia.pai/);
});

test('roster: missing columns and empty files are rejected with clear messages', async () => {
  const admin = await login('admin@dempo.edu', 'admin123');
  let r = await admin('POST', '/api/roster/preview', { csv: 'name,email\nA,a@b.co\n' });
  assert.equal(r.status, 422);
  assert.match(r.data.error, /Missing required column\(s\): roll_no, course_code/);
  r = await admin('POST', '/api/roster/preview', { csv: '' });
  assert.match(r.data.error, /empty/);
});

test('roster: 2,000-student file imports in one go', async () => {
  const admin = await login('admin@dempo.edu', 'admin123');
  const csv = fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'students-2000.csv'), 'utf8');
  const t = Date.now();
  const r = await admin('POST', '/api/roster/import', { csv, filename: 'students-2000.csv' });
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.errors, 0);
  assert.equal(r.data.summary.newStudents, 2000);
  assert.ok(Date.now() - t < 5000, `imports within 5s (took ${Date.now() - t}ms)`);
  // An imported student can sign in with their roll number (the hash is created on first sign-in).
  await login('saanvi.shirodkar@dempo.edu', '24ma0001');
  await login('saanvi.shirodkar@dempo.edu', '24MA0001');
});

// ---------------- Feature 2: exams ----------------
async function makeExam(fac, opts = {}) {
  const r = await fac('POST', '/api/courses/1/exams', {
    title: 'Timer test', duration_min: 10, opens_at: clock - 1000, closes_at: clock + 86400000, component_id: opts.component_id ?? null,
    questions: [
      { type: 'mcq', prompt: '1+1?', options: ['1', '2', '3'], correct_index: 1, marks: 2 },
      { type: 'mcq', prompt: '2+2?', options: ['4', '5'], correct_index: 0, marks: 2 },
      ...(opts.short ? [{ type: 'short', prompt: 'Explain', marks: 6 }] : []),
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}

test('exam: server keeps the timer; reloading does not reset it; answer key is hidden', async () => {
  const fac = await login('priya.naik@dempo.edu', 'faculty123');
  const st = await login('rohan.naik@dempo.edu', '23CS002');
  const id = await makeExam(fac);
  const s1 = await st('POST', `/api/exams/${id}/start`);
  assert.equal(s1.data.resumed, false);
  const a1 = (await st('GET', `/api/exams/${id}/attempt`)).data;
  assert.equal(a1.attempt.deadline, clock + 10 * 60000);
  assert.equal(a1.questions[0].correct_index, undefined, 'students never receive the answer key');
  clock += 4 * 60000;
  const s2 = await st('POST', `/api/exams/${id}/start`);
  assert.equal(s2.data.resumed, true);
  const a2 = (await st('GET', `/api/exams/${id}/attempt`)).data;
  assert.equal(a2.attempt.deadline, a1.attempt.deadline, 'deadline did not move');
});

test('exam: out-of-order saves (offline queue flushing late) never overwrite newer answers', async () => {
  const fac = await login('priya.naik@dempo.edu', 'faculty123');
  const st = await login('sneha.kamat@dempo.edu', '23CS003');
  const id = await makeExam(fac);
  await st('POST', `/api/exams/${id}/start`);
  const { attempt, questions } = (await st('GET', `/api/exams/${id}/attempt`)).data;
  const [q1, q2] = questions.map(q => q.id);
  assert.equal((await st('PUT', `/api/attempts/${attempt.id}/answers`, { seq: 5, answers: { [q1]: 1, [q2]: 0 } })).data.ok, true);
  const stale = await st('PUT', `/api/attempts/${attempt.id}/answers`, { seq: 3, answers: { [q1]: 0 } });
  assert.equal(stale.data.stale, true);
  const now = (await st('GET', `/api/exams/${id}/attempt`)).data.attempt;
  assert.deepEqual(now.answers, { [q1]: 1, [q2]: 0 });
  assert.equal(now.save_seq, 5);
});

test('exam: student who never comes back is auto-submitted at the deadline with saved answers, and score reaches gradebook', async () => {
  const fac = await login('priya.naik@dempo.edu', 'faculty123');
  const st = await login('vikram.prabhu@dempo.edu', '23CS004');
  const quizCol = db.prepare("SELECT id FROM components WHERE course_id = 1 AND name = 'Quiz 1'").get().id;
  const id = await makeExam(fac, { component_id: quizCol });
  await st('POST', `/api/exams/${id}/start`);
  const { attempt, questions } = (await st('GET', `/api/exams/${id}/attempt`)).data;
  await st('PUT', `/api/attempts/${attempt.id}/answers`, { seq: 1, answers: { [questions[0].id]: 1 } }); // 1 right, 1 blank
  clock += 11 * 60000; // student's WiFi died and they never returned
  // A save arriving now is refused…
  const late = await st('PUT', `/api/attempts/${attempt.id}/answers`, { seq: 2, answers: { [questions[0].id]: 1, [questions[1].id]: 0 } });
  assert.equal(late.status, 409);
  // …and the faculty view shows the attempt finalised with what was saved.
  const list = (await fac('GET', `/api/exams/${id}/attempts`)).data;
  const mine = list.attempts.find(a => a.id === attempt.id);
  assert.equal(mine.submit_reason, 'timeout');
  assert.equal(mine.submitted_at, attempt.deadline, 'stamped with the deadline, not when it was noticed');
  assert.equal(mine.total_score, 2);
  const mark = db.prepare('SELECT marks, source FROM marks WHERE component_id = ? AND student_id = ?').get(quizCol, mine.student.id);
  assert.equal(mark.marks, 5, '2/4 scaled to a column out of 10');
  assert.equal(mark.source, 'exam');
});

test('exam: saves within the grace window after the deadline are kept', async () => {
  const fac = await login('priya.naik@dempo.edu', 'faculty123');
  const st = await login('fatima.shaikh@dempo.edu', '23CS005');
  const id = await makeExam(fac);
  await st('POST', `/api/exams/${id}/start`);
  const { attempt, questions } = (await st('GET', `/api/exams/${id}/attempt`)).data;
  clock = attempt.deadline + 5000; // request was in flight as time ran out
  const r = await st('POST', `/api/attempts/${attempt.id}/submit`, { seq: 1, answers: { [questions[0].id]: 1, [questions[1].id]: 0 } });
  assert.equal(r.data.submit_reason, 'student');
  const done = (await st('GET', `/api/exams/${id}/attempt`)).data.attempt;
  assert.equal(done.total_score, 4);
});

test('exam: short answers wait for faculty marks, then total is recorded', async () => {
  const fac = await login('priya.naik@dempo.edu', 'faculty123');
  const st = await login('joel.fernandes@dempo.edu', '23CS006');
  const id = await makeExam(fac, { short: true });
  await st('POST', `/api/exams/${id}/start`);
  const { attempt, questions } = (await st('GET', `/api/exams/${id}/attempt`)).data;
  await st('POST', `/api/attempts/${attempt.id}/submit`, { seq: 1, answers: { [questions[0].id]: 1, [questions[2].id]: 'Because…' } });
  let a = (await st('GET', `/api/exams/${id}/attempt`)).data.attempt;
  assert.equal(a.graded, 0);
  assert.equal(a.total_score, null, 'score hidden until marked');
  const bad = await fac('PUT', `/api/attempts/${attempt.id}/grade`, { marks: { [questions[2].id]: 9 } });
  assert.equal(bad.status, 422);
  await fac('PUT', `/api/attempts/${attempt.id}/grade`, { marks: { [questions[2].id]: 4.5 } });
  a = (await st('GET', `/api/exams/${id}/attempt`)).data.attempt;
  assert.equal(a.total_score, 6.5);
});

test('exam: cannot start before it opens or after it closes; deadline capped at closing time', async () => {
  const fac = await login('priya.naik@dempo.edu', 'faculty123');
  const st = await login('pooja.gaonkar@dempo.edu', '23CS007');
  const mk = (o, c) => fac('POST', '/api/courses/1/exams', { title: 'W', duration_min: 60, opens_at: o, closes_at: c, questions: [{ type: 'mcq', prompt: 'q', options: ['a', 'b'], correct_index: 0, marks: 1 }] });
  const future = (await mk(clock + 3600000, clock + 7200000)).data.id;
  assert.equal((await st('POST', `/api/exams/${future}/start`)).status, 409);
  const closing = (await mk(clock - 1000, clock + 5 * 60000)).data.id;
  await st('POST', `/api/exams/${closing}/start`);
  const a = (await st('GET', `/api/exams/${closing}/attempt`)).data.attempt;
  assert.equal(a.deadline, clock + 5 * 60000, '60-minute exam started 5 min before closing gets 5 minutes');
});

// ---------------- Feature 3: gradebook ----------------
test('gradebook: weights must total 100; marks out of range rejected; totals computed', async () => {
  const fac = await login('priya.naik@dempo.edu', 'faculty123');
  const gb = (await fac('GET', '/api/courses/1/gradebook')).data;
  assert.equal(gb.validation.ok, true);
  const bad = await fac('PUT', '/api/courses/1/components', { components: gb.components.map((c, i) => ({ ...c, weight: i === 0 ? 50 : c.weight })) });
  assert.equal(bad.status, 422);
  assert.match(bad.data.error, /must add up to 100/);

  const arjun = gb.rows.find(r => r.student.roll_no === '23CS008').student.id;
  const col = n => gb.components.find(c => c.name === n).id;
  const over = await fac('PUT', '/api/courses/1/marks', { entries: [{ student_id: arjun, component_id: col('Mid-semester exam'), marks: 41 }] });
  assert.equal(over.status, 422);
  const ok = await fac('PUT', '/api/courses/1/marks', { entries: [
    { student_id: arjun, component_id: col('Quiz 1'), marks: 8 },
    { student_id: arjun, component_id: col('Mid-semester exam'), marks: 30 },
    { student_id: arjun, component_id: col('Assignments'), marks: 16 },
    { student_id: arjun, component_id: col('End-semester exam'), marks: 70 },
  ] });
  const row = ok.data.rows.find(r => r.student.id === arjun);
  // 8/10*10 + 30/40*20 + 16/20*10 = 8 + 15 + 8 = 31 internal ; 70/100*60 = 42 external
  assert.equal(row.internal, 31);
  assert.equal(row.external, 42);
  assert.equal(row.total, 73);
  assert.equal(row.grade, 'A');
});

test('gradebook: CSV export has every student and the grade', async () => {
  const fac = await login('priya.naik@dempo.edu', 'faculty123');
  const r = await fac('GET', '/api/courses/1/gradebook.csv');
  assert.equal(r.status, 200);
  const lines = r.data.trim().split('\r\n');
  assert.match(lines[0], /roll_no,name,email,"Quiz 1 \(internal, \/10, 10%\)"/);
  assert.ok(lines.some(l => l.startsWith('23CS008') && l.includes(',73,A,8,pass')));
});

test('security: state-changing requests must be JSON (CSRF), static path traversal blocked', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a' });
  assert.equal(r.status, 415);
  const t = await fetch(base + '/..%2F..%2Fpackage.json');
  assert.notEqual(t.status, 200);
});

test('sessions: a sign-in made on one copy of the app works on another (as on Vercel)', async () => {
  process.env.SESSION_SECRET = 'test-secret-for-two-instances';
  try {
    const auth = require('../src/auth');
    const a = createApp({ dbPath: ':memory:' }); seed(a.db);
    const b = createApp({ dbPath: ':memory:' }); seed(b.db);
    const uid = a.db.prepare("SELECT id FROM users WHERE email = 'aisha.dsouza@dempo.edu'").get().id;
    const token = auth.createSession(a.db, uid);
    assert.equal(auth.userFromToken(b.db, token).email, 'aisha.dsouza@dempo.edu');
    // Tampering or a different person with the same id is rejected.
    assert.equal(auth.userFromToken(b.db, token.slice(0, -2) + 'xx'), null);
    b.db.prepare("UPDATE users SET email = 'someone.else@dempo.edu' WHERE id = ?").run(uid);
    assert.equal(auth.userFromToken(b.db, token), null);
    // Expired.
    assert.equal(auth.userFromToken(a.db, token, Date.now() + 13 * 3600 * 1000), null);
  } finally { delete process.env.SESSION_SECRET; }
});
