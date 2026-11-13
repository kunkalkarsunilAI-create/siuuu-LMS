'use strict';
// Demo data so a new person sees a working app on first run.
// Runs automatically when the database has no users. `npm run reset` wipes and re-seeds.
const { hashPassword } = require('./auth');
const { tx } = require('./db');
const exams = require('./exams');

const DAY = 24 * 60 * 60 * 1000;
const st10 = now => now - 3 * 60 * 60 * 1000 + 10 * 60000; // when the seeded practice attempt was submitted

const STUDENTS = [
  ['23CS001', 'Aisha D\'Souza', 'aisha.dsouza@dempo.edu'],
  ['23CS002', 'Rohan Naik', 'rohan.naik@dempo.edu'],
  ['23CS003', 'Sneha Kamat', 'sneha.kamat@dempo.edu'],
  ['23CS004', 'Vikram Prabhu', 'vikram.prabhu@dempo.edu'],
  ['23CS005', 'Fatima Shaikh', 'fatima.shaikh@dempo.edu'],
  ['23CS006', 'Joel Fernandes', 'joel.fernandes@dempo.edu'],
  ['23CS007', 'Pooja Gaonkar', 'pooja.gaonkar@dempo.edu'],
  ['23CS008', 'Arjun Shetye', 'arjun.shetye@dempo.edu'],
];

