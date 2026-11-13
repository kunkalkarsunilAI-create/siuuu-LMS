'use strict';
// Feature 2 — Exam robustness.
//
// The server is the only clock that matters:
//   * When a student presses Start, the server records started_at and fixes
//     deadline = min(started_at + duration, closes_at). Reloading, switching
//     device, or changing the laptop clock cannot change it.
//   * Every save carries a sequence number. The server keeps only the newest,
//     so answers queued offline and flushed out of order cannot overwrite newer ones.
//   * Saves are accepted up to GRACE_MS after the deadline, to cover requests that
//     were in flight when time ran out. After that they are refused.
//   * An attempt past its deadline is finalised automatically (reason "timeout")
//     with the last answers the server received — whether or not the student
//     ever comes back online.
const { tx } = require('./db');

const GRACE_MS = 15 * 1000;

function loadQuestions(db, examId) {
  return db.prepare('SELECT * FROM questions WHERE exam_id = ? ORDER BY position').all(examId).map(q => ({
    id: q.id, position: q.position, type: q.type, prompt: q.prompt,
    options: q.options_json ? JSON.parse(q.options_json) : null,
    correct_index: q.correct_index, marks: q.marks,
  }));
}

// What a student is allowed to see: no answer key.
function publicQuestions(questions) {
  return questions.map(({ correct_index, ...q }) => q);
}

function scoreAuto(questions, answers) {
  let score = 0;
  for (const q of questions) {
    if (q.type !== 'mcq') continue;
    const a = answers[q.id];
    if (a !== undefined && a !== null && Number(a) === q.correct_index) score += q.marks;
  }
  return score;
}

function maxMarks(questions) {
  return questions.reduce((a, q) => a + q.marks, 0);
}

function hasShort(questions) {
  return questions.some(q => q.type === 'short');
}

// Push an attempt's total into the linked gradebook component, scaled to that component's max.
function syncToGradebook(db, exam, attempt, questions, actorId) {
  if (!exam.component_id || attempt.total_score === null || attempt.total_score === undefined) return;
  const comp = db.prepare('SELECT * FROM components WHERE id = ?').get(exam.component_id);
  if (!comp) return;
  const max = maxMarks(questions);
  const scaled = max > 0 ? Math.round((attempt.total_score / max) * comp.max_marks * 100) / 100 : 0;
  db.prepare(`INSERT INTO marks (component_id, student_id, marks, source, updated_by, updated_at)
    VALUES (?, ?, ?, 'exam', ?, datetime('now'))
    ON CONFLICT(component_id, student_id) DO UPDATE SET marks = excluded.marks, source = 'exam',
      updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(comp.id, attempt.student_id, scaled, actorId || null);
}

function finalise(db, attemptId, reason, now) {
  return tx(db, () => {
    const a = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
    if (!a || a.submitted_at) return a;
    const exam = db.prepare('SELECT * FROM exams WHERE id = ?').get(a.exam_id);
    const questions = loadQuestions(db, a.exam_id);
    const answers = JSON.parse(a.answers_json || '{}');
    const auto = scoreAuto(questions, answers);
    const needsManual = hasShort(questions);
    // A timed-out attempt is stamped with its deadline, not with when we noticed.
    const submittedAt = reason === 'timeout' ? a.deadline : now;
    db.prepare(`UPDATE attempts SET submitted_at = ?, submit_reason = ?, auto_score = ?,
      total_score = ?, graded = ? WHERE id = ?`)
      .run(submittedAt, reason, auto, needsManual ? null : auto, needsManual ? 0 : 1, a.id);
    const updated = db.prepare('SELECT * FROM attempts WHERE id = ?').get(a.id);
    if (!needsManual) syncToGradebook(db, exam, updated, questions, null);
    return updated;
  });
}

// Finalise any attempt whose deadline has passed. Called lazily on reads, so a
// student who never reconnects is still submitted when anyone next looks.
function sweepExpired(db, now, examId) {
  const rows = examId
    ? db.prepare('SELECT id FROM attempts WHERE submitted_at IS NULL AND deadline + ? < ? AND exam_id = ?').all(GRACE_MS, now, examId)
    : db.prepare('SELECT id FROM attempts WHERE submitted_at IS NULL AND deadline + ? < ?').all(GRACE_MS, now);
  for (const r of rows) finalise(db, r.id, 'timeout', now);
  return rows.length;
}

function startAttempt(db, exam, studentId, now) {
  const existing = db.prepare('SELECT * FROM attempts WHERE exam_id = ? AND student_id = ?').get(exam.id, studentId);
  if (existing) return { attempt: existing, resumed: true };
  if (now < exam.opens_at) return { error: 'This exam has not opened yet.', status: 409 };
  if (now >= exam.closes_at) return { error: 'This exam has closed.', status: 409 };
  const deadline = Math.min(now + exam.duration_min * 60 * 1000, exam.closes_at);
  const r = db.prepare('INSERT INTO attempts (exam_id, student_id, started_at, deadline) VALUES (?, ?, ?, ?)')
    .run(exam.id, studentId, now, deadline);
  return { attempt: db.prepare('SELECT * FROM attempts WHERE id = ?').get(r.lastInsertRowid), resumed: false };
}

function saveAnswers(db, attempt, questions, answers, seq, now) {
  if (attempt.submitted_at) return { status: 409, error: 'This exam has already been submitted.', code: 'submitted' };
  if (now > attempt.deadline + GRACE_MS) return { status: 409, error: 'Time is up. Your last saved answers were submitted.', code: 'expired' };
  if (!Number.isInteger(seq) || seq < 1) return { status: 400, error: 'Missing save sequence number.' };
  if (seq <= attempt.save_seq) {
    // Older than what we already have (e.g. an offline queue flushing late). Ignore, but say OK.
    return { ok: true, stale: true, seq: attempt.save_seq, savedAt: attempt.last_saved_at };
  }
  // Only keep answers to questions that exist, in the right shape.
  const clean = {};
  const byId = new Map(questions.map(q => [String(q.id), q]));
  for (const [k, v] of Object.entries(answers || {})) {
    const q = byId.get(String(k));
    if (!q || v === null || v === undefined || v === '') continue;
    if (q.type === 'mcq') {
      const n = Number(v);
      if (Number.isInteger(n) && n >= 0 && n < (q.options || []).length) clean[q.id] = n;
    } else {
      clean[q.id] = String(v).slice(0, 5000);
    }
  }
  db.prepare(`UPDATE attempts SET answers_json = ?, save_seq = ?, save_count = save_count + 1,
    last_saved_at = ? WHERE id = ? AND submitted_at IS NULL`).run(JSON.stringify(clean), seq, now, attempt.id);
  return { ok: true, seq, savedAt: now };
}

module.exports = {
  GRACE_MS, loadQuestions, publicQuestions, scoreAuto, maxMarks, hasShort,
  finalise, sweepExpired, startAttempt, saveAnswers, syncToGradebook,
};
