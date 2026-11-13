'use strict';
/* Dempo Learn — client. Plain JavaScript, no build step. */
(() => {
  const $app = document.getElementById('app');
  const $live = document.getElementById('live');
  const state = { user: null };
  const sim = { offline: false }; // demo tool: pretend the WiFi dropped
  let cleanup = null;             // set by views that start timers

  // ---------------- utilities ----------------
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const round2 = n => Math.round(n * 100) / 100;
  const fmtNum = n => (n === null || n === undefined ? '—' : String(round2(n)));
  const fmtDT = ms => new Date(ms).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const fmtTime = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }
  function fmtAgo(ms, now = Date.now()) {
    const s = Math.round((now - ms) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return fmtDT(ms);
  }
  const announce = msg => { $live.textContent = ''; setTimeout(() => { $live.textContent = msg; }, 50); };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  const ICON = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    wifiOff: '<path d="M12 20h.01M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.3-1.6M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.7 5M2 2l20 20"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  };
  const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;
  const notice = (kind, html) => {
    const ic = { ok: 'check', warn: 'alert', bad: 'alert', info: 'info' }[kind];
    return `<div class="notice notice-${kind}" role="${kind === 'bad' ? 'alert' : 'status'}">${icon(ic)}<div>${html}</div></div>`;
  };
  const LOGO = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#13574f"/><path d="M9 8h7a8 8 0 0 1 0 16H9z" fill="none" stroke="#e3a21a" stroke-width="3"/></svg>`;

  function toast(msg) {
    $$('.toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Cancel', danger = false }) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const wrap = document.createElement('div');
      wrap.className = 'modal-backdrop';
      wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <h2 id="m-title">${esc(title)}</h2><div>${body}</div>
        <div class="row"><button class="btn btn-quiet" data-v="0">${esc(cancel)}</button>
        <button class="btn ${danger ? 'btn-danger' : ''}" data-v="1">${esc(confirm)}</button></div></div>`;
      const close = v => { wrap.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); resolve(v); };
      const onKey = e => {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Tab') { // keep focus inside the dialog
          const f = $$('button', wrap); const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
          else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
        }
      };
      wrap.addEventListener('click', e => {
        const b = e.target.closest('button[data-v]');
        if (b) close(b.dataset.v === '1'); else if (e.target === wrap) close(false);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      $('button[data-v="1"]', wrap).focus();
    });
  }

  // ---------------- API ----------------
  class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }
  const isNetworkError = e => !(e instanceof ApiError);
  async function api(method, url, body) {
    if (sim.offline) throw new TypeError('Simulated WiFi drop');
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body ?? {}); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && url !== '/api/login') {
      state.user = null;
      if (!location.hash.startsWith('#/login')) go('#/login');
    }
    if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`, data);
    return data;
  }
  const errorText = e => isNetworkError(e)
    ? 'Could not reach Dempo Learn. Check your connection and try again.'
    : e.message;
  function errorBlock(e) {
    const problems = e?.data?.problems;
    return notice('bad', `<p>${esc(errorText(e))}</p>${problems && problems.length > 1 ? `<ul>${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}`);
  }

  // ---------------- shell & router ----------------
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }

  function shell(content, active = '') {
    const u = state.user;
    const links = [['#/', 'Courses', 'home']];
    if (u.role === 'admin') links.push(['#/roster', 'Import students', 'roster'], ['#/students', 'Students', 'students']);
    const roleName = { admin: 'Exam office', faculty: 'Faculty', student: 'Student' }[u.role];
    $app.innerHTML = `
      <header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/">${LOGO}<span>Dempo Learn</span></a>
        <nav class="nav" aria-label="Main">${links.map(([h, l, k]) => `<a href="${h}" ${k === active ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
        <div class="whoami"><span><strong>${esc(u.name)}</strong> <span class="role">· ${roleName}${u.roll_no ? ' · ' + esc(u.roll_no) : ''}</span></span>
        <button type="button" id="logout">Sign out</button></div>
      </div></header>
      <main id="main" tabindex="-1">${content}</main>`;
    $('#logout').onclick = async () => {
      try { await api('POST', '/api/logout'); } catch { /* signing out locally anyway */ }
      state.user = null; go('#/login');
    };
    return $('#main');
  }
  const loading = (label = 'Loading…') => `<div class="loading"><span class="spinner"></span>${esc(label)}</div>`;

  const ROUTES = [
    [/^#\/login$/, viewLogin, true],
    [/^#\/?$/, viewHome],
    [/^#\/roster$/, viewRoster],
    [/^#\/students$/, viewStudents],
    [/^#\/course\/(\d+)\/exams\/new$/, viewExamNew],
    [/^#\/course\/(\d+)(?:\/(exams|gradebook|students))?$/, viewCourse],
    [/^#\/exam\/(\d+)$/, viewExam],
    [/^#\/exam\/(\d+)\/take$/, viewTake],
  ];

  async function route() {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    $$('.toast, .modal-backdrop').forEach(t => t.remove());
    const hash = location.hash || '#/';
    const match = ROUTES.map(([re, fn, pub]) => ({ m: hash.match(re), fn, pub })).find(r => r.m);
    if (!match) { go('#/'); return; }
    if (!match.pub && !state.user) {
      try { state.user = (await api('GET', '/api/me')).user; }
      catch (e) {
        if (isNetworkError(e) && /^#\/exam\/\d+\/take$/.test(hash)) { state.user = { name: 'Offline', role: 'student' }; }
        else { if (!(e instanceof ApiError && e.status === 401)) console.error(e); go('#/login'); return; }
      }
    }
    try { await match.fn(...match.m.slice(1)); }
    catch (e) {
      console.error(e);
      const main = state.user ? shell('') : $app;
      main.innerHTML = errorBlock(e) + `<p><a href="#/">Go to your courses</a></p>`;
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ---------------- login ----------------
  async function viewLogin() {
    if (state.user) { go('#/'); return; }
    $app.innerHTML = `
      <div class="login">
        <section class="login-side">
          <div>
            <div class="brand" style="margin-bottom:48px">${LOGO}<span>Dempo Learn</span></div>
            <h1>Coursework, exams and marks for the whole college.</h1>
            <p>Built for 2,000 students on campus WiFi, with data kept on the college's own server.</p>
          </div>
          <ul>
            <li>Bring a semester's roster in from one spreadsheet.</li>
            <li>Exams that keep answers safe when the WiFi drops, with the clock kept by the server.</li>
            <li>A gradebook that splits internal and external marks the way the university does.</li>
          </ul>
        </section>
        <section class="login-form">
          <h2>Sign in</h2>
          <form id="login-form" novalidate>
            <div id="login-error"></div>
            <div class="field"><label for="email">College email</label>
              <input id="email" type="email" autocomplete="username" required></div>
            <div class="field"><label for="password">Password <span class="hint">Students: your roll number, until you change it.</span></label>
              <input id="password" type="password" autocomplete="current-password" required></div>
            <button class="btn" type="submit" style="width:100%">Sign in</button>
          </form>
          <div class="demo-accounts">
            <p class="muted">Demo accounts — select one to sign in:</p>
            <button type="button" data-e="admin@dempo.edu" data-p="admin123"><strong>Exam office</strong> · imports the roster</button>
            <button type="button" data-e="priya.naik@dempo.edu" data-p="faculty123"><strong>Dr. Priya Naik</strong> · teaches CS201, CS202</button>
            <button type="button" data-e="aisha.dsouza@dempo.edu" data-p="23CS001"><strong>Aisha D'Souza</strong> · student, 23CS001</button>
          </div>
        </section>
      </div>`;
    const form = $('#login-form');
    const submit = async () => {
      const email = $('#email').value.trim(), password = $('#password').value;
      if (!email || !password) { $('#login-error').innerHTML = notice('bad', '<p>Enter your college email and password.</p>'); return; }
      const btn = $('button[type=submit]', form);
      btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…';
      try {
        state.user = (await api('POST', '/api/login', { email, password })).user;
        go('#/');
      } catch (e) {
        $('#login-error').innerHTML = errorBlock(e);
        btn.disabled = false; btn.textContent = 'Sign in';
      }
    };
    form.onsubmit = e => { e.preventDefault(); submit(); };
    $$('.demo-accounts button').forEach(b => b.onclick = () => { $('#email').value = b.dataset.e; $('#password').value = b.dataset.p; submit(); });
    $('#email').focus();
  }

  // ---------------- home ----------------
  async function viewHome() {
    const main = shell(loading('Loading your courses…'), 'home');
    const { courses } = await api('GET', '/api/courses');
    const u = state.user;
    let html = '';
    if (u.role === 'admin') {
      const { total } = await api('GET', '/api/students?q=');
      html += `<div class="page-head"><h1>Exam office</h1><p>Manage the student roster and see every course.</p></div>
        <div class="stats"><div class="stat"><span class="n">${total}</span><span class="l">students on the roster</span></div>
        <div class="stat"><span class="n">${courses.length}</span><span class="l">courses this semester</span></div>
        <div class="stat"><span class="n">${courses.reduce((a, c) => a + c.student_count, 0)}</span><span class="l">enrolments</span></div></div>
        <div class="row" style="margin-bottom:32px"><a class="btn" href="#/roster">${icon('upload')} Import students from CSV</a>
        <a class="btn btn-quiet" href="#/students">Find a student</a></div><h2>All courses</h2>`;
    } else {
      html += `<div class="page-head"><h1>${u.role === 'faculty' ? 'Your courses' : `Hello, ${esc(u.name.split(' ')[0])}`}</h1>
        <p>${u.role === 'faculty' ? 'Set exams, mark answers and keep the gradebook up to date.' : 'Your exams and marks for this semester.'}</p></div>`;
    }
    if (u.role === 'student') {
      const lists = await Promise.all(courses.map(c => api('GET', `/api/courses/${c.id}/exams`).then(r => r.exams.map(x => ({ ...x, course: c })))));
      const now = Date.now();
      const open = lists.flat().filter(x => x.opens_at <= now && x.closes_at > now && (!x.my_attempt || x.my_attempt.status === 'in_progress'));
      if (open.length) {
        html += `<h2>Open now</h2><ul class="list" style="margin-bottom:32px">${open.map(x => `<li>
          <span class="code">${esc(x.course.code)}</span>
          <div class="grow"><a class="title" href="#/exam/${x.id}">${esc(x.title)}</a>
          <div class="meta">${x.duration_min} minutes · ${plural(x.question_count, 'question')} · closes ${fmtDT(x.closes_at)}</div></div>
          ${x.my_attempt ? `<a class="btn" href="#/exam/${x.id}/take">Resume</a>` : `<a class="btn" href="#/exam/${x.id}">Open</a>`}</li>`).join('')}</ul>`;
      }
      html += '<h2>Courses</h2>';
    }
    if (!courses.length) {
      html += `<div class="empty"><h3>No courses yet</h3><p class="muted">${u.role === 'student'
        ? 'You are not enrolled in any course. If this is wrong, contact the exam office with your roll number.'
        : u.role === 'faculty' ? 'No courses are assigned to you yet. The exam office assigns courses at the start of the semester.'
          : 'Create courses in the database, then import students.'}</p></div>`;
    } else {
      html += `<ul class="list">${courses.map(c => `<li>
        <span class="code">${esc(c.code)}</span>
        <div class="grow"><a class="title" href="#/course/${c.id}">${esc(c.title)}</a>
        <div class="meta">${esc(c.faculty_name || 'No faculty assigned')} · ${esc(c.semester || '')}</div></div>
        <span class="meta">${plural(c.student_count, 'student')} · ${plural(c.exam_count, 'exam')}</span>
        <a class="btn btn-quiet btn-small" href="#/course/${c.id}/gradebook">${u.role === 'student' ? 'My marks' : 'Gradebook'}</a></li>`).join('')}</ul>`;
    }
    main.innerHTML = html;
  }

  // ---------------- Feature 1: roster import ----------------
  async function viewRoster() {
    if (state.user.role !== 'admin') { go('#/'); return; }
    const main = shell(`
      <div class="page-head"><h1>Import students</h1>
      <p>Upload one CSV with every student and the courses they take. You'll see exactly what will happen to each row before anything is saved.</p></div>
      <div class="grid-2" style="margin-bottom:24px">
        <section class="panel" style="margin:0">
          <h3>What the file needs</h3>
          <dl class="cols-spec">
            <dt>roll_no</dt><dd>3–20 letters, digits, - or /. Becomes the first password.</dd>
            <dt>name</dt><dd>Full name as it should appear on mark sheets.</dd>
            <dt>email</dt><dd>College email. Used to sign in; must be unique.</dd>
            <dt>course_code</dt><dd>e.g. CS201. One course per row — repeat the student for more.</dd>
            <dt>department</dt><dd>Optional.</dd>
          </dl>
          <p class="small muted" style="margin-top:12px">Columns can be in any order. Headers like "Roll No" or "Email Address" are understood.</p>
          <p class="small" style="margin:0"><a href="/samples/roster-template.csv" download>${icon('download', 14)} Template</a> ·
          <a href="/samples/students-with-errors.csv" download>Sample with mistakes</a> ·
          <a href="/samples/students-2000.csv" download>Sample with 2,000 students</a></p>
        </section>
        <section class="panel" style="margin:0">
          <h3>How problems are handled</h3>
          <ul class="small" style="padding-left:1.1em;margin:0">
            <li><strong>Rows with mistakes are left out</strong>, everything else is imported. You get a file of just the bad rows to fix and upload again.</li>
            <li><strong>Uploading the same file twice is safe.</strong> Students already enrolled are skipped, not duplicated.</li>
            <li>A student who already exists is enrolled in the new course; their details are not overwritten.</li>
            <li>An email or roll number that belongs to someone else is an error, never a silent merge.</li>
          </ul>
        </section>
      </div>
      <section class="panel">
        <div class="dropzone" id="drop">
          <p>${icon('upload', 28)}</p>
          <p><strong>Drop a CSV file here</strong> or</p>
          <label class="btn btn-quiet" style="display:inline-flex;margin:0">Choose file<input type="file" id="file" accept=".csv,text/csv" class="visually-hidden"></label>
          <p class="small muted" id="file-name" style="margin-top:12px">Up to 5,000 rows and 2 MB. Save from Excel as "CSV UTF-8".</p>
        </div>
        <details style="margin-top:16px"><summary>Or paste rows instead</summary>
          <div class="field" style="margin-top:12px"><label for="paste" class="visually-hidden">CSV text</label>
          <textarea id="paste" spellcheck="false" placeholder="roll_no,name,email,course_code&#10;24CS001,Neha Kerkar,neha.kerkar@dempo.edu,CS201"></textarea></div>
          <button class="btn btn-quiet" id="paste-go" type="button">Check pasted rows</button>
        </details>
      </section>
      <div id="result"></div>
      <section style="margin-top:32px"><h2>Recent imports</h2><div id="history">${loading()}</div></section>`, 'roster');

    let csv = null, filename = null, plan = null, filter = 'all';
    const result = $('#result');

    async function loadHistory() {
      try {
        const { batches } = await api('GET', '/api/roster/batches');
        $('#history').innerHTML = batches.length ? `<div class="table-wrap"><table class="cards"><thead><tr>
          <th>When</th><th>File</th><th class="num">Rows</th><th class="num">New students</th><th class="num">Enrolled</th><th class="num">Skipped</th><th class="num">Errors</th><th></th></tr></thead><tbody>
          ${batches.map(b => `<tr><td data-label="When">${esc(new Date(b.created_at.replace(' ', 'T') + 'Z').toLocaleString('en-IN'))}<div class="small muted">${esc(b.admin_name)}</div></td>
          <td data-label="File">${esc(b.filename)}</td><td data-label="Rows" class="num">${b.total_rows}</td>
          <td data-label="New students" class="num">${b.created}</td><td data-label="Enrolled" class="num">${b.enrolled}</td>
          <td data-label="Skipped" class="num">${b.skipped}</td>
          <td data-label="Errors" class="num">${b.failed ? `<span class="badge badge-bad">${b.failed}</span>` : '0'}</td>
          <td data-label="Report"><a href="/api/roster/batches/${b.id}/report.csv" download>Full report</a>${b.failed ? ` · <a href="/api/roster/batches/${b.id}/report.csv?errors=1" download>Rows to fix</a>` : ''}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty"><h3>No imports yet</h3><p class="muted">Your first upload will appear here with a downloadable report.</p></div>';
      } catch (e) { $('#history').innerHTML = errorBlock(e); }
    }
    loadHistory();

    async function preview() {
      result.innerHTML = `<section class="panel">${loading(`Checking ${filename || 'pasted rows'}…`)}</section>`;
      try {
        plan = await api('POST', '/api/roster/preview', { csv });
        filter = plan.summary.errors ? 'error' : 'all';
        renderPlan();
      } catch (e) { plan = null; result.innerHTML = errorBlock(e); }
    }

    const STATUS = {
      create: ['badge-ok', 'New student'], enrol: ['badge-info', 'Enrol'], skip: ['badge-plain', 'Skip'], error: ['badge-bad', 'Error'],
    };
    function renderPlan(done) {
      const s = plan.summary;
      const valid = s.enrolments;
      const rows = plan.results.filter(r => filter === 'all' || r.status === filter);
      const shown = rows.slice(0, 500);
      const counts = { all: s.total, create: plan.results.filter(r => r.status === 'create').length,
        enrol: plan.results.filter(r => r.status === 'enrol').length, skip: s.skipped, error: s.errors };
      result.innerHTML = `<section class="panel">
        ${done ? notice('ok', `<p><strong>Import finished.</strong> ${plural(s.newStudents, 'new student account')} created and ${plural(s.enrolments, 'enrolment')} added.
          ${s.errors ? `${plural(s.errors, 'row')} with mistakes ${s.errors === 1 ? 'was' : 'were'} left out — <a href="/api/roster/batches/${done}/report.csv?errors=1" download>download them to fix</a>.` : ''}</p>
          <p class="small">New students sign in with their college email and their roll number as the password.</p>`) : ''}
        <h2>${done ? 'Import report' : 'Check before importing'} <span class="muted small" style="font-weight:400">${esc(filename || 'pasted rows')}</span></h2>
        <div class="stats">
          <div class="stat"><span class="n">${s.total}</span><span class="l">rows in file</span></div>
          <div class="stat is-ok"><span class="n">${s.newStudents}</span><span class="l">new students</span></div>
          <div class="stat"><span class="n">${s.enrolments}</span><span class="l">enrolments${done ? ' added' : ' to add'}</span></div>
          <div class="stat"><span class="n">${s.skipped}</span><span class="l">skipped (already there)</span></div>
          <div class="stat ${s.errors ? 'is-bad' : ''}"><span class="n">${s.errors}</span><span class="l">rows with mistakes</span></div>
        </div>
        ${plan.ignoredColumns?.length ? notice('info', `<p>These columns aren't used and will be ignored: ${plan.ignoredColumns.map(esc).join(', ')}.</p>`) : ''}
        ${plan.warnings?.map(w => notice('warn', `<p>${esc(w)}</p>`)).join('') || ''}
        ${!done ? `<div class="row" style="margin-bottom:20px">
          <button class="btn" id="do-import" ${valid ? '' : 'disabled'}>Import ${plural(valid, 'enrolment')}</button>
          <button class="btn btn-quiet" id="cancel">Choose a different file</button>
          ${s.errors ? `<span class="small muted">The ${plural(s.errors, 'row')} with mistakes will be left out.</span>` : ''}
          ${!valid ? '<span class="small muted">Nothing new to import — every row is either already enrolled or has a mistake.</span>' : ''}</div>` : ''}
        <div class="filters" role="group" aria-label="Show rows">
          ${[['all', 'All'], ['error', 'Mistakes'], ['create', 'New students'], ['enrol', 'Enrol existing'], ['skip', 'Skipped']]
            .map(([k, l]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${l} (${counts[k]})</button>`).join('')}
        </div>
        ${rows.length ? `<div class="table-wrap"><table class="cards"><thead><tr><th>Line</th><th>Roll no</th><th>Name</th><th>Email</th><th>Course</th><th>What happens</th></tr></thead><tbody>
        ${shown.map(r => `<tr class="${r.status === 'error' ? 'row-error' : ''}"><td data-label="Line">${r.line}</td><td data-label="Roll no">${esc(r.roll_no) || '<span class="muted">empty</span>'}</td>
          <td data-label="Name">${esc(r.name)}</td><td data-label="Email">${esc(r.email)}</td><td data-label="Course">${esc(r.course_code)}</td>
          <td data-label="Result"><span class="badge ${STATUS[r.status][0]}">${STATUS[r.status][1]}</span> <span class="small">${esc(r.message)}</span></td></tr>`).join('')}
        </tbody></table></div>${rows.length > shown.length ? `<p class="small muted" style="margin-top:8px">Showing the first 500 of ${rows.length} rows.${done ? ' The full list is in the downloadable report.' : ''}</p>` : ''}`
        : '<p class="muted">No rows in this group.</p>'}
      </section>`;
      $$('.filters button', result).forEach(b => b.onclick = () => { filter = b.dataset.f; renderPlan(done); });
      $('#cancel', result)?.addEventListener('click', () => { plan = null; csv = null; result.innerHTML = ''; $('#file').value = ''; $('#file-name').textContent = 'Up to 5,000 rows and 2 MB.'; $('#drop').scrollIntoView(); });
      $('#do-import', result)?.addEventListener('click', async e => {
        const ok = await confirmDialog({ title: `Import ${plural(valid, 'enrolment')}?`,
          body: `<p>${plural(s.newStudents, 'new student account')} will be created.${s.errors ? ` ${plural(s.errors, 'row')} with mistakes will be left out.` : ''}</p><p class="small muted">You can upload the same file again later — nothing will be duplicated.</p>`,
          confirm: 'Import' });
        if (!ok) return;
        e.target.disabled = true; e.target.innerHTML = '<span class="spinner"></span> Importing…';
        try {
          const r = await api('POST', '/api/roster/import', { csv, filename });
          plan = r; filter = r.summary.errors ? 'error' : 'all';
          renderPlan(r.batchId); loadHistory();
          announce('Import finished');
          result.scrollIntoView();
        } catch (err) {
          e.target.disabled = false; e.target.textContent = `Import ${plural(valid, 'enrolment')}`;
          result.insertAdjacentHTML('afterbegin', errorBlock(err));
        }
      });
    }

    async function takeFile(file) {
      if (!file) return;
      if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
        result.innerHTML = notice('bad', `<p>"${esc(file.name)}" isn't a CSV file. In Excel, use File → Save As → "CSV UTF-8 (Comma delimited)".</p>`);
        return;
      }
      if (file.size > 2 * 1024 * 1024) { result.innerHTML = notice('bad', '<p>This file is larger than 2 MB. Split it into smaller files and upload them one at a time.</p>'); return; }
      filename = file.name; csv = await file.text();
      $('#file-name').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
      preview();
    }
    $('#file').onchange = e => takeFile(e.target.files[0]);
    const drop = $('#drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('is-over'); takeFile(e.dataTransfer.files[0]); });
    $('#paste-go').onclick = () => {
      const t = $('#paste').value;
      if (!t.trim()) { result.innerHTML = notice('bad', '<p>Paste at least a header row and one student.</p>'); return; }
      csv = t; filename = 'pasted rows'; preview();
    };
  }

  async function viewStudents() {
    if (state.user.role !== 'admin') { go('#/'); return; }
    const main = shell(`<div class="page-head"><h1>Students</h1></div>
      <div class="field" style="max-width:420px"><label for="q">Search by name, email or roll number</label><input id="q" type="search" autocomplete="off"></div>
      <div id="list">${loading()}</div>`, 'students');
    let timer;
    async function load() {
      try {
        const { total, students } = await api('GET', `/api/students?q=${encodeURIComponent($('#q').value)}`);
        $('#list', main).innerHTML = !total
          ? `<div class="empty"><h3>No students yet</h3><p class="muted">Import your roster from a CSV file to get started.</p><a class="btn" href="#/roster">Import students</a></div>`
          : !students.length ? `<p class="muted">No student matches "${esc($('#q').value)}".</p>`
            : `<p class="small muted">${students.length < total ? `Showing ${students.length} of ${total}` : `${total} students`}</p>
            <div class="table-wrap"><table class="cards"><thead><tr><th>Roll no</th><th>Name</th><th>Email</th><th>Department</th><th>Courses</th></tr></thead><tbody>
            ${students.map(s => `<tr><td data-label="Roll no">${esc(s.roll_no)}</td><td data-label="Name">${esc(s.name)}</td><td data-label="Email">${esc(s.email)}</td>
            <td data-label="Department">${esc(s.department || '—')}</td><td data-label="Courses">${esc(s.courses || '—')}</td></tr>`).join('')}</tbody></table></div>`;
      } catch (e) { $('#list', main).innerHTML = errorBlock(e); }
    }
    $('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(load, 250); };
    load();
  }

  // ---------------- course ----------------
  async function viewCourse(id, tab = 'exams') {
    const main = shell(loading(), 'home');
    const { course, access, students } = await api('GET', `/api/courses/${id}`);
    const manage = access === 'manage';
    const tabs = [['exams', 'Exams'], ['gradebook', manage ? 'Gradebook' : 'My marks']];
    if (manage) tabs.push(['students', `Students (${students.length})`]);
    main.innerHTML = `<div class="crumbs"><a href="#/">Courses</a></div>
      <div class="page-head"><h1>${esc(course.code)} · ${esc(course.title)}</h1><p>${esc(course.faculty_name || '')} · ${esc(course.semester || '')}</p></div>
      <nav class="tabs" aria-label="Course sections">${tabs.map(([k, l]) => `<a href="#/course/${id}/${k}" ${k === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
      <div id="tab">${loading()}</div>`;
    const el = $('#tab');
    if (tab === 'exams') return renderExamsTab(el, course, manage);
    if (tab === 'gradebook') return renderGradebookTab(el, course, manage);
    if (tab === 'students' && manage) {
      el.innerHTML = students.length ? `<div class="table-wrap"><table class="cards"><thead><tr><th>Roll no</th><th>Name</th><th>Email</th></tr></thead><tbody>
        ${students.map(s => `<tr><td data-label="Roll no">${esc(s.roll_no)}</td><td data-label="Name">${esc(s.name)}</td><td data-label="Email">${esc(s.email)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty"><h3>No students enrolled</h3><p class="muted">The exam office adds students by importing a CSV with this course's code (${esc(course.code)}).</p></div>`;
    }
  }

  function examWindow(x, now = Date.now()) {
    if (now < x.opens_at) return { k: 'upcoming', badge: `<span class="badge badge-plain">Opens ${fmtDT(x.opens_at)}</span>` };
    if (now >= x.closes_at) return { k: 'closed', badge: '<span class="badge badge-plain">Closed</span>' };
    return { k: 'open', badge: `<span class="badge badge-warn">${icon('clock', 12)} Open until ${fmtDT(x.closes_at)}</span>` };
  }

  async function renderExamsTab(el, course, manage) {
    const { exams } = await api('GET', `/api/courses/${course.id}/exams`);
    const head = manage ? `<div class="row-between" style="margin-bottom:16px"><p class="muted" style="margin:0">Exams are timed by the server and save answers every few seconds.</p>
      <a class="btn" href="#/course/${course.id}/exams/new">${icon('plus')} Create exam</a></div>` : '';
    if (!exams.length) {
      el.innerHTML = head + `<div class="empty"><h3>No exams yet</h3><p class="muted">${manage
        ? 'Create a quiz or test. Multiple-choice answers are marked automatically and can go straight into the gradebook.'
        : 'When your teacher sets an exam, it will appear here with the time it opens.'}</p></div>`;
      return;
    }
    el.innerHTML = head + `<ul class="list">${exams.map(x => {
      const w = examWindow(x);
      let action = `<a class="btn btn-quiet btn-small" href="#/exam/${x.id}">${manage ? 'Responses' : 'Details'}</a>`;
      let status = w.badge;
      if (!manage) {
        const a = x.my_attempt;
        if (a?.status === 'submitted') {
          status = a.graded ? `<span class="badge badge-ok">${icon('check', 12)} Scored ${fmtNum(a.total_score)} / ${fmtNum(x.max_marks)}</span>` : '<span class="badge badge-info">Submitted · being marked</span>';
        } else if (a?.status === 'in_progress') {
          status = '<span class="badge badge-warn">In progress</span>';
          action = `<a class="btn btn-small" href="#/exam/${x.id}/take">Resume</a>`;
        } else if (w.k === 'open') action = `<a class="btn btn-small" href="#/exam/${x.id}">Start</a>`;
        else if (w.k === 'closed') status = '<span class="badge badge-bad">Missed</span>';
      }
      return `<li><div class="grow"><a class="title" href="#/exam/${x.id}">${esc(x.title)}</a>
        <div class="meta">${x.duration_min} min · ${plural(x.question_count, 'question')} · ${fmtNum(x.max_marks)} marks${x.component_name && manage ? ` · goes to “${esc(x.component_name)}”` : ''}</div></div>
        ${status}${manage ? ` <span class="meta">${plural(x.attempt_count, 'response')}</span>${x.to_grade ? ` <span class="badge badge-warn">${x.to_grade} to mark</span>` : ''}` : ''}
        ${action}</li>`;
    }).join('')}</ul>`;
  }

  // ---------------- Feature 2: exams ----------------
  const toLocalInput = ms => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

  async function viewExamNew(courseId) {
    const main = shell(loading(), 'home');
    const [{ course, access }, gb] = await Promise.all([api('GET', `/api/courses/${courseId}`), api('GET', `/api/courses/${courseId}/gradebook`)]);
    if (access !== 'manage') { go(`#/course/${courseId}`); return; }
    const start = Math.ceil(Date.now() / 900000) * 900000;
    const qs = [{ type: 'mcq', prompt: '', options: ['', '', '', ''], correct_index: null, marks: 1 }];
    main.innerHTML = `<div class="crumbs"><a href="#/">Courses</a> / <a href="#/course/${course.id}">${esc(course.code)}</a></div>
      <div class="page-head"><h1>Create exam</h1><p>Students get one attempt. Their timer starts when they press Start and cannot be paused or reset.</p></div>
      <form id="exam-form" novalidate>
        <section class="panel">
          <div class="field"><label for="title">Title</label><input id="title" type="text" maxlength="150" placeholder="e.g. Quiz 2 — Trees and graphs"></div>
          <div class="field"><label for="instr">Instructions for students <span class="hint">Optional.</span></label><textarea id="instr" maxlength="2000" style="min-height:80px"></textarea></div>
          <div class="field-row">
            <div class="field"><label for="dur">Time allowed (minutes)</label><input id="dur" type="number" min="1" max="600" value="30"></div>
            <div class="field"><label for="opens">Opens</label><input id="opens" type="datetime-local" value="${toLocalInput(start)}"></div>
            <div class="field"><label for="closes">Closes <span class="hint">Nobody can work past this, even if they started late.</span></label><input id="closes" type="datetime-local" value="${toLocalInput(start + 7 * 86400000)}"></div>
          </div>
          <div class="field" style="margin:0"><label for="comp">Send scores to the gradebook column</label>
            <select id="comp"><option value="">Don't send to the gradebook</option>
            ${gb.components.map(c => `<option value="${c.id}">${esc(c.name)} (${c.category}, out of ${c.max_marks})</option>`).join('')}</select>
            <span class="hint">Scores are scaled to the column's maximum, e.g. 8/10 into a column out of 20 becomes 16.</span></div>
        </section>
        <h2>Questions</h2>
        <div id="qs"></div>
        <div class="row" style="margin-bottom:24px">
          <button class="btn btn-quiet" type="button" data-add="mcq">${icon('plus')} Multiple choice</button>
          <button class="btn btn-quiet" type="button" data-add="short">${icon('plus')} Short answer</button>
          <span class="muted small" id="q-total"></span></div>
        <div id="form-error"></div>
        <div class="row"><button class="btn" type="submit">Create exam</button><a class="btn btn-quiet" href="#/course/${course.id}">Cancel</a></div>
      </form>`;
    const qsEl = $('#qs');
    function renderQs() {
      qsEl.innerHTML = qs.map((q, i) => `<div class="q-edit" data-i="${i}">
        <div class="row-between" style="margin-bottom:8px"><strong>Question ${i + 1} · ${q.type === 'mcq' ? 'Multiple choice' : 'Short answer (you mark it)'}</strong>
        ${qs.length > 1 ? `<button type="button" class="btn btn-danger btn-small" data-del="${i}" aria-label="Remove question ${i + 1}">${icon('trash', 14)} Remove</button>` : ''}</div>
        <div class="field"><label for="p${i}" class="visually-hidden">Question ${i + 1} text</label><textarea id="p${i}" data-k="prompt" style="min-height:64px" placeholder="Question text">${esc(q.prompt)}</textarea></div>
        ${q.type === 'mcq' ? `<fieldset style="border:0;padding:0;margin:0 0 12px"><legend class="small muted" style="margin-bottom:6px">Options — select the correct one</legend>
          ${q.options.map((o, j) => `<div class="opt-row"><input type="radio" name="c${i}" value="${j}" ${q.correct_index === j ? 'checked' : ''} aria-label="Option ${j + 1} is correct">
          <input type="text" data-opt="${j}" value="${esc(o)}" placeholder="Option ${j + 1}" aria-label="Option ${j + 1}"></div>`).join('')}</fieldset>` : ''}
        <div style="max-width:140px"><label for="m${i}" class="small">Marks</label><input id="m${i}" type="number" min="0.5" step="0.5" data-k="marks" value="${q.marks}"></div>
      </div>`).join('');
      $('#q-total').textContent = `${plural(qs.length, 'question')} · ${round2(qs.reduce((a, q) => a + (Number(q.marks) || 0), 0))} marks`;
    }
    renderQs();
    qsEl.addEventListener('input', e => {
      const box = e.target.closest('.q-edit'); if (!box) return;
      const q = qs[Number(box.dataset.i)];
      if (e.target.dataset.k) q[e.target.dataset.k] = e.target.dataset.k === 'marks' ? Number(e.target.value) : e.target.value;
      if (e.target.dataset.opt !== undefined) q.options[Number(e.target.dataset.opt)] = e.target.value;
      if (e.target.type === 'radio') q.correct_index = Number(e.target.value);
      if (e.target.dataset.k === 'marks') $('#q-total').textContent = `${plural(qs.length, 'question')} · ${round2(qs.reduce((a, q) => a + (Number(q.marks) || 0), 0))} marks`;
    });
    qsEl.addEventListener('change', e => { if (e.target.type === 'radio') { const q = qs[Number(e.target.closest('.q-edit').dataset.i)]; q.correct_index = Number(e.target.value); } });
    qsEl.addEventListener('click', e => { const d = e.target.closest('[data-del]'); if (d) { qs.splice(Number(d.dataset.del), 1); renderQs(); } });
    $$('[data-add]').forEach(b => b.onclick = () => {
      qs.push(b.dataset.add === 'mcq' ? { type: 'mcq', prompt: '', options: ['', '', '', ''], correct_index: null, marks: 1 } : { type: 'short', prompt: '', marks: 5 });
      renderQs(); $(`#p${qs.length - 1}`).focus();
    });
    $('#exam-form').onsubmit = async e => {
      e.preventDefault();
      const btn = $('button[type=submit]', e.target);
      const body = {
        title: $('#title').value, instructions: $('#instr').value, duration_min: Number($('#dur').value),
        opens_at: new Date($('#opens').value).getTime(), closes_at: new Date($('#closes').value).getTime(),
        component_id: $('#comp').value || null,
        questions: qs.map(q => q.type === 'mcq' ? { ...q, options: q.options.filter(o => o.trim()), correct_index: q.correct_index } : q),
      };
      // keep correct_index aligned if blank options were removed before the correct one
      body.questions.forEach((q, i) => {
        if (q.type !== 'mcq' || qs[i].correct_index === null) return;
        const kept = qs[i].options.map((o, j) => [o, j]).filter(([o]) => o.trim());
        q.correct_index = kept.findIndex(([, j]) => j === qs[i].correct_index);
        if (q.correct_index < 0) q.correct_index = null;
      });
      btn.disabled = true;
      try {
        const { id } = await api('POST', `/api/courses/${course.id}/exams`, body);
        toast('Exam created');
        go(`#/exam/${id}`);
      } catch (err) { $('#form-error').innerHTML = errorBlock(err); btn.disabled = false; $('#form-error').scrollIntoView({ block: 'center' }); }
    };
  }

  async function viewExam(id) {
    const main = shell(loading(), 'home');
    const info = await api('GET', `/api/exams/${id}`);
    if (info.access === 'manage') return renderExamResponses(main, id);
    const { exam, course } = info;
    let attempt = null;
    try { attempt = (await api('GET', `/api/exams/${id}/attempt`)).attempt; } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
    if (attempt && !attempt.submitted_at) { go(`#/exam/${id}/take`); return; }
    const w = examWindow(exam, info.serverNow);
    main.innerHTML = `<div class="crumbs"><a href="#/">Courses</a> / <a href="#/course/${course.id}">${esc(course.code)}</a></div>
      <div class="exam-shell"><div class="page-head"><h1>${esc(exam.title)}</h1>
      <p>${exam.duration_min} minutes · ${plural(info.question_count, 'question')} · ${fmtNum(info.max_marks)} marks</p></div>
      ${attempt ? submittedPanel(attempt, info.max_marks, info.question_count, course) : `
        <section class="panel">
          ${exam.instructions ? `<p>${esc(exam.instructions)}</p>` : ''}
          <h3>Before you start</h3>
          <ul style="padding-left:1.1em">
            <li>You have <strong>${exam.duration_min} minutes</strong> from the moment you press Start${exam.closes_at - info.serverNow < exam.duration_min * 60000 && w.k === 'open' ? `, but the exam closes at <strong>${fmtDT(exam.closes_at)}</strong>, so you'll have less` : ''}.</li>
            <li>The timer keeps running if you close the page or lose WiFi. Come back to the same page to continue.</li>
            <li>Answers save automatically. If the connection drops, keep working — they're kept on this device and sent when you're back online.</li>
            <li>When time runs out, your saved answers are submitted for you.</li>
          </ul>
          <div id="start-error"></div>
          ${w.k === 'open' ? '<button class="btn" id="start">Start exam</button>'
            : w.k === 'upcoming' ? notice('info', `<p>This exam opens on <strong>${fmtDT(exam.opens_at)}</strong>. Come back then.</p>`)
              : notice('warn', '<p>This exam has closed. If you missed it for a genuine reason, speak to your teacher.</p>')}
        </section>`}</div>`;
    $('#start')?.addEventListener('click', async e => {
      const ok = await confirmDialog({ title: 'Start the exam now?', body: `<p>Your ${exam.duration_min}-minute timer starts as soon as you press Start, and can't be paused.</p>`, confirm: 'Start' });
      if (!ok) return;
      e.target.disabled = true;
      try { await api('POST', `/api/exams/${id}/start`); go(`#/exam/${id}/take`); }
      catch (err) { $('#start-error').innerHTML = errorBlock(err); e.target.disabled = false; }
    });
  }

  function submittedPanel(a, maxMarks, qCount, course) {
    const why = a.submit_reason === 'timeout'
      ? `Time ran out, so the answers saved by ${fmtTime(a.submitted_at)} were submitted for you.`
      : `You submitted at ${fmtTime(a.submitted_at)}.`;
    return `<section class="panel">
      ${notice('ok', `<p><strong>Your exam has been submitted.</strong> ${why}</p>`)}
      <div class="stats"><div class="stat"><span class="n">${a.answered} / ${qCount}</span><span class="l">questions answered</span></div>
      <div class="stat"><span class="n">${a.graded ? `${fmtNum(a.total_score)} / ${fmtNum(maxMarks)}` : '—'}</span><span class="l">${a.graded ? 'your score' : 'score — your teacher is marking the written answers'}</span></div></div>
      <a class="btn btn-quiet" href="#/course/${course.id}">Back to ${esc(course.code)}</a></section>`;
  }

  // The exam runner. Everything here is about not losing a student's work.
  async function viewTake(examId) {
    const cacheKey = `dl-exam-${examId}`;
    $app.innerHTML = loading('Opening your exam…');
    let data, fromCache = false;
    let offset = 0; // serverTime - deviceTime
    try {
      const t0 = Date.now();
      data = await api('GET', `/api/exams/${examId}/attempt`);
      const t1 = Date.now();
      offset = data.serverNow - (t0 + t1) / 2;
      if (!data.attempt.submitted_at) store.set(cacheKey, { ...data, offset });
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) { go(`#/exam/${examId}`); return; }
      const cached = store.get(cacheKey);
      if (isNetworkError(e) && cached) { data = cached; offset = cached.offset || 0; fromCache = true; }
      else throw e;
    }
    if (data.attempt.submitted_at) { store.del(cacheKey); return showSubmitted(); }

    const attemptId = data.attempt.id;
    const localKey = `dl-attempt-${attemptId}`;
    const questions = data.questions;
    const deadline = data.attempt.deadline;
    const total = deadline - data.attempt.started_at;
    let answers = { ...data.attempt.answers };
    let seq = data.attempt.save_seq;
    let ackSeq = data.attempt.save_seq;
    let lastSavedAt = data.attempt.last_saved_at;
    const local = store.get(localKey);
    if (local && local.seq > seq) { answers = local.answers; seq = local.seq; } // unsent work from before a reload
    if (local && local.ackSeq > ackSeq && fromCache) { ackSeq = local.ackSeq; lastSavedAt = local.lastSavedAt; }

    let inflight = false, offline = fromCache || sim.offline, nextTryAt = 0, backoff = 0, finishing = false, lastErr = null;
    const persist = () => store.set(localKey, { seq, answers, ackSeq, lastSavedAt });
    const serverNow = () => Date.now() + offset;

    $app.innerHTML = `
      <div class="timer" id="timer"><div class="timer-inner">
        <div><div class="timer-clock" id="clock" aria-hidden="true">--:--</div><div class="timer-label">time left</div></div>
        <div style="min-width:0"><div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(data.exam.title)}</div>
        <div class="timer-label" id="progress"></div></div>
        <div class="save-state" id="save" role="status"><span class="dot"></span><span id="save-text">Saved</span></div>
      </div><div class="timer-track"><div class="timer-fill" id="fill"></div></div></div>
      <div id="offline-bar"></div>
      <main id="main" tabindex="-1" style="padding-top:24px"><div class="exam-shell">
        <p class="small muted">${esc(data.course.code)} · ${fmtNum(data.max_marks)} marks · ends at ${fmtTime(deadline)} (server time)</p>
        ${data.exam.instructions ? `<p class="small">${esc(data.exam.instructions)}</p>` : ''}
        <form id="qs" novalidate>${questions.map((q, i) => `
          <div class="question"><fieldset>
            <legend><span class="qn">${i + 1}.</span><span>${esc(q.prompt)}</span><span class="qm">${plural(q.marks, 'mark')}</span></legend>
            ${q.type === 'mcq' ? q.options.map((o, j) => `<label class="option"><input type="radio" name="q${q.id}" value="${j}" ${answers[q.id] === j ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')
              : `<label for="t${q.id}" class="visually-hidden">Your answer to question ${i + 1}</label><textarea id="t${q.id}" name="q${q.id}" maxlength="5000" placeholder="Type your answer">${esc(answers[q.id] || '')}</textarea>`}
          </fieldset></div>`).join('')}
        </form>
        <div id="submit-area" class="row-between" style="margin-top:24px">
          <span class="muted small" id="submit-hint"></span>
          <button class="btn" type="button" id="submit">Submit exam</button></div>
        <div class="demo-tools"><strong>Demo tool</strong> — show how the exam survives a dropped connection.
          <div class="row" style="margin-top:8px"><button type="button" class="btn btn-quiet btn-small" id="sim">${sim.offline ? 'Reconnect WiFi' : 'Simulate WiFi drop'}</button>
          <span id="sim-note"></span></div></div>
      </div></main>`;

    const $save = $('#save'), $saveText = $('#save-text'), $clock = $('#clock'), $fill = $('#fill'), $timer = $('#timer');
    function answeredCount() { return questions.filter(q => answers[q.id] !== undefined && answers[q.id] !== '').length; }
    function renderProgress() {
      const n = answeredCount();
      $('#progress').innerHTML = `${n}<span class="wide"> of </span><span class="narrow">/</span>${questions.length}<span class="wide"> answered</span>`;
      $('#progress').setAttribute('aria-label', `${n} of ${questions.length} answered`);
      $('#submit-hint').textContent = n < questions.length ? `${questions.length - n} unanswered` : 'All questions answered';
    }
    function renderSave() {
      if (!$save.isConnected) return; // a save finished after the student left this page
      const pending = seq > ackSeq;
      $save.className = 'save-state';
      if (finishing) { $saveText.textContent = 'Submitting…'; $save.classList.add('is-saving'); }
      else if (offline) { $save.classList.add('is-offline'); $saveText.textContent = pending ? 'Offline · kept on device' : 'Offline · all saved'; }
      else if (lastErr) { $save.classList.add('is-error'); $saveText.textContent = 'Not saved · retrying'; }
      else if (pending || inflight) { $save.classList.add('is-saving'); $saveText.textContent = 'Saving…'; }
      else $saveText.textContent = lastSavedAt ? `Saved ${fmtAgo(lastSavedAt, serverNow())}` : 'Ready';
      $('#offline-bar').innerHTML = offline
        ? `<div class="offline-bar"><div>${icon('wifiOff', 14)} You're offline. Keep working — your answers are stored on this device and will be sent as soon as the connection is back.${lastSavedAt ? ` Last reached the server at ${fmtTime(lastSavedAt)}.` : ''}</div></div>`
        : lastErr ? `<div class="offline-bar"><div>${esc(lastErr)}</div></div>` : '';
    }
    renderProgress(); renderSave();

    async function flush() {
      if (inflight || seq <= ackSeq || finishing) return;
      inflight = true;
      const sending = seq, payload = { ...answers };
      renderSave();
      try {
        const r = await api('PUT', `/api/attempts/${attemptId}/answers`, { answers: payload, seq: sending });
        ackSeq = Math.max(ackSeq, r.seq); lastSavedAt = r.savedAt;
        if (offline) announce('Back online. Your answers are saved.');
        offline = false; lastErr = null; backoff = 0; persist();
      } catch (e) {
        if (isNetworkError(e)) {
          if (!offline) announce('Connection lost. Your answers are being kept on this device.');
          offline = true; backoff = Math.min(backoff ? backoff * 2 : 2000, 15000); nextTryAt = Date.now() + backoff;
        } else if (e.data?.code === 'expired' || e.data?.code === 'submitted') {
          inflight = false; return showSubmitted();
        } else { lastErr = e.message; backoff = Math.min(backoff ? backoff * 2 : 3000, 30000); nextTryAt = Date.now() + backoff; }
      } finally { inflight = false; renderSave(); }
    }

    function onAnswer(qid, value, delay) {
      if (finishing) return;
      if (value === '' || value === null) delete answers[qid]; else answers[qid] = value;
      seq += 1; persist();
      // Online: save shortly after the student stops typing. Offline: keep the backoff schedule.
      if (!offline && !lastErr) nextTryAt = Date.now() + delay;
      renderProgress(); renderSave();
    }
    const form = $('#qs');
    form.addEventListener('change', e => { if (e.target.type === 'radio') onAnswer(e.target.name.slice(1), Number(e.target.value), 150); });
    form.addEventListener('input', e => { if (e.target.tagName === 'TEXTAREA') onAnswer(e.target.name.slice(1), e.target.value, 1200); });
    form.addEventListener('submit', e => e.preventDefault());

    // Clock: always derived from the server's deadline, corrected by our measured offset.
    let lastShown = -1, warned5 = false, warned1 = false;
    function tick() {
      const left = deadline - serverNow();
      const sec = Math.ceil(left / 1000);
      if (sec !== lastShown) {
        lastShown = sec;
        $clock.textContent = fmtClock(left);
        $fill.style.transform = `scaleX(${Math.max(0, Math.min(1, left / total))})`;
        $timer.classList.toggle('is-low', left <= 60000);
        if (!warned5 && left <= 300000 && left > 240000) { warned5 = true; announce('5 minutes left.'); }
        if (!warned1 && left <= 60000 && left > 0) { warned1 = true; announce('1 minute left. Your answers will be submitted automatically.'); }
        renderSave();
      }
      if (left <= 0 && !finishing) finish('timeout');
      if (!finishing && seq > ackSeq && !inflight && Date.now() >= nextTryAt) flush();
    }
    const tickTimer = setInterval(tick, 250);
    tick();

    // Re-measure the server clock now and then (and right after reconnecting).
    async function resync() {
      if (sim.offline) return;
      try { const t0 = Date.now(); const r = await api('GET', '/api/time'); offset = r.serverNow - (t0 + Date.now()) / 2; } catch { /* stay with the old offset */ }
    }
    const syncTimer = setInterval(resync, 30000);
    if (fromCache) resync();
    const onOnline = () => { if (sim.offline) return; nextTryAt = 0; offline = false; resync(); flush(); renderSave(); };
    const onOffline = () => { offline = true; renderSave(); };
    const onUnload = e => { if (seq > ackSeq) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('beforeunload', onUnload);
    cleanup = () => {
      clearInterval(tickTimer); clearInterval(syncTimer);
      window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); window.removeEventListener('beforeunload', onUnload);
    };

    $('#sim').onclick = () => {
      sim.offline = !sim.offline;
      $('#sim').textContent = sim.offline ? 'Reconnect WiFi' : 'Simulate WiFi drop';
      $('#sim-note').textContent = sim.offline ? 'All requests now fail as if the WiFi dropped. Keep answering, reload the page — nothing is lost.' : '';
      if (sim.offline) onOffline(); else onOnline();
    };

    $('#submit').onclick = async () => {
      const left = questions.length - answeredCount();
      const ok = await confirmDialog({
        title: 'Submit your exam?',
        body: left ? `<p><strong>${plural(left, 'question')} ${left === 1 ? 'is' : 'are'} unanswered.</strong> You can't change your answers after submitting.</p>`
          : '<p>You\'ve answered every question. You can\'t change your answers after submitting.</p>',
        confirm: 'Submit exam', cancel: 'Keep working' });
      if (ok) finish('student');
    };

    async function finish(reason) {
      if (finishing) return;
      finishing = true;
      form.classList.add('is-locked');
      $$('input, textarea', form).forEach(i => { i.readOnly = true; if (i.type === 'radio') i.disabled = true; });
      $('#submit').disabled = true;
      $('#submit-hint').textContent = reason === 'timeout' ? 'Time is up. Submitting your answers…' : 'Submitting…';
      renderSave();
      for (let attemptNo = 0; ; attemptNo++) {
        try {
          await api('POST', `/api/attempts/${attemptId}/submit`, { answers, seq });
          store.del(localKey); store.del(cacheKey);
          return showSubmitted();
        } catch (e) {
          if (!isNetworkError(e)) {
            // The server already closed the attempt (e.g. finalised at the deadline). Show what it has.
            if (e.status === 409 || e.status === 404) { store.del(localKey); return showSubmitted(); }
          }
          offline = isNetworkError(e); renderSave();
          $('#submit-hint').textContent = reason === 'timeout'
            ? `Time is up. You're offline, so we're still trying to send your last answers. Answers saved by ${lastSavedAt ? fmtTime(lastSavedAt) : 'the start'} are already safe on the server.`
            : 'Couldn\'t reach the server to submit. Retrying — don\'t close this page.';
          await new Promise(r => setTimeout(r, Math.min(2000 * (attemptNo + 1), 8000)));
        }
      }
    }

    async function showSubmitted() {
      if (cleanup) { cleanup(); cleanup = null; }
      const main = state.user?.email ? shell(loading('Loading your result…'), 'home') : ($app.innerHTML = loading(), $app);
      try {
        const r = await api('GET', `/api/exams/${examId}/attempt`);
        main.innerHTML = `<div class="crumbs"><a href="#/">Courses</a> / <a href="#/course/${r.course.id}">${esc(r.course.code)}</a></div>
          <div class="exam-shell"><div class="page-head"><h1>${esc(r.exam.title)}</h1></div>${submittedPanel(r.attempt, r.max_marks, r.questions.length, r.course)}</div>`;
      } catch (e) { main.innerHTML = errorBlock(e); }
    }
  }

  async function renderExamResponses(main, id) {
    const load = () => api('GET', `/api/exams/${id}/attempts`);
    let d = await load();
    let open = null; // attempt id being marked
    let refresh;
    function render() {
      const now = d.serverNow;
      const inProg = d.attempts.filter(a => !a.submitted_at);
      const done = d.attempts.filter(a => a.submitted_at);
      const timeouts = done.filter(a => a.submit_reason === 'timeout').length;
      const toMark = done.filter(a => !a.graded).length;
      const scored = done.filter(a => a.graded);
      const avg = scored.length ? scored.reduce((x, a) => x + a.total_score, 0) / scored.length : null;
      const hasShort = d.questions.some(q => q.type === 'short');
      main.innerHTML = `<div class="crumbs"><a href="#/">Courses</a> / <a href="#/course/${d.course.id}">${esc(d.course.code)}</a></div>
        <div class="page-head"><h1>${esc(d.exam.title)}</h1>
        <p>${d.exam.duration_min} min · ${plural(d.questions.length, 'question')} · ${fmtNum(d.max_marks)} marks · open ${fmtDT(d.exam.opens_at)} to ${fmtDT(d.exam.closes_at)}</p></div>
        <div class="stats">
          <div class="stat"><span class="n">${d.attempts.length + d.not_started.length}</span><span class="l">enrolled</span></div>
          <div class="stat is-warn"><span class="n">${inProg.length}</span><span class="l">writing now</span></div>
          <div class="stat is-ok"><span class="n">${done.length}</span><span class="l">submitted${timeouts ? ` (${timeouts} when time ran out)` : ''}</span></div>
          <div class="stat ${toMark ? 'is-warn' : ''}"><span class="n">${toMark}</span><span class="l">to mark</span></div>
          <div class="stat"><span class="n">${avg === null ? '—' : fmtNum(avg)}</span><span class="l">average / ${fmtNum(d.max_marks)}</span></div>
        </div>
        ${d.exam.component_id ? notice('info', `<p>Scores go to the gradebook automatically${hasShort ? ' once the written answers are marked' : ''}.</p>`) : ''}
        <div class="row-between" style="margin-bottom:12px"><h2 style="margin:0">Responses</h2><span class="small muted">Updates every 15 seconds · last ${fmtTime(now)}</span></div>
        ${d.attempts.length ? `<div class="table-wrap"><table class="cards"><thead><tr><th>Student</th><th>Status</th><th>Autosaves</th><th class="num">Score</th><th></th></tr></thead><tbody>
          ${d.attempts.map(a => `<tr><td data-label="Student"><strong>${esc(a.student.name)}</strong><div class="small muted">${esc(a.student.roll_no)}</div></td>
          <td data-label="Status">${!a.submitted_at ? `<span class="badge badge-warn">Writing · ${fmtClock(a.deadline - now)} left</span>`
            : a.submit_reason === 'timeout' ? '<span class="badge badge-plain">Submitted when time ran out</span>' : `<span class="badge badge-ok">Submitted ${fmtTime(a.submitted_at)}</span>`}</td>
          <td data-label="Autosaves">${a.save_count}${a.last_saved_at ? `<div class="small muted">last ${fmtTime(a.last_saved_at)}</div>` : ''}</td>
          <td data-label="Score" class="num">${a.graded ? `${fmtNum(a.total_score)} / ${fmtNum(d.max_marks)}` : a.submitted_at ? '<span class="badge badge-warn">To mark</span>' : '—'}</td>
          <td data-label="">${a.submitted_at ? `<button class="btn ${a.graded ? 'btn-quiet' : ''} btn-small" data-open="${a.id}">${a.graded ? 'View' : 'Mark'}</button>` : ''}</td></tr>
          ${open === a.id ? `<tr><td colspan="5" style="background:#fafbfa">${markPanel(a)}</td></tr>` : ''}`).join('')}
          </tbody></table></div>` : '<div class="empty"><h3>No responses yet</h3><p class="muted">Students appear here as soon as they press Start.</p></div>'}
        ${d.not_started.length ? `<h3 style="margin-top:24px">Not started (${d.not_started.length})</h3><p class="small muted">${d.not_started.map(s => `${esc(s.name)} (${esc(s.roll_no)})`).join(', ')}</p>` : ''}`;
      $$('[data-open]', main).forEach(b => b.onclick = () => { open = open === Number(b.dataset.open) ? null : Number(b.dataset.open); render(); });
      const form = $('#mark-form', main);
      if (form) form.onsubmit = async e => {
        e.preventDefault();
        const marks = {};
        $$('input[data-q]', form).forEach(i => { marks[i.dataset.q] = i.value; });
        try {
          await api('PUT', `/api/attempts/${open}/grade`, { marks });
          toast('Marks saved'); open = null; d = await load(); render();
        } catch (err) { $('#mark-error', main).innerHTML = errorBlock(err); }
      };
    }
    function markPanel(a) {
      const shortQs = d.questions.filter(q => q.type === 'short');
      return `<form id="mark-form" class="stack" style="max-width:720px">${d.questions.map(q => {
        const ans = a.answers[q.id];
        if (q.type === 'mcq') {
          const right = ans === q.correct_index;
          return `<div><strong>${q.position}. ${esc(q.prompt)}</strong>
            <div class="small">${ans === undefined ? '<span class="badge badge-plain">Not answered</span>' : `${right ? '<span class="badge badge-ok">Correct</span>' : '<span class="badge badge-bad">Incorrect</span>'} ${esc(q.options[ans])}`}
            ${!right ? ` <span class="muted">· answer: ${esc(q.options[q.correct_index])}</span>` : ''} · ${right ? q.marks : 0}/${q.marks}</div></div>`;
        }
        return `<div><strong>${q.position}. ${esc(q.prompt)}</strong>
          <p style="white-space:pre-wrap;background:#fff;border:1px solid var(--line);padding:8px 12px;border-radius:4px;margin:6px 0">${ans ? esc(ans) : '<span class="muted">Not answered</span>'}</p>
          <label for="mk${q.id}" class="small">Marks out of ${q.marks}</label>
          <input id="mk${q.id}" data-q="${q.id}" type="number" min="0" max="${q.marks}" step="0.5" value="${a.manual[q.id] ?? ''}" style="max-width:120px" ${a.graded && !shortQs.length ? 'readonly' : ''}></div>`;
      }).join('')}
      <div id="mark-error"></div>
      ${shortQs.length ? `<div class="row"><button class="btn" type="submit">${a.graded ? 'Update marks' : 'Save marks'}</button><span class="small muted">Multiple-choice: ${fmtNum(a.auto_score)} marked automatically.</span></div>` : ''}</form>`;
    }
    render();
    refresh = setInterval(async () => { if (open) return; try { d = await load(); render(); } catch { /* try again next time */ } }, 15000);
    cleanup = () => clearInterval(refresh);
  }

  // ---------------- Feature 3: gradebook ----------------
  // Same formula as src/grades.js — kept in step so totals update as faculty type.
  function computeRow(components, byComp, minExt, scale) {
    let internal = 0, external = 0, iw = 0, ew = 0, missing = 0;
    for (const c of components) {
      const m = byComp[c.id];
      if (c.category === 'internal') iw += c.weight; else ew += c.weight;
      if (m === undefined || m === null || m === '') { missing++; continue; }
      const contrib = (Number(m) / c.max_marks) * c.weight;
      if (c.category === 'internal') internal += contrib; else external += contrib;
    }
    const totalScore = internal + external;
    let grade = null, reason = null;
    if (!missing && components.length) {
      const extPct = ew > 0 ? (external / ew) * 100 : 100;
      if (ew > 0 && extPct + 1e-9 < minExt) { grade = scale[scale.length - 1]; reason = `External below ${minExt}%`; }
      else grade = scale.find(s => totalScore >= s.min - 1e-9);
    }
    return { internal: round2(internal), external: round2(external), total: round2(totalScore), missing, grade: grade?.letter ?? null, reason };
  }
  const gradeChip = (g, missing) => g ? `<span class="grade ${g === 'F' ? 'grade-F' : 'grade-pass'}">${g}</span>`
    : `<span class="grade grade-none" title="${missing} mark(s) missing">${missing ? 'Incomplete' : '—'}</span>`;
  const GRADE_COLORS = { O: '#0c3532', 'A+': '#13574f', A: '#2a7a6e', 'B+': '#3a7a70', B: '#56752a', C: '#8a6d00', P: '#a35c00', F: '#a4231c' };

  async function renderGradebookTab(el, course, manage) {
    let gb = await api('GET', `/api/courses/${course.id}/gradebook`);
    if (!manage) return renderMyMarks(el, gb);

    let comps = gb.components.map(c => ({ ...c }));
    let values = {}; // studentId -> compId -> string
    let dirty = new Set();
    let editingCols = !gb.validation.ok;
    const reset = () => {
      values = {}; dirty = new Set();
      for (const r of gb.rows) { values[r.student.id] = {}; for (const p of r.parts) values[r.student.id][p.component_id] = p.marks === null ? '' : String(p.marks); }
    };
    reset();

    function render() {
      const s = gb.stats;
      const distTotal = Object.values(s.distribution).reduce((a, b) => a + b, 0);
      const iW = gb.components.filter(c => c.category === 'internal').reduce((a, c) => a + c.weight, 0);
      const eW = gb.components.filter(c => c.category === 'external').reduce((a, c) => a + c.weight, 0);
      el.innerHTML = `
        <div class="stats">
          <div class="stat"><span class="n">${s.students}</span><span class="l">students</span></div>
          <div class="stat"><span class="n">${s.complete}</span><span class="l">with all marks in</span></div>
          <div class="stat is-ok"><span class="n">${s.passed}</span><span class="l">passing</span></div>
          <div class="stat ${s.complete - s.passed ? 'is-bad' : ''}"><span class="n">${s.complete - s.passed}</span><span class="l">failing</span></div>
          <div class="stat"><span class="n">${s.average ?? '—'}</span><span class="l">class average / 100</span></div>
        </div>
        ${distTotal ? `<div style="margin-bottom:24px"><div class="small muted" style="margin-bottom:6px">Grade distribution (students with all marks in)</div>
          <div class="dist" role="img" aria-label="${Object.entries(s.distribution).filter(([, n]) => n).map(([g, n]) => `${g}: ${n}`).join(', ')}">
          ${Object.entries(s.distribution).filter(([, n]) => n).map(([g, n]) => `<span style="flex:${n};background:${GRADE_COLORS[g]}" title="${g}: ${n}">${g} · ${n}</span>`).join('')}</div></div>` : ''}
        <details class="panel" ${editingCols ? 'open' : ''} id="cols">
          <summary style="cursor:pointer"><strong>Columns and weights</strong> <span class="muted small">· Internal ${round2(iW)} + External ${round2(eW)} = ${round2(iW + eW)} · Pass needs 40 overall and ${gb.course.min_external_pct}% of external</span></summary>
          <div style="margin-top:16px" id="comp-ed"></div>
        </details>
        ${!gb.components.length ? '<div class="empty"><h3>Set up the gradebook</h3><p class="muted">Add the components marks are made of — for example internal tests and assignments, and the external university exam — with their weights.</p></div>'
          : !gb.rows.length ? '<div class="empty"><h3>No students enrolled yet</h3><p class="muted">Once the exam office imports the roster, students appear here.</p></div>'
          : `<div class="row-between" style="margin-bottom:12px"><h2 style="margin:0">Marks</h2>
            <div class="row"><span class="small muted">Enter moves down a row. Empty means not yet marked.</span>
            <a class="btn btn-quiet btn-small" href="/api/courses/${course.id}/gradebook.csv" download>${icon('download', 14)} Export CSV</a></div></div>
          <div class="gb-wrap"><table class="gb"><thead><tr><th class="sticky">Student</th>
            ${gb.components.map(c => `<th class="num"><span class="comp-h">${esc(c.name)}</span><span class="cat cat-${c.category}">${c.category === 'internal' ? 'Internal' : 'External'}</span> · ${c.weight}% · /${c.max_marks}</th>`).join('')}
            <th class="num">Internal<br><span class="cat">/${round2(iW)}</span></th><th class="num">External<br><span class="cat">/${round2(eW)}</span></th><th class="num">Total<br><span class="cat">/100</span></th><th>Grade</th></tr></thead>
            <tbody>${gb.rows.map(r => `<tr data-s="${r.student.id}"><td class="sticky"><strong>${esc(r.student.name)}</strong><div class="small muted">${esc(r.student.roll_no)}</div></td>
              ${gb.components.map((c, ci) => { const p = r.parts.find(x => x.component_id === c.id); return `<td class="num">
                <input type="number" inputmode="decimal" min="0" max="${c.max_marks}" step="0.5" data-c="${c.id}" data-ci="${ci}" value="${esc(values[r.student.id][c.id])}" aria-label="${esc(c.name)} for ${esc(r.student.name)}, out of ${c.max_marks}">
                ${p?.source === 'exam' ? '<span class="from-exam">from online exam</span>' : ''}</td>`; }).join('')}
              <td class="calc" data-k="internal"></td><td class="calc" data-k="external"></td><td class="calc total" data-k="total"></td><td data-k="grade"></td></tr>`).join('')}
            </tbody></table></div>
          <div class="savebar" id="savebar" hidden><span id="dirty-n" class="small"></span><span id="mark-err" class="field-error" style="margin:0"></span>
            <span style="margin-left:auto" class="row"><button class="btn btn-quiet" id="discard" type="button">Discard changes</button><button class="btn" id="save-marks" type="button">Save marks</button></span></div>`}`;
      renderCompEditor();
      $$('tr[data-s]', el).forEach(tr => updateRow(Number(tr.dataset.s)));
      wireGrid();
      $('#cols', el).addEventListener('toggle', e => { editingCols = e.target.open; });
    }

    function updateRow(sid) {
      const tr = $(`tr[data-s="${sid}"]`, el); if (!tr) return;
      const byComp = {};
      let bad = false;
      for (const c of gb.components) {
        const v = values[sid][c.id];
        const n = Number(v);
        const invalid = v !== '' && (!Number.isFinite(n) || n < 0 || n > c.max_marks);
        const inp = $(`input[data-c="${c.id}"]`, tr);
        inp.setAttribute('aria-invalid', invalid ? 'true' : 'false');
        inp.title = invalid ? `Must be between 0 and ${c.max_marks}` : '';
        inp.classList.toggle('is-dirty', dirty.has(`${sid}:${c.id}`));
        if (invalid) bad = true; else if (v !== '') byComp[c.id] = n;
      }
      const r = computeRow(gb.components, byComp, gb.course.min_external_pct, gb.scale);
      $('[data-k="internal"]', tr).textContent = r.internal;
      $('[data-k="external"]', tr).textContent = r.external;
      $('[data-k="total"]', tr).textContent = r.total;
      $('[data-k="grade"]', tr).innerHTML = bad ? '<span class="field-error">Check marks</span>' : gradeChip(r.grade, r.missing) + (r.reason ? `<div class="small" style="color:var(--bad)">${esc(r.reason)}</div>` : '');
    }

    function updateSavebar() {
      const bar = $('#savebar', el); if (!bar) return;
      bar.hidden = dirty.size === 0;
      $('#dirty-n', el).textContent = `${plural(dirty.size, 'unsaved change')}`;
    }

    function wireGrid() {
      const table = $('.gb', el); if (!table) return;
      table.addEventListener('input', e => {
        const inp = e.target; if (!inp.dataset.c) return;
        const sid = Number(inp.closest('tr').dataset.s), cid = Number(inp.dataset.c);
        values[sid][cid] = inp.value.trim();
        const orig = gb.rows.find(r => r.student.id === sid).parts.find(p => p.component_id === cid).marks;
        const origStr = orig === null ? '' : String(orig);
        if (values[sid][cid] === origStr) dirty.delete(`${sid}:${cid}`); else dirty.add(`${sid}:${cid}`);
        updateRow(sid); updateSavebar();
      });
      table.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || !e.target.dataset.c) return;
        e.preventDefault();
        const tr = e.target.closest('tr');
        const next = (e.shiftKey ? tr.previousElementSibling : tr.nextElementSibling);
        $(`input[data-ci="${e.target.dataset.ci}"]`, next || tr)?.focus();
        $(`input[data-ci="${e.target.dataset.ci}"]`, next || tr)?.select();
      });
      $('#discard', el)?.addEventListener('click', () => { reset(); render(); });
      $('#save-marks', el)?.addEventListener('click', async e => {
        const entries = [...dirty].map(k => { const [sid, cid] = k.split(':').map(Number); return { student_id: sid, component_id: cid, marks: values[sid][cid] }; });
        if ($$('.gb [aria-invalid="true"]', el).length) { $('#mark-err', el).textContent = 'Some marks are outside the allowed range (highlighted in red). Fix them before saving.'; return; }
        e.target.disabled = true; e.target.innerHTML = '<span class="spinner"></span> Saving…';
        try {
          gb = await api('PUT', `/api/courses/${course.id}/marks`, { entries });
          reset(); render(); toast(`Saved ${plural(entries.length, 'mark')}`);
        } catch (err) { $('#mark-err', el).textContent = errorText(err); e.target.disabled = false; e.target.textContent = 'Save marks'; }
      });
    }

    function renderCompEditor() {
      const box = $('#comp-ed', el);
      const sum = comps.reduce((a, c) => a + (Number(c.weight) || 0), 0);
      box.innerHTML = `<div style="overflow-x:auto"><table class="comp-editor"><thead><tr><th>Name</th><th>Type</th><th>Weight %</th><th>Out of</th><th></th></tr></thead><tbody>
        ${comps.map((c, i) => `<tr data-i="${i}"><td><input type="text" data-k="name" value="${esc(c.name)}" aria-label="Component ${i + 1} name" style="min-width:160px"></td>
          <td><select data-k="category" aria-label="Component ${i + 1} type"><option value="internal" ${c.category === 'internal' ? 'selected' : ''}>Internal</option><option value="external" ${c.category === 'external' ? 'selected' : ''}>External</option></select></td>
          <td><input type="number" data-k="weight" min="0" max="100" step="0.5" value="${c.weight}" aria-label="Component ${i + 1} weight" style="width:90px"></td>
          <td><input type="number" data-k="max_marks" min="1" step="0.5" value="${c.max_marks}" aria-label="Component ${i + 1} maximum marks" style="width:90px"></td>
          <td><button type="button" class="btn btn-danger btn-small" data-del="${i}" aria-label="Remove ${esc(c.name || 'component')}">${icon('trash', 14)}</button></td></tr>`).join('')}
        </tbody></table></div>
        <div class="row" style="margin:12px 0"><button type="button" class="btn btn-quiet btn-small" id="add-comp">${icon('plus', 14)} Add component</button>
          <span>Weights total: <span class="weight-sum ${Math.abs(sum - 100) < 0.001 ? 'is-ok' : 'is-bad'}">${round2(sum)} / 100</span>${Math.abs(sum - 100) < 0.001 ? '' : ' <span class="small" style="color:var(--bad)">— must equal 100</span>'}</span></div>
        <div class="field" style="max-width:320px"><label for="minext">Minimum external score to pass (%)<span class="hint">Students below this in the external part get F, whatever their total.</span></label>
          <input id="minext" type="number" min="0" max="100" value="${gb.course.min_external_pct}"></div>
        <div id="comp-err"></div>
        <button type="button" class="btn" id="save-comps">Save columns</button>`;
      box.oninput = e => {
        const tr = e.target.closest('tr[data-i]'); if (!tr) return;
        const c = comps[Number(tr.dataset.i)]; const k = e.target.dataset.k;
        c[k] = k === 'weight' || k === 'max_marks' ? Number(e.target.value) : e.target.value;
        if (k === 'weight') {
          const s2 = comps.reduce((a, x) => a + (Number(x.weight) || 0), 0);
          const ws = $('.weight-sum', box); ws.textContent = `${round2(s2)} / 100`; ws.className = `weight-sum ${Math.abs(s2 - 100) < 0.001 ? 'is-ok' : 'is-bad'}`;
        }
      };
      box.onchange = e => { if (e.target.dataset.k === 'category') comps[Number(e.target.closest('tr').dataset.i)].category = e.target.value; };
      box.onclick = async e => {
        const del = e.target.closest('[data-del]');
        if (del) {
          const c = comps[Number(del.dataset.del)];
          const hasMarks = c.id && gb.rows.some(r => r.parts.find(p => p.component_id === c.id)?.marks !== null);
          if (hasMarks && !(await confirmDialog({ title: `Remove “${c.name}”?`, body: '<p>Marks already entered in this column will be deleted when you save.</p>', confirm: 'Remove column', danger: true }))) return;
          comps.splice(Number(del.dataset.del), 1); renderCompEditor(); return;
        }
        if (e.target.closest('#add-comp')) { comps.push({ name: '', category: 'internal', weight: 0, max_marks: 10 }); renderCompEditor(); $$('input[data-k="name"]', box).pop().focus(); return; }
        if (e.target.closest('#save-comps')) {
          if (dirty.size && !(await confirmDialog({ title: 'Discard unsaved marks?', body: `<p>You have ${plural(dirty.size, 'unsaved mark')}. Saving the columns will discard them.</p>`, confirm: 'Discard and save columns', danger: true }))) return;
          try {
            gb = await api('PUT', `/api/courses/${course.id}/components`, { components: comps, min_external_pct: Number($('#minext', box).value) });
            comps = gb.components.map(c => ({ ...c })); reset(); editingCols = false; render(); toast('Columns saved');
          } catch (err) { $('#comp-err', box).innerHTML = errorBlock(err); }
        }
      };
    }
    render();
    const onUnload = e => { if (dirty.size) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);
    cleanup = () => window.removeEventListener('beforeunload', onUnload);
  }

  function renderMyMarks(el, gb) {
    const r = gb.rows[0];
    if (!gb.components.length || !r) {
      el.innerHTML = '<div class="empty"><h3>No marks yet</h3><p class="muted">Your teacher hasn\'t set up the gradebook for this course. Marks appear here as soon as they are entered.</p></div>';
      return;
    }
    const missingNames = gb.components.filter(c => r.parts.find(p => p.component_id === c.id).marks === null).map(c => c.name);
    el.innerHTML = `<div class="grid-2">
      <section class="panel" style="margin:0">
        <div class="row-between" style="align-items:flex-start">
          <div><div class="muted small">Total so far</div><div class="big-grade">${r.total}<span class="muted" style="font-size:1.25rem;font-weight:500"> / 100</span></div></div>
          <div style="text-align:right"><div class="muted small">Grade</div><div class="big-grade" style="${r.grade === 'F' ? 'color:var(--bad)' : ''}">${r.grade ?? '—'}</div>
          ${r.gradePoints !== null ? `<div class="small muted">${r.gradePoints} grade points</div>` : ''}</div></div>
        ${r.complete ? (r.result === 'pass' ? notice('ok', `<p>You have passed this course with grade ${r.grade}.</p>`) : notice('bad', `<p>${esc(r.reason || 'Your total is below the 40 needed to pass.')} Speak to your teacher about the supplementary exam.</p>`))
          : notice('info', `<p>Your final grade appears once every mark is in. Still waiting for: ${missingNames.map(esc).join(', ')}.</p>`)}
        <p class="small muted" style="margin:0">Internal ${r.internal} / ${r.internalWeight} · External ${r.external} / ${r.externalWeight}. To pass you need 40 overall and at least ${gb.course.min_external_pct}% of the external marks.</p>
      </section>
      <section class="panel" style="margin:0"><h3>Breakdown</h3><ul class="breakdown">
        ${gb.components.map(c => { const p = r.parts.find(x => x.component_id === c.id); return `<li>
          <div><strong>${esc(c.name)}</strong><div class="small muted">${c.category === 'internal' ? 'Internal' : 'External'} · worth ${c.weight}%${p.source === 'exam' ? ' · from online exam' : ''}</div></div>
          <span>${p.marks === null ? '<span class="muted">Not yet marked</span>' : `${fmtNum(p.marks)} / ${c.max_marks}`}</span>
          <span class="contrib small muted">${p.contribution === null ? '' : `+${p.contribution}`}</span></li>`; }).join('')}
      </ul></section></div>`;
  }

  route();
})();