function seed(db, now = Date.now()) {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) return false;
  const toFinalise = tx(db, () => {
    const addUser = db.prepare('INSERT INTO users (email, name, role, roll_no, department, password_hash) VALUES (?, ?, ?, ?, ?, ?)');
    const id = r => Number(r.lastInsertRowid);
    addUser.run('admin@dempo.edu', 'Office of Examinations', 'admin', null, 'Administration', hashPassword('admin123'));
    const priya = id(addUser.run('priya.naik@dempo.edu', 'Dr. Priya Naik', 'faculty', null, 'Computer Science', hashPassword('faculty123')));
    const rahul = id(addUser.run('rahul.kamat@dempo.edu', 'Prof. Rahul Kamat', 'faculty', null, 'Mathematics', hashPassword('faculty123')));

    const addCourse = db.prepare('INSERT INTO courses (code, title, semester, faculty_id) VALUES (?, ?, ?, ?)');
    const cs201 = id(addCourse.run('CS201', 'Data Structures', 'Sem III · 2026–27', priya));
    const cs202 = id(addCourse.run('CS202', 'Database Systems', 'Sem III · 2026–27', priya));
    id(addCourse.run('MA201', 'Discrete Mathematics', 'Sem III · 2026–27', rahul));
    id(addCourse.run('EC201', 'Digital Electronics', 'Sem III · 2026–27', rahul));

    const sids = STUDENTS.map(([roll, name, email]) =>
      id(addUser.run(email, name, 'student', roll, 'Computer Science', hashPassword(roll))));
    const enrol = db.prepare('INSERT INTO enrollments (user_id, course_id) VALUES (?, ?)');
    sids.forEach(s => { enrol.run(s, cs201); enrol.run(s, cs202); });

    // Gradebook: a typical Indian university split — 40 internal / 60 external.
    const addComp = db.prepare('INSERT INTO components (course_id, name, category, weight, max_marks, position) VALUES (?, ?, ?, ?, ?, ?)');
    const quiz = id(addComp.run(cs201, 'Quiz 1', 'internal', 10, 10, 0));
    const mid = id(addComp.run(cs201, 'Mid-semester exam', 'internal', 20, 40, 1));
    const asg = id(addComp.run(cs201, 'Assignments', 'internal', 10, 20, 2));
    const end = id(addComp.run(cs201, 'End-semester exam', 'external', 60, 100, 3));
    addComp.run(cs202, 'Internal assessment', 'internal', 40, 40, 0);
    addComp.run(cs202, 'University exam', 'external', 60, 100, 1);

    // Marks for some students; others left blank so "incomplete" is visible.
    const addMark = db.prepare("INSERT INTO marks (component_id, student_id, marks, source, updated_by) VALUES (?, ?, ?, 'manual', ?)");
    const sample = [
      // mid, asg, end  (quiz comes from the online exam)
      [34, 18, 82], [28, 15, 64], [38, 19, 91], [22, 12, 31], [30, 16, 58], [25, 14, 47],
    ];
    sample.forEach(([m, a, e], i) => {
      const s = sids[i + 1]; // students 2..7 (Aisha, the demo login, is left for the live quiz)
      addMark.run(mid, s, m, priya);
      addMark.run(asg, s, a, priya);
      addMark.run(end, s, e, priya);
    });
    addMark.run(mid, sids[0], 33, priya);
    addMark.run(asg, sids[0], 17, priya);
    addMark.run(end, sids[0], 76, priya);

    // Exam 1: an open MCQ quiz, auto-marked, feeds the "Quiz 1" gradebook column.
    const addExam = db.prepare(`INSERT INTO exams (course_id, title, instructions, duration_min, opens_at, closes_at, component_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const addQ = db.prepare('INSERT INTO questions (exam_id, position, type, prompt, options_json, correct_index, marks) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const quizExam = id(addExam.run(cs201, 'Quiz 1 — Arrays and linked lists',
      'Answer all five questions. Your answers save automatically every few seconds. If your WiFi drops, keep working — answers are kept on this device and sent when you reconnect. The timer is kept by the server, so reloading the page does not reset it.',
      10, now - DAY, now + 7 * DAY, quiz, priya));
    [
      ['What is the time complexity of accessing the i-th element of an array?', ['O(1)', 'O(log n)', 'O(n)', 'O(n log n)'], 0],
      ['Which operation is faster on a singly linked list than on an array?', ['Random access by index', 'Inserting at the head', 'Binary search', 'Finding the maximum'], 1],
      ['In a doubly linked list, each node stores…', ['Only a value', 'A value and one pointer', 'A value and two pointers', 'Two values'], 2],
      ['What does a stack follow?', ['FIFO', 'LIFO', 'Random order', 'Priority order'], 1],
      ['Deleting the last node of a singly linked list with only a head pointer takes…', ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], 2],
    ].forEach(([p, o, c], i) => addQ.run(quizExam, i + 1, 'mcq', p, JSON.stringify(o), c, 2));

    // Students 2–6 have already taken the quiz.
    const quizQs = exams.loadQuestions(db, quizExam);
    const picks = [[0, 1, 2, 1, 2], [0, 1, 1, 1, 2], [0, 0, 2, 1, 0], [1, 1, 2, 1, 2], [0, 1, 2, 0, 2]];
    picks.forEach((p, i) => {
      const started = now - DAY / 2 + i * 60000;
      const answers = Object.fromEntries(quizQs.map((q, k) => [q.id, p[k]]));
      const r = db.prepare(`INSERT INTO attempts (exam_id, student_id, started_at, deadline, answers_json, save_seq, save_count, last_saved_at)
        VALUES (?, ?, ?, ?, ?, 7, 7, ?)`).run(quizExam, sids[i + 1], started, started + 10 * 60000, JSON.stringify(answers), started + 6 * 60000);
      db.prepare('UPDATE attempts SET submitted_at = ?, submit_reason = ?, auto_score = ?, total_score = ?, graded = 1 WHERE id = ?')
        .run(started + 7 * 60000, i === 3 ? 'timeout' : 'student', exams.scoreAuto(quizQs, answers), exams.scoreAuto(quizQs, answers), r.lastInsertRowid);
      exams.syncToGradebook(db, { component_id: quiz }, { student_id: sids[i + 1], total_score: exams.scoreAuto(quizQs, answers) }, quizQs, priya);
    });

    // Exam 2: open, mixed MCQ + short answer, needs faculty marking. Not linked to the gradebook.
    const mixed = id(addExam.run(cs201, 'Practice test — Stacks and queues',
      'Two multiple-choice questions and one short answer. The short answer is marked by your teacher.',
      15, now - DAY, now + 14 * DAY, null, priya));
    addQ.run(mixed, 1, 'mcq', 'Which data structure is used for breadth-first search?', JSON.stringify(['Stack', 'Queue', 'Heap', 'Tree']), 1, 2);
    addQ.run(mixed, 2, 'mcq', 'A circular queue of size n can hold at most how many elements (one slot kept empty)?', JSON.stringify(['n', 'n − 1', 'n + 1', '2n']), 1, 2);
    addQ.run(mixed, 3, 'short', 'Explain, in two or three sentences, how you would use a stack to check whether brackets in an expression are balanced.', null, null, 6);
    const mq = exams.loadQuestions(db, mixed);
    const st = now - 3 * 60 * 60 * 1000;
    const r2 = db.prepare(`INSERT INTO attempts (exam_id, student_id, started_at, deadline, answers_json, save_seq, save_count, last_saved_at)
      VALUES (?, ?, ?, ?, ?, 12, 12, ?)`).run(mixed, sids[2], st, st + 15 * 60000,
      JSON.stringify({ [mq[0].id]: 1, [mq[1].id]: 0, [mq[2].id]: 'Push every opening bracket. On a closing bracket, pop and check it matches. At the end the stack must be empty.' }), st + 9 * 60000);
    return Number(r2.lastInsertRowid);
  });
  exams.finalise(db, toFinalise, 'student', st10(now));
  return true;
}

module.exports = { seed, STUDENTS };
