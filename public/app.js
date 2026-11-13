'use strict';
/* Pathwise — HR training LMS client. Plain JavaScript, no build step. */
(() => {
  const $app = document.getElementById('app');
  const $live = document.getElementById('live');
  const state = { user: null, config: null };
  const sim = { offline: false }; // demo tool on the quiz page: pretend the WiFi dropped
  let cleanup = null;

  // ---------------- utilities ----------------
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const DAY = 86400000;
  const fmtDate = ms => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
  const fmtTime = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  function dueText(ms, now = Date.now()) {
    const d = Math.round((ms - now) / DAY);
    if (d < 0) return `<span class="due-bad">${d === -1 ? '1 day' : `${-d} days`} overdue</span>`;
    if (d === 0) return '<span class="due-soon">due today</span>';
    if (d <= 7) return `<span class="due-soon">due in ${plural(d, 'day')}</span>`;
    return `due ${fmtDate(ms)}`;
  }
  const announce = m => { $live.textContent = ''; setTimeout(() => { $live.textContent = m; }, 50); };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const ICON = {
    check: '<path d="M20 6 9 17l-5-5"/>', alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>', download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>', plus: '<path d="M12 5v14M5 12h14"/>', trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
    award: '<circle cx="12" cy="8" r="6"/><path d="M15.5 13.5 17 22l-5-3-5 3 1.5-8.5"/>', lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  };
  const icon = (n, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
  const notice = (k, html) => `<div class="notice notice-${k}" role="${k === 'bad' ? 'alert' : 'status'}">${icon({ ok: 'check', warn: 'alert', bad: 'alert', info: 'info' }[k])}<div>${html}</div></div>`;
  const LOGO = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#4b2a63"/><path d="M8 23c4-1 6-4 8-8s4-6 8-7" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><circle cx="24" cy="8" r="2.6" fill="#f3c45a"/></svg>`;
  const STATUS = { completed: 'Completed', expiring: 'Expiring soon', expired: 'Expired', overdue: 'Overdue', in_progress: 'In progress', not_started: 'Not started' };
  const STATUS_ORDER = ['completed', 'expiring', 'in_progress', 'not_started', 'expired', 'overdue'];
  const chip = s => `<span class="chip st-${s}">${STATUS[s]}</span>`;
  const ROLE = { hr_admin: 'HR admin', manager: 'Manager', employee: 'Employee' };
  const loading = (t = 'Loading…') => `<div class="loading"><span class="spinner"></span>${esc(t)}</div>`;
  // Lesson text: blank line = new paragraph; lines starting with • or - become a list.
  function renderText(t) {
    return String(t || '').split(/\n{2,}/).map(block => {
      const lines = block.split('\n');
      if (lines.every(l => /^\s*[•\-]\s+/.test(l))) return `<ul>${lines.map(l => `<li>${esc(l.replace(/^\s*[•\-]\s+/, ''))}</li>`).join('')}</ul>`;
      return `<p>${lines.map(esc).join('<br>')}</p>`;
    }).join('');
  }
  function segbar(c, tall = false) {
    const total = STATUS_ORDER.reduce((a, k) => a + (c[k] || 0), 0);
    if (!total) return '<div class="segbar"></div>';
    const label = STATUS_ORDER.filter(k => c[k]).map(k => `${STATUS[k]}: ${c[k]}`).join(', ');
    return `<div class="segbar ${tall ? 'tall' : ''}" role="img" aria-label="${esc(label)}">${STATUS_ORDER.filter(k => c[k]).map(k =>
      `<span class="seg-${k}" style="flex:${c[k]}" title="${STATUS[k]}: ${c[k]}">${tall && c[k] / total > 0.06 ? c[k] : ''}</span>`).join('')}</div>`;
  }
  const legend = () => `<ul class="legend">${STATUS_ORDER.map(k => `<li><i class="seg-${k}"></i>${STATUS[k]}</li>`).join('')}</ul>`;

  function toast(msg) { $$('.toast').forEach(t => t.remove()); const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3800); }
  function dialog({ title, body, confirm = 'Confirm', cancel = 'Cancel', danger = false, onOpen }) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const w = document.createElement('div');
      w.className = 'modal-backdrop';
      w.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-t"><h2 id="m-t">${esc(title)}</h2><div class="m-body">${body}</div>
        <div class="actions"><button class="btn btn-quiet" data-v="0">${esc(cancel)}</button><button class="btn ${danger ? 'btn-danger' : ''}" data-v="1">${esc(confirm)}</button></div></div>`;
      const close = v => { w.remove(); document.removeEventListener('keydown', onKey); prev?.focus?.(); resolve(v ? (w.__value ?? true) : false); };
      const onKey = e => {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Tab') { const f = $$('button, input, select, textarea, a[href]', w).filter(x => !x.disabled); const i = f.indexOf(document.activeElement);
          if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); } }
      };
      w.addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) { if (b.dataset.v === '1' && w.__validate && !w.__validate()) return; close(b.dataset.v === '1'); } else if (e.target === w) close(false); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(w);
      onOpen?.(w);
      ($('input, select', w) || $('button[data-v="1"]', w)).focus();
    });
  }

  // ---------------- API ----------------
  class ApiError extends Error { constructor(s, m, d) { super(m); this.status = s; this.data = d; } }
  const isNet = e => !(e instanceof ApiError);
  async function api(method, url, body) {
    if (sim.offline && url.startsWith('/api/attempts')) throw new TypeError('Simulated WiFi drop');
    const o = { method, credentials: 'same-origin', headers: {} };
    if (method !== 'GET') { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body ?? {}); }
    const res = await fetch(url, o);
    let data = null; try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && url !== '/api/login' && !url.startsWith('/api/certificates')) { state.user = null; if (!location.hash.startsWith('#/login')) go('#/login'); }
    if (!res.ok) throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`, data);
    return data;
  }
  const errText = e => (isNet(e) ? 'Couldn\'t reach Pathwise. Check your connection and try again.' : e.message);
  const errBlock = e => notice('bad', `<p>${esc(errText(e))}</p>${e?.data?.problems?.length > 1 ? `<ul>${e.data.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}`);

  // ---------------- shell & router ----------------
  function go(h) { if (location.hash === h) route(); else location.hash = h; }
  // HR lands on the compliance dashboard; everyone else on their own training.
  const homeFor = u => (u.role === 'hr_admin' ? '#/compliance' : '#/');
  function shell(content, active = '') {
    const u = state.user;
    const links = [['#/', 'My learning', 'my']];
    if (u.role === 'manager') links.push(['#/people', 'My team', 'people'], ['#/compliance', 'Compliance', 'compliance'], ['#/courses', 'Courses', 'courses']);
    if (u.role === 'hr_admin') links.push(['#/compliance', 'Compliance', 'compliance'], ['#/people', 'People', 'people'], ['#/courses', 'Courses', 'courses'], ['#/import', 'Import', 'import']);
    $app.innerHTML = `<header class="topbar"><div class="topbar-inner">
        <a class="brand" href="#/">${LOGO}<span>Pathwise</span></a>
        <nav class="nav" aria-label="Main">${links.map(([h, l, k]) => `<a href="${h}" ${k === active ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
        <div class="whoami"><span><strong>${esc(u.name)}</strong> <span class="role">· ${ROLE[u.role]}${u.department ? ' · ' + esc(u.department) : ''}</span></span><button type="button" id="logout">Sign out</button></div>
      </div></header><main id="main" tabindex="-1">${content}</main>`;
    $('#logout').onclick = async () => {
      try { await api('POST', '/api/logout'); } catch { /* signing out locally anyway */ }
      try { const cfg = state.config || (state.config = await api('GET', '/api/config')); if (cfg.clerk) { const C = await loadClerk(cfg.clerk); if (C.isSignedIn) await C.signOut(); } } catch { /* app session already ended */ }
      state.user = null; go('#/login');
    };
    return $('#main');
  }
  const ROUTES = [
    [/^#\/login$/, viewLogin, 'public'],
    [/^#\/certificate\/([A-Za-z0-9\-]+)$/, viewCertificate, 'public'],
    [/^#\/verify$/, viewVerify, 'public'],
    [/^#\/?$/, viewMy],
    [/^#\/learn\/(\d+)(?:\/(\d+|quiz))?$/, viewLearn],
    [/^#\/quiz\/(\d+)$/, viewQuiz],
    [/^#\/compliance$/, viewCompliance, 'leads'],
    [/^#\/people$/, viewPeople, 'leads'],
    [/^#\/people\/(\d+)$/, viewPerson, 'leads'],
    [/^#\/courses$/, viewCourses, 'leads'],
    [/^#\/courses\/new$/, () => viewCourseEdit(null), 'hr'],
    [/^#\/courses\/(\d+)\/edit$/, viewCourseEdit, 'hr'],
    [/^#\/courses\/(\d+)$/, viewCourse, 'leads'],
    [/^#\/import$/, viewImport, 'hr'],
  ];
  async function route() {
    if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
    $$('.toast, .modal-backdrop').forEach(t => t.remove());
    const hash = location.hash || '#/';
    const r = ROUTES.map(([re, fn, who]) => ({ m: hash.match(re), fn, who })).find(x => x.m);
    if (!r) { go('#/'); return; }
    if (r.who !== 'public' && !state.user) {
      try { state.user = (await api('GET', '/api/me')).user; }
      catch (e) { if (isNet(e) && /^#\/quiz\//.test(hash)) state.user = { name: 'Offline', role: 'employee' }; else { go('#/login'); return; } }
    }
    if (r.who === 'leads' && !['hr_admin', 'manager'].includes(state.user.role)) { go('#/'); return; }
    if (r.who === 'hr' && state.user.role !== 'hr_admin') { go('#/'); return; }
    try { await r.fn(...r.m.slice(1)); }
    catch (e) { console.error(e); const main = state.user ? shell('') : $app; main.innerHTML = errBlock(e) + '<p><a href="#/">Go to My learning</a></p>'; }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  // ---------------- sign-in (Clerk + password) ----------------
  let clerkReady = null;
  function loadClerk(cfg) {
    if (clerkReady) return clerkReady;
    const add = (src, attrs = {}) => new Promise((ok, bad) => { const s = document.createElement('script'); s.src = src; s.async = true; s.crossOrigin = 'anonymous';
      Object.entries(attrs).forEach(([k, v]) => s.setAttribute(k, v)); s.onload = ok; s.onerror = () => bad(new Error('Couldn\'t load the sign-in service. Check your connection, or turn off any ad blocker for this site.')); document.head.appendChild(s); });
    clerkReady = Promise.race([(async () => {
      const base = `https://${cfg.frontendApi}/npm`;
      await add(`${base}/@clerk/ui@1/dist/ui.browser.js`);
      await add(`${base}/@clerk/clerk-js@6/dist/clerk.browser.js`, { 'data-clerk-publishable-key': cfg.publishableKey });
      await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } });
      return window.Clerk;
    })(), new Promise((_, bad) => setTimeout(() => bad(new Error('The sign-in service is taking too long to load. Check your connection and reload the page.')), 20000))]);
    clerkReady.catch(() => { clerkReady = null; });
    return clerkReady;
  }
  const CLERK_LOOK = { variables: { colorPrimary: '#4b2a63', colorText: '#1d1b26', colorTextSecondary: '#5b5869', colorDanger: '#a3261f', borderRadius: '4px', fontFamily: 'inherit', fontSize: '15px' },
    elements: { card: { boxShadow: 'none', border: '1px solid #dcdae3' }, rootBox: { width: '100%' }, cardBox: { width: '100%', boxShadow: 'none' } } };
  const DEMO_ROLE_LABEL = { employee: 'An employee', manager: 'A manager', hr_admin: 'HR' };

  async function viewLogin() {
    if (state.user) { go(homeFor(state.user)); return; }
    let cfg = { passwordLogin: true, clerk: null, demoMode: false };
    try { cfg = state.config = await api('GET', '/api/config'); } catch { /* password sign-in */ }
    const pwForm = `<form id="pw-form" novalidate>
      <div class="field"><label for="email">Work email</label><input id="email" type="email" autocomplete="username"></div>
      <div class="field"><label for="password">Password <span class="hint">First sign-in: your employee ID, e.g. MS-101.</span></label><input id="password" type="password" autocomplete="current-password"></div>
      <button class="btn ${cfg.clerk ? 'btn-quiet' : ''}" type="submit" style="width:100%">Sign in with password</button></form>`;
    const showDemo = cfg.passwordLogin && (cfg.demoMode || !cfg.clerk);
    $app.innerHTML = `<div class="login">
      <section class="login-side"><div>
        <div class="brand" style="margin-bottom:48px">${LOGO}<span>Pathwise</span></div>
        <h1>Training your people actually finish.</h1>
        <p>Assign courses by team, keep certificates current, and see who's compliant before the auditor asks.</p></div>
        <ul><li>Bring staff in from your HR system's export; training is assigned automatically.</li>
        <li>Short lessons, a quiz, and a certificate anyone can verify.</li>
        <li>One view of who's overdue, by course, team and manager.</li></ul>
      </section>
      <section class="login-main">
        <h2>Sign in</h2><div id="login-error"></div>
        ${cfg.clerkError ? notice('warn', `<p><strong>Work-account sign-in isn't set up correctly:</strong> ${esc(cfg.clerkError)}</p>`) : ''}
        ${cfg.clerk ? '<p class="muted small">Use your work email.</p><div id="clerk-box" class="clerk-box">' + loading('Loading sign-in…') + '</div>' : ''}
        ${cfg.passwordLogin ? (cfg.clerk ? `<details class="pw-details"><summary>Sign in with a password instead</summary><div style="margin-top:12px">${pwForm}</div></details>` : pwForm) : ''}
        ${cfg.demoMode ? notice('info', '<p><strong>This is a demo site</strong> for a made-up company, Mandovi Systems. Anything you change may reset after a few minutes without use.</p>') : ''}
        ${showDemo ? `<div class="demo-accounts"><p class="muted">Demo accounts — select one to sign in:</p>
          <button type="button" data-e="neha.kerkar@mandovi.example" data-p="hr12345"><strong>Neha Kerkar</strong> · HR admin</button>
          <button type="button" data-e="rahul.desai@mandovi.example" data-p="manager123"><strong>Rahul Desai</strong> · Engineering manager, 4 reports</button>
          <button type="button" data-e="arjun.naik@mandovi.example" data-p="MS-101"><strong>Arjun Naik</strong> · new joiner, Engineering</button></div>` : ''}
        <p class="small muted" style="margin-top:24px"><a href="#/verify">Check a certificate</a></p>
      </section></div>`;
    const submit = async (email, password, btn) => {
      if (!email || !password) { $('#login-error').innerHTML = notice('bad', '<p>Enter your work email and password.</p>'); return; }
      const label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Signing in…';
      try { state.user = (await api('POST', '/api/login', { email, password })).user; go(homeFor(state.user)); }
      catch (e) { $('#login-error').innerHTML = errBlock(e); btn.disabled = false; btn.innerHTML = label; }
    };
    const f = $('#pw-form');
    if (f) f.onsubmit = e => { e.preventDefault(); submit($('#email').value.trim(), $('#password').value, $('button[type=submit]', f)); };
    $$('.demo-accounts button').forEach(b => b.onclick = () => submit(b.dataset.e, b.dataset.p, b));
    if (!cfg.clerk) { $('#email')?.focus(); return; }

    const box = $('#clerk-box');
    let Clerk, busy = false;
    async function exchange(demoRole) {
      if (busy || !Clerk?.session) return;
      busy = true; box.innerHTML = loading('Signing you in…');
      try {
        const r = await api('POST', '/api/auth/clerk', { token: await Clerk.session.getToken(), demoRole });
        state.user = r.user; go(homeFor(r.user));
        if (r.asDemo) setTimeout(() => toast(`Exploring as ${r.user.name} (demo). You're signed in as ${r.clerkEmail}.`), 300);
      } catch (e) {
        busy = false;
        if (e instanceof ApiError && e.data?.code === 'not_on_roster') {
          const roles = e.data.demoRoles || [];
          box.innerHTML = notice('warn', `<p>${esc(e.message)}</p>`) + (roles.length ? `<p class="small muted" style="margin-bottom:8px">On this demo site you can look around as:</p>
            <div class="row" style="margin-bottom:12px">${roles.map((r, i) => `<button type="button" class="btn btn-small ${i ? 'btn-quiet' : ''}" data-role="${r}">${DEMO_ROLE_LABEL[r]}</button>`).join('')}</div>` : '') +
            '<button type="button" class="link-btn" id="switch">Sign in with a different account</button>';
          $$('[data-role]', box).forEach(b => b.onclick = () => exchange(b.dataset.role));
        } else {
          box.innerHTML = errBlock(e) + '<button type="button" class="btn btn-quiet" id="retry">Try again</button> <button type="button" class="link-btn" id="switch">Use a different account</button>';
          $('#retry').onclick = () => exchange(demoRole);
        }
        $('#switch').onclick = async () => { box.innerHTML = loading('Signing out…'); try { await Clerk.signOut(); } catch { /* ignore */ } mount(); };
      }
    }
    function mount() { box.innerHTML = '<div id="clerk-signin"></div>'; Clerk.mountSignIn($('#clerk-signin'), { routing: 'virtual', appearance: CLERK_LOOK }); }
    try {
      Clerk = await loadClerk(cfg.clerk);
      if (!box.isConnected) return;
      Clerk.addListener(({ session }) => { if (session && box.isConnected && location.hash.startsWith('#/login')) exchange(); });
      if (Clerk.isSignedIn) exchange(); else mount();
    } catch (e) { box.innerHTML = notice('bad', `<p>${esc(e.message)}</p>`) + (cfg.passwordLogin ? '<p class="small muted">You can still sign in with a password below.</p>' : ''); }
  }

  // ---------------- My learning ----------------
  async function viewMy() {
    const main = shell(loading('Loading your training…'), 'my');
    const { assignments, certificates, serverNow } = await api('GET', '/api/my');
    const urgency = { overdue: 0, expired: 1, in_progress: 2, not_started: 3, expiring: 4, completed: 5 };
    const todo = assignments.filter(a => !['completed'].includes(a.status)).sort((a, b) => urgency[a.status] - urgency[b.status] || a.effective_due - b.effective_due);
    const done = assignments.filter(a => a.status === 'completed');
    const first = state.user.name.split(' ')[0];
    const late = todo.filter(a => a.status === 'overdue' || a.status === 'expired').length;
    const action = a => ({ not_started: 'Start', in_progress: 'Continue', overdue: a.lessons_done ? 'Continue' : 'Start', expired: 'Retake', expiring: 'Renew early' })[a.status] || 'Open';
    main.innerHTML = `<div class="page-head"><h1>${todo.length ? `${esc(first)}, you have ${plural(todo.filter(a => a.status !== 'expiring').length, 'course')} to do` : `You're all caught up, ${esc(first)}`}</h1>
      <p>${late ? `<strong class="due-bad">${plural(late, 'course is', 'courses are')} past ${late === 1 ? 'its' : 'their'} deadline.</strong> ` : ''}Training assigned to you by HR and your manager.</p></div>
      ${todo.length ? `<ul class="list" style="margin-bottom:32px">${todo.map(a => `<li>
          <div class="grow"><a class="title" href="#/learn/${a.course_id}">${esc(a.title)}</a>
          <div class="meta"><span class="tag">${esc(a.category)}</span> ${a.status === 'expiring' ? `certificate expires ${fmtDate(a.cert_expires)}` : a.status === 'expired' ? `certificate expired ${fmtDate(a.cert_expires)} — ${dueText(a.effective_due, serverNow)}` : dueText(a.effective_due, serverNow)}</div></div>
          <div title="${a.lessons_done} of ${a.lessons_total} lessons"><div class="progress"><span style="width:${a.lessons_total ? (a.lessons_done / a.lessons_total) * 100 : 0}%"></span></div><div class="meta">${a.lessons_done}/${a.lessons_total} lessons</div></div>
          ${chip(a.status)}
          <a class="btn btn-small ${a.status === 'expiring' ? 'btn-quiet' : ''}" href="#/learn/${a.course_id}">${action(a)}</a></li>`).join('')}</ul>`
        : `<div class="empty" style="margin-bottom:32px"><h3>Nothing to do right now</h3><p class="muted">When HR or your manager assigns training, it shows up here with its deadline.</p></div>`}
      <h2>Completed</h2>
      ${done.length ? `<ul class="list" style="margin-bottom:32px">${done.map(a => `<li><div class="grow"><a class="title" href="#/learn/${a.course_id}">${esc(a.title)}</a>
          <div class="meta">Passed ${fmtDate(a.cert_issued)}${a.cert_expires ? ` · valid until ${fmtDate(a.cert_expires)}` : ' · never expires'}</div></div>
          ${chip('completed')}<a class="btn btn-quiet btn-small" href="#/certificate/${esc(a.cert_code)}">${icon('award', 14)} Certificate</a></li>`).join('')}</ul>`
        : '<p class="muted">Courses you pass will be listed here with their certificates.</p>'}
      ${certificates.length > done.length ? `<details><summary class="small muted" style="cursor:pointer">All certificates ever issued to you (${certificates.length})</summary>
        <ul class="list" style="margin-top:12px">${certificates.map(c => `<li><div class="grow">${esc(c.title)}<div class="meta">${fmtDate(c.issued_at)} · ${esc(c.code)}</div></div>
        <a href="#/certificate/${esc(c.code)}" class="small">View</a></li>`).join('')}</ul></details>` : ''}`;
  }

  // ---------------- course player ----------------
  async function viewLearn(courseId, step) {
    const main = shell(loading(), 'my');
    const s = await api('GET', `/api/learn/${courseId}`);
    const lessons = s.lessons;
    const firstOpen = lessons.findIndex(l => !l.done);
    const idx = step === 'quiz' ? 'quiz' : step ? Math.min(Number(step), lessons.length) - 1 : (firstOpen === -1 ? 'quiz' : firstOpen);
    const c = s.course;
    const doneCount = lessons.filter(l => l.done).length;
    const steps = lessons.map((l, i) => `<li class="${l.done ? 'done' : ''}"><a href="#/learn/${c.id}/${i + 1}" ${idx === i ? 'aria-current="step"' : ''}>
        <span class="dot">${l.done ? '✓' : i + 1}</span><span>${esc(l.title)}${l.done ? '<span class="visually-hidden"> (done)</span>' : ''}</span></a></li>`).join('') +
      `<li class="${s.certificate?.valid ? 'done' : ''}">${s.quiz.unlocked ? `<a href="#/learn/${c.id}/quiz" ${idx === 'quiz' ? 'aria-current="step"' : ''}>` : '<span class="locked" title="Finish the lessons first">'}
        <span class="dot">${s.certificate?.valid ? '✓' : s.quiz.unlocked ? 'Q' : icon('lock', 12)}</span><span>Quiz${s.quiz.unlocked ? '' : ' — opens after the lessons'}</span>${s.quiz.unlocked ? '</a>' : '</span>'}</li>`;
    let content;
    if (idx === 'quiz') {
      const q = s.quiz, cert = s.certificate;
      content = `<div class="lesson"><h2>Quiz</h2>
        ${cert?.valid && s.status !== 'expiring' ? notice('ok', `<p><strong>You passed with ${cert.score_pct}%.</strong> ${cert.expires_at ? `Your certificate is valid until ${fmtDate(cert.expires_at)}.` : 'Your certificate never expires.'}</p>`) + `<a class="btn" href="#/certificate/${esc(cert.code)}">${icon('award')} View certificate</a>`
          : `${s.status === 'expiring' ? notice('info', `<p>Your certificate expires on <strong>${fmtDate(cert.expires_at)}</strong>. Pass the quiz again to renew it now.</p>`) : ''}
          ${s.status === 'expired' ? notice('warn', `<p>Your certificate expired on ${fmtDate(cert.expires_at)}. Pass the quiz again to renew it.</p>`) : ''}
          <ul style="padding-left:1.1em"><li>${plural(q.questions, 'question')}, multiple choice. You need <strong>${c.pass_mark}%</strong> to pass.</li>
          <li>${q.attemptsLeft === null ? 'You can retake it as many times as you need.' : `You have <strong>${plural(q.attemptsLeft, 'attempt')}</strong> left.`}</li>
          <li>Answers save as you go, so you can close the page and come back.</li>
          <li>Passing gives you a certificate${c.validity_months ? ` valid for ${plural(c.validity_months, 'month')}` : ''}.</li></ul>
          ${q.last && !q.last.passed ? notice('warn', `<p>Last attempt: ${q.last.score_pct}% (pass mark ${c.pass_mark}%).</p>`) : ''}
          ${q.canTake || q.openAttemptId ? `<a class="btn" href="#/quiz/${c.id}">${q.openAttemptId ? 'Resume quiz' : q.last ? 'Retake quiz' : 'Start quiz'}</a>`
            : q.attemptsLeft === 0 ? notice('bad', '<p>You\'ve used all your attempts. Ask HR to give you another go — they can reset it from your profile.</p>') : ''}`}</div>`;
    } else {
      const l = lessons[idx];
      const last = idx === lessons.length - 1;
      content = `<article class="lesson"><p class="small muted">Lesson ${idx + 1} of ${lessons.length}</p><h2>${esc(l.title)}</h2>
        ${l.video_url ? `<p><a href="${esc(l.video_url)}" target="_blank" rel="noopener">Watch the video for this lesson ↗</a></p>` : ''}
        <div class="lesson-body">${renderText(l.body)}</div>
        <div class="between" style="margin-top:32px;padding-top:20px;border-top:1px solid var(--line)">
          ${idx > 0 ? `<a href="#/learn/${c.id}/${idx}">Previous lesson</a>` : '<span></span>'}
          <button class="btn" id="next">${l.done ? (last ? 'Go to the quiz' : 'Next lesson') : (last ? 'Mark as done and go to the quiz' : 'Mark as done and continue')}</button></div></article>`;
    }
    main.innerHTML = `<div class="crumbs"><a href="#/">My learning</a></div>
      <div class="page-head"><h1>${esc(c.title)}</h1><p>${chip(s.status)} &nbsp;${doneCount}/${lessons.length} lessons · ${s.status === 'completed' || s.status === 'expiring' ? `certificate valid until ${fmtDate(s.certificate.expires_at) === '—' ? 'forever' : fmtDate(s.certificate.expires_at)}` : dueText(s.due_at, s.serverNow)}</p></div>
      <div class="player"><nav aria-label="Course steps"><ol class="steps">${steps}</ol></nav><div>${content}</div></div>`;
    $('#next')?.addEventListener('click', async e => {
      const l = lessons[idx]; e.target.disabled = true;
      try {
        if (!l.done) await api('POST', `/api/learn/${c.id}/lessons/${l.id}/complete`);
        go(idx === lessons.length - 1 ? `#/learn/${c.id}/quiz` : `#/learn/${c.id}/${idx + 2}`);
      } catch (err) { e.target.disabled = false; toast(errText(err)); }
    });
  }

  // ---------------- quiz runner (autosave, offline-safe) ----------------
  async function viewQuiz(courseId) {
    $app.innerHTML = loading('Opening the quiz…');
    const cacheKey = `pw-quiz-${courseId}`;
    let d, fromCache = false;
    try { d = await api('POST', `/api/learn/${courseId}/attempts`); store.set(cacheKey, d); }
    catch (e) { const c = store.get(cacheKey); if (isNet(e) && c) { d = c; fromCache = true; } else { const m = shell('', 'my'); m.innerHTML = errBlock(e) + `<p><a href="#/learn/${courseId}/quiz">Back to the course</a></p>`; return; } }
    const at = d.attempt, qs = d.questions, localKey = `pw-attempt-${at.id}`;
    let answers = { ...at.answers }, seq = at.save_seq, ack = at.save_seq, inflight = false, offline = fromCache, nextTry = 0, backoff = 0, savedAt = null, submitting = false;
    const local = store.get(localKey);
    if (local && local.seq > seq) { answers = local.answers; seq = local.seq; }
    const persist = () => store.set(localKey, { seq, answers });

    $app.innerHTML = `<div class="quizbar"><div><span class="q-title">${esc(d.course.title)} — quiz</span><span id="count" class="small"></span>
        <span class="save" id="save" role="status"><i></i><span id="save-t">Saved</span></span></div></div>
      <main id="main" tabindex="-1"><div class="quiz">
        <p class="small muted">${plural(qs.length, 'question')} · pass mark ${d.pass_mark}% · answers save automatically</p>
        <form id="qf" novalidate>${qs.map((q, i) => `<div class="question"><fieldset><legend><span class="qn">${i + 1}.</span><span>${esc(q.prompt)}</span></legend>
          ${q.options.map((o, j) => `<label class="option"><input type="radio" name="q${q.id}" value="${j}" ${answers[q.id] === j ? 'checked' : ''}><span>${esc(o)}</span></label>`).join('')}</fieldset></div>`).join('')}</form>
        <div id="submit-msg"></div>
        <div class="between" style="margin:24px 0"><a href="#/learn/${courseId}/quiz">Save and leave</a><button class="btn" id="submit">Submit answers</button></div>
        <div class="small muted" style="border:1px dashed var(--line-2);border-radius:6px;padding:12px 16px">Demo tool: <button type="button" class="link-btn" id="sim">${sim.offline ? 'Reconnect WiFi' : 'Simulate a WiFi drop'}</button> — answers keep saving on this device and sync when you reconnect.</div>
      </div></main>`;
    const $save = $('#save'), $t = $('#save-t');
    const answered = () => qs.filter(q => answers[q.id] !== undefined).length;
    function render() {
      if (!$save.isConnected) return;
      $('#count').textContent = `${answered()}/${qs.length}`;
      $save.className = 'save';
      if (offline) { $save.classList.add('offline'); $t.textContent = seq > ack ? 'Offline · kept on device' : 'Offline'; }
      else if (seq > ack || inflight) { $save.classList.add('saving'); $t.textContent = 'Saving…'; }
      else $t.textContent = savedAt ? `Saved ${fmtTime(savedAt)}` : 'Saved';
    }
    async function flush() {
      if (inflight || seq <= ack || submitting) return;
      inflight = true; const sending = seq, payload = { ...answers }; render();
      try { const r = await api('PUT', `/api/attempts/${at.id}/answers`, { answers: payload, seq: sending }); ack = Math.max(ack, r.seq); savedAt = Date.now(); if (offline) announce('Back online. Answers saved.'); offline = false; backoff = 0; }
      catch (e) {
        if (isNet(e)) { if (!offline) announce('Connection lost. Answers are kept on this device.'); offline = true; backoff = Math.min(backoff ? backoff * 2 : 2000, 15000); nextTry = Date.now() + backoff; }
        else if (e.data?.code === 'submitted') { store.del(localKey); go(`#/learn/${courseId}/quiz`); }
      } finally { inflight = false; render(); }
    }
    $('#qf').addEventListener('change', e => {
      if (e.target.type !== 'radio' || submitting) return;
      answers[e.target.name.slice(1)] = Number(e.target.value); seq++; persist();
      if (!offline) nextTry = Date.now() + 150;
      $('#submit-msg').innerHTML = ''; render();
    });
    const tick = setInterval(() => { if (seq > ack && !inflight && Date.now() >= nextTry) flush(); }, 300);
    const onOnline = () => { if (sim.offline) return; offline = false; nextTry = 0; flush(); render(); };
    const onOffline = () => { offline = true; render(); };
    const onUnload = e => { if (seq > ack) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline); window.addEventListener('beforeunload', onUnload);
    cleanup = () => { clearInterval(tick); window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); window.removeEventListener('beforeunload', onUnload); };
    $('#sim').onclick = () => { sim.offline = !sim.offline; $('#sim').textContent = sim.offline ? 'Reconnect WiFi' : 'Simulate a WiFi drop'; sim.offline ? onOffline() : onOnline(); };
    render();

    $('#submit').onclick = async () => {
      const left = qs.length - answered();
      if (left) {
        $('#submit-msg').innerHTML = notice('warn', `<p>${plural(left, 'question is', 'questions are')} unanswered: ${qs.map((q, i) => answers[q.id] === undefined ? `<a href="#" data-jump="${q.id}">${i + 1}</a>` : null).filter(Boolean).join(', ')}. Answer ${left === 1 ? 'it' : 'them'} before submitting.</p>`);
        $$('[data-jump]').forEach(a => a.onclick = ev => { ev.preventDefault(); $(`input[name="q${a.dataset.jump}"]`).focus(); });
        return;
      }
      if (!(await dialog({ title: 'Submit your answers?', body: `<p>You need ${d.pass_mark}% to pass. You can't change answers after submitting.</p>`, confirm: 'Submit', cancel: 'Keep checking' }))) return;
      submitting = true; $('#submit').disabled = true; $('#submit').innerHTML = '<span class="spinner"></span> Submitting…';
      for (let n = 0; ; n++) {
        try {
          const r = await api('POST', `/api/attempts/${at.id}/submit`, { answers });
          store.del(localKey); store.del(cacheKey); cleanup(); cleanup = null;
          return showResult(r);
        } catch (e) {
          if (!isNet(e)) { submitting = false; $('#submit').disabled = false; $('#submit').textContent = 'Submit answers'; $('#submit-msg').innerHTML = errBlock(e); return; }
          $('#submit-msg').innerHTML = notice('warn', '<p>You\'re offline. Your answers are safe on this device — we\'ll submit as soon as the connection is back. Don\'t close this page.</p>');
          await new Promise(res => setTimeout(res, Math.min(2000 * (n + 1), 8000)));
        }
      }
    };
    function showResult(r) {
      const main = shell('', 'my');
      main.innerHTML = `<div class="quiz"><div class="crumbs"><a href="#/">My learning</a> / <a href="#/learn/${courseId}">${esc(d.course.title)}</a></div>
        <div class="panel"><div class="between" style="align-items:flex-end"><div><div class="small muted">Your score</div>
          <div class="result-score" style="color:${r.passed ? 'var(--st-completed)' : 'var(--st-overdue)'}">${r.score_pct}%</div><div class="small muted">Pass mark ${r.pass_mark}%</div></div>
          ${r.passed ? `<a class="btn" href="#/certificate/${esc(r.certificate.code)}">${icon('award')} View your certificate</a>` : (r.attemptsLeft === 0 ? '' : `<a class="btn" href="#/learn/${courseId}/1">Review the lessons</a>`)}</div>
          <div style="margin-top:20px">${r.passed ? notice('ok', `<p><strong>You passed.</strong> ${r.certificate.expires_at ? `Your certificate is valid until ${fmtDate(r.certificate.expires_at)}.` : 'Your certificate never expires.'}</p>`)
            : notice('warn', `<p><strong>Not this time.</strong> ${r.attemptsLeft === null ? 'Review the lessons and try again whenever you\'re ready.' : r.attemptsLeft ? `You have ${plural(r.attemptsLeft, 'attempt')} left. Review the lessons, then try again.` : 'You\'ve used all your attempts — HR can give you another go.'}</p>`)}</div></div>
        <h2>Your answers</h2>
        ${r.review.map((q, i) => `<div class="question"><p style="font-weight:600;margin-bottom:10px">${i + 1}. ${esc(q.prompt)} ${q.correct ? '<span class="chip st-completed">Right</span>' : '<span class="chip st-expired">Wrong</span>'}</p>
          ${q.options.map((o, j) => `<div class="option ${j === q.chosen ? (q.correct ? 'right' : 'wrong') : (r.passed && j === q.answer ? 'right' : '')}" style="cursor:default">${esc(o)}${j === q.chosen ? ' <span class="small muted">— your answer</span>' : ''}${r.passed && j === q.answer && j !== q.chosen ? ' <span class="small muted">— correct answer</span>' : ''}</div>`).join('')}</div>`).join('')}
        ${r.passed ? '' : '<p class="small muted">Correct answers are shown once you pass, so a retake still checks what you know.</p>'}</div>`;
    }
  }

  // ---------------- certificate (public) ----------------
  async function viewCertificate(code) {
    const host = state.user ? shell(loading(), 'my') : ($app.innerHTML = `<main id="main">${loading()}</main>`, $('#main'));
    let c;
    try { c = (await api('GET', `/api/certificates/${encodeURIComponent(code)}`)).certificate; }
    catch (e) { host.innerHTML = `<div class="cert-wrap">${errBlock(e)}<p><a href="#/verify">Check another code</a></p></div>`; return; }
    host.innerHTML = `<div class="cert-wrap">
      <div class="between no-print" style="margin-bottom:16px">${state.user ? '<a href="#/">My learning</a>' : '<a href="#/verify">Check another certificate</a>'}
        <button class="btn btn-quiet btn-small" onclick="window.print()">${icon('print', 14)} Print or save as PDF</button></div>
      ${c.valid ? '' : notice('bad', `<p><strong>This certificate expired on ${fmtDate(c.expires_at)}.</strong> It is genuine, but no longer current.</p>`)}
      <div class="certificate ${c.valid ? '' : 'cert-invalid'}"><div class="frame">
        <div class="org">${LOGO}<span>Mandovi Systems · Pathwise</span></div>
        <p class="lead">This certifies that</p><p class="name">${esc(c.name)}</p>
        <p class="lead">has successfully completed</p><p class="course">${esc(c.title || c.course)}</p>
        <p class="lead" style="font-size:1rem">with a score of ${c.score_pct}%</p>
        <div class="facts"><div>Issued<strong>${fmtDate(c.issued_at)}</strong></div><div>Valid until<strong>${c.expires_at ? fmtDate(c.expires_at) : 'No expiry'}</strong></div>
          <div>Certificate code<strong class="stamp">${esc(c.code)}</strong></div></div>
      </div></div>
      <p class="small muted no-print" style="margin-top:12px">Anyone can confirm this certificate at <strong>${esc(location.origin)}/#/verify</strong> using the code above.</p></div>`;
  }
  function viewVerify() {
    const host = state.user ? shell('', 'my') : ($app.innerHTML = `<header class="topbar"><div class="topbar-inner"><a class="brand" href="#/login">${LOGO}<span>Pathwise</span></a></div></header><main id="main"></main>`, $('#main'));
    host.innerHTML = `<div style="max-width:480px"><h1>Check a certificate</h1><p class="muted">Enter the code printed on the certificate, e.g. PW-7KQM-3XRT.</p>
      <form id="vf" class="row" novalidate><label for="code" class="visually-hidden">Certificate code</label><input id="code" type="text" autocomplete="off" style="flex:1;min-width:200px;text-transform:uppercase" placeholder="PW-XXXX-XXXX">
      <button class="btn" type="submit">Check</button></form><div id="vmsg" style="margin-top:12px"></div></div>`;
    $('#vf').onsubmit = e => { e.preventDefault(); const v = $('#code').value.trim().toUpperCase().replace(/\s+/g, ''); if (!v) { $('#vmsg').innerHTML = notice('bad', '<p>Type the code from the certificate.</p>'); return; } go(`#/certificate/${encodeURIComponent(v)}`); };
    $('#code').focus();
  }

  // ---------------- Feature 3: compliance dashboard ----------------
  async function viewCompliance() {
    const main = shell(loading('Working out who\'s compliant…'), 'compliance');
    const isHr = state.user.role === 'hr_admin';
    const [s, depts] = await Promise.all([api('GET', '/api/compliance/summary'), api('GET', '/api/departments')]);
    const t = s.totals;
    const f = { course: '', department: '', status: 'noncompliant', q: '' };
    main.innerHTML = `<div class="page-head"><h1>${isHr ? 'Compliance' : 'Your team\'s compliance'}</h1>
      <p>${isHr ? `Training status for all ${plural(s.people, 'person', 'people')} with assigned courses.` : `Training status for your ${plural(s.people, 'direct report')}.`} A course counts as compliant while the person holds a valid certificate.</p></div>
      ${!t.total ? '<div class="empty"><h3>No training assigned yet</h3><p class="muted">Once courses are assigned, you\'ll see who\'s done what here.</p></div>' : `
      <div class="grid-2" style="margin-bottom:24px;grid-template-columns:minmax(220px,1fr) 3fr">
        <div class="panel" style="margin:0"><div class="small muted">Compliant right now</div><div class="big-pct">${t.compliantPct}%</div>
          <div class="small muted">${t.compliant} of ${t.total} course assignments</div></div>
        <div class="stats" style="margin:0">
          <a class="stat bad" href="#" data-st="overdue"><span class="n">${t.overdue}</span><span class="l">overdue — never completed</span></a>
          <a class="stat bad" href="#" data-st="expired"><span class="n">${t.expired}</span><span class="l">expired certificates</span></a>
          <a class="stat warn" href="#" data-st="expiring"><span class="n">${t.expiring}</span><span class="l">expiring in 30 days</span></a>
          <a class="stat" href="#" data-st="in_progress"><span class="n">${t.in_progress}</span><span class="l">in progress</span></a>
          <a class="stat warn" href="#" data-st="due-week"><span class="n">${s.dueThisWeek}</span><span class="l">due in the next 7 days</span></a>
        </div></div>
      <div class="grid-2" style="margin-bottom:24px">
        <section class="panel" style="margin:0"><h3>By course</h3>
          <div class="table-wrap" style="border:0"><table><tbody>${s.courses.map(c => `<tr class="clickable" data-course="${c.id}"><td style="width:45%"><strong>${esc(c.title)}</strong><div class="small muted">${esc(c.code)} · ${c.total} assigned</div></td>
            <td>${segbar(c)}</td><td class="num"><strong>${c.compliantPct}%</strong></td></tr>`).join('')}</tbody></table></div>${legend()}</section>
        <section class="panel" style="margin:0"><h3>By department</h3>
          <div class="table-wrap" style="border:0"><table><tbody>${s.departments.map(d => `<tr class="clickable" data-dept="${esc(d.name)}"><td style="width:45%"><strong>${esc(d.name)}</strong><div class="small muted">${plural(d.people, 'person', 'people')}</div></td>
            <td>${segbar(d)}</td><td class="num"><strong>${d.compliantPct}%</strong></td></tr>`).join('')}</tbody></table></div>${legend()}</section>
      </div>
      <section><div class="between" style="margin-bottom:12px"><h2 style="margin:0">Who needs to act</h2><a class="btn btn-quiet btn-small" id="csv" href="#">${icon('download', 14)} Export CSV</a></div>
        <div class="filters">
          <div><label for="fq" class="small">Search</label><input id="fq" type="search" placeholder="Name, email or employee ID"></div>
          <div><label for="fc" class="small">Course</label><select id="fc"><option value="">All courses</option>${s.courses.map(c => `<option value="${c.id}">${esc(c.code)}</option>`).join('')}</select></div>
          <div><label for="fd" class="small">Department</label><select id="fd"><option value="">All departments</option>${depts.departments.map(d => `<option>${esc(d.name)}</option>`).join('')}</select></div>
          <div><label for="fs" class="small">Status</label><select id="fs"><option value="noncompliant">Not compliant</option><option value="">Everyone</option>${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <button class="btn btn-quiet" id="freset" type="button">Reset</button>
        </div><div id="rows">${loading()}</div></section>`}`;
    if (!t.total) return;
    const qs = () => new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    async function load() {
      const el = $('#rows'); if (!el) return;
      try {
        const { rows, total, serverNow } = await api('GET', `/api/compliance/rows?${qs()}`);
        $('#csv').href = `/api/compliance.csv?${qs()}`;
        el.innerHTML = !rows.length ? `<div class="empty"><h3>${f.status === 'noncompliant' ? 'Everyone here is compliant' : 'No one matches these filters'}</h3><p class="muted">${f.status === 'noncompliant' ? 'Nothing needs chasing right now.' : 'Try a different course, department or status.'}</p></div>`
          : `<p class="small muted">${total > rows.length ? `Showing the first ${rows.length} of ${total}. Export the CSV for the full list.` : plural(total, 'record')}</p>
          <div class="table-wrap"><table class="cards"><thead><tr><th>Person</th><th>Course</th><th>Status</th><th>Deadline</th><th>Progress</th><th>Manager</th></tr></thead><tbody>
          ${rows.map(r => `<tr class="clickable" data-person="${r.user_id}"><td data-label="Person"><a href="#/people/${r.user_id}"><strong>${esc(r.name)}</strong></a><div class="small muted">${esc(r.employee_id || '')} · ${esc(r.department || '')}</div></td>
            <td data-label="Course">${esc(r.code)}</td><td data-label="Status">${chip(r.status)}</td>
            <td data-label="Deadline">${r.status === 'completed' ? `valid to ${fmtDate(r.cert_expires)}` : r.status === 'expiring' ? `expires ${fmtDate(r.cert_expires)}` : dueText(r.effective_due, serverNow)}</td>
            <td data-label="Progress">${r.lessons_done}/${r.lessons_total} lessons${r.attempts ? ` · ${plural(r.attempts, 'quiz attempt')}` : ''}</td>
            <td data-label="Manager">${esc(r.manager_name || '—')}</td></tr>`).join('')}</tbody></table></div>`;
        $$('tr[data-person]', el).forEach(tr => tr.onclick = e => { if (!e.target.closest('a')) go(`#/people/${tr.dataset.person}`); });
      } catch (e) { el.innerHTML = errBlock(e); }
    }
    const sync = () => { $('#fc').value = f.course; $('#fd').value = f.department; $('#fs').value = ['due-week'].includes(f.status) ? '' : f.status; $('#fq').value = f.q; load(); };
    let deb;
    $('#fq').oninput = e => { clearTimeout(deb); deb = setTimeout(() => { f.q = e.target.value.trim(); load(); }, 250); };
    $('#fc').onchange = e => { f.course = e.target.value; load(); };
    $('#fd').onchange = e => { f.department = e.target.value; load(); };
    $('#fs').onchange = e => { f.status = e.target.value; load(); };
    $('#freset').onclick = () => { Object.assign(f, { course: '', department: '', status: 'noncompliant', q: '' }); sync(); };
    $$('[data-st]').forEach(a => a.onclick = e => { e.preventDefault(); f.status = a.dataset.st === 'due-week' ? 'not_started' : a.dataset.st; sync(); $('#rows').scrollIntoView({ behavior: 'smooth' }); });
    $$('tr[data-course]').forEach(tr => tr.onclick = () => { f.course = tr.dataset.course; f.department = ''; sync(); $('#rows').scrollIntoView({ behavior: 'smooth' }); });
    $$('tr[data-dept]').forEach(tr => tr.onclick = () => { f.department = tr.dataset.dept === 'No department' ? '' : tr.dataset.dept; f.course = ''; sync(); $('#rows').scrollIntoView({ behavior: 'smooth' }); });
    load();
  }

  // ---------------- people ----------------
  async function viewPeople() {
    const isHr = state.user.role === 'hr_admin';
    const main = shell(`<div class="page-head"><h1>${isHr ? 'People' : 'My team'}</h1><p>${isHr ? 'Everyone in the company and where they stand on training.' : 'Your direct reports and their training.'}</p></div>
      <div class="filters" style="grid-template-columns:2fr 1fr ${isHr ? '1fr' : ''}"><div><label for="pq" class="small">Search</label><input id="pq" type="search" placeholder="Name, email, employee ID or title"></div>
      <div><label for="pd" class="small">Department</label><select id="pd"><option value="">All</option></select></div>
      ${isHr ? '<div><label class="small" for="pl">Show</label><select id="pl"><option value="0">Current staff</option><option value="1">People who have left</option></select></div>' : ''}</div><div id="plist">${loading()}</div>`, 'people');
    api('GET', '/api/departments').then(d => { $('#pd').innerHTML += d.departments.map(x => `<option>${esc(x.name)}</option>`).join(''); }).catch(() => {});
    async function load() {
      const p = new URLSearchParams({ q: $('#pq').value.trim(), department: $('#pd').value, left: $('#pl')?.value || '0' });
      try {
        const { people, total } = await api('GET', `/api/people?${p}`);
        $('#plist', main).innerHTML = !people.length ? `<div class="empty"><h3>${total === 0 && !$('#pq').value ? (isHr ? 'No employees yet' : 'Nobody reports to you yet') : 'No one matches'}</h3>
          <p class="muted">${isHr ? 'Import your staff list to get started.' : 'HR sets reporting lines when they import the staff list.'}</p>${isHr ? '<a class="btn" href="#/import">Import employees</a>' : ''}</div>`
          : `<p class="small muted">${people.length < total ? `Showing ${people.length} of ${total}` : plural(total, 'person', 'people')}</p>
          <div class="table-wrap"><table class="cards"><thead><tr><th>Name</th><th>Department</th><th>Manager</th><th>Training</th><th class="num">Compliant</th></tr></thead><tbody>
          ${people.map(p => `<tr class="clickable" data-id="${p.id}"><td data-label="Name"><a href="#/people/${p.id}"><strong>${esc(p.name)}</strong></a><div class="small muted">${esc(p.employee_id || '')} · ${esc(p.job_title || '')}${p.role === 'manager' ? ' · manager' : ''}</div></td>
            <td data-label="Department">${esc(p.department || '—')}</td><td data-label="Manager">${esc(p.manager_name || '—')}</td>
            <td data-label="Training">${p.training.total ? segbar(p.training) : '<span class="muted small">Nothing assigned</span>'}</td>
            <td data-label="Compliant" class="num">${p.training.total ? `<strong class="${p.training.overdue + p.training.expired ? 'due-bad' : ''}">${p.training.compliant}/${p.training.total}</strong>` : '—'}</td></tr>`).join('')}</tbody></table></div>${legend()}`;
        $$('tr[data-id]', main).forEach(tr => tr.onclick = e => { if (!e.target.closest('a')) go(`#/people/${tr.dataset.id}`); });
      } catch (e) { $('#plist', main).innerHTML = errBlock(e); }
    }
    let deb; $('#pq').oninput = () => { clearTimeout(deb); deb = setTimeout(load, 250); };
    $('#pd').onchange = load; if ($('#pl')) $('#pl').onchange = load;
    load();
  }
  async function viewPerson(id) {
    const main = shell(loading(), 'people');
    const { person: p, assignments, serverNow } = await api('GET', `/api/people/${id}`);
    const isHr = state.user.role === 'hr_admin';
    main.innerHTML = `<div class="crumbs"><a href="#/people">${isHr ? 'People' : 'My team'}</a></div>
      <div class="page-head"><h1>${esc(p.name)}</h1><p>${esc(p.job_title || '')} · ${esc(p.department || '')} · ${esc(p.employee_id || '')} · ${esc(p.email)}<br>
      Manager: ${esc(p.manager_name || 'none')} · Joined ${p.joined_on ? fmtDate(Date.parse(p.joined_on)) : 'unknown'}${p.active ? '' : ' · <strong class="due-bad">has left</strong>'}</p></div>
      ${assignments.length ? `<div class="table-wrap"><table class="cards"><thead><tr><th>Course</th><th>Status</th><th>Deadline / validity</th><th>Progress</th><th>Certificate</th>${isHr ? '<th></th>' : ''}</tr></thead><tbody>
        ${assignments.map(a => `<tr><td data-label="Course"><strong>${esc(a.title)}</strong><div class="small muted">${esc(a.code)} · ${a.source === 'rule' ? 'required by rule' : 'assigned manually'}</div></td>
          <td data-label="Status">${chip(a.status)}</td>
          <td data-label="Deadline">${a.status === 'completed' ? (a.cert_expires ? `valid to ${fmtDate(a.cert_expires)}` : 'no expiry') : a.status === 'expiring' ? `expires ${fmtDate(a.cert_expires)}` : dueText(a.effective_due, serverNow)}</td>
          <td data-label="Progress">${a.lessons_done}/${a.lessons_total} lessons${a.attempts ? ` · ${plural(a.attempts, 'attempt')}` : ''}</td>
          <td data-label="Certificate">${a.cert_code ? `<a href="#/certificate/${esc(a.cert_code)}">${esc(a.cert_code)}</a>` : '—'}</td>
          ${isHr ? `<td>${a.attempts && !['completed', 'expiring'].includes(a.status) ? `<button class="btn btn-quiet btn-small" data-reset="${a.course_id}">Allow another attempt</button>` : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>`
        : '<div class="empty"><h3>No training assigned</h3><p class="muted">Assign a course from the Courses page.</p></div>'}`;
    $$('[data-reset]').forEach(b => b.onclick = async () => {
      try { const r = await api('POST', `/api/people/${p.id}/courses/${b.dataset.reset}/reset-attempts`); toast(r.reset ? `${p.name.split(' ')[0]} can try the quiz again.` : 'There were no failed attempts to reset.'); b.remove(); }
      catch (e) { toast(errText(e)); }
    });
  }

  // ---------------- courses & rules ----------------
  async function viewCourses() {
    const main = shell(loading(), 'courses');
    const { courses } = await api('GET', '/api/courses');
    const isHr = state.user.role === 'hr_admin';
    main.innerHTML = `<div class="between page-head"><div><h1>Courses</h1><p>${isHr ? 'Create courses and decide who must take them.' : 'Assign courses to your team.'}</p></div>
      ${isHr ? `<a class="btn" href="#/courses/new">${icon('plus')} New course</a>` : ''}</div>
      ${!courses.length ? '<div class="empty"><h3>No courses yet</h3><p class="muted">Create your first course: a few short lessons and a quiz.</p></div>' : `<ul class="list">${courses.map(c => `<li>
        <div class="grow"><a class="title" href="#/courses/${c.id}">${esc(c.title)}</a>
        <div class="meta"><span class="tag">${esc(c.category)}</span> ${esc(c.code)} · ${plural(c.lesson_count, 'lesson')} · pass ${c.pass_mark}% · ${c.validity_months ? `renew every ${plural(c.validity_months, 'month')}` : 'no expiry'}
        · ${c.rules.length ? `required for ${c.rules.map(r => esc(r.department || 'everyone')).join(', ')}` : 'assigned manually'}</div></div>
        <div style="width:200px">${segbar(c.stats)}<div class="meta">${c.stats.total ? `${c.stats.compliantPct}% of ${c.stats.total} compliant` : 'not assigned'}</div></div></li>`).join('')}</ul>${legend()}`}`;
  }
  async function viewCourse(id) {
    const main = shell(loading(), 'courses');
    const isHr = state.user.role === 'hr_admin';
    const [d, depts] = await Promise.all([api('GET', `/api/courses/${id}`), api('GET', '/api/departments')]);
    const c = d.course;
    main.innerHTML = `<div class="crumbs"><a href="#/courses">Courses</a></div>
      <div class="between page-head"><div><h1>${esc(c.title)}</h1><p>${esc(c.summary || '')}</p>
        <p class="small muted"><span class="tag">${esc(c.category)}</span> ${esc(c.code)} · about ${c.est_minutes} min · pass mark ${c.pass_mark}% · ${c.validity_months ? `certificate valid ${plural(c.validity_months, 'month')}` : 'certificate never expires'} · ${c.max_attempts ? `${plural(c.max_attempts, 'attempt')} per cycle` : 'unlimited attempts'}</p></div>
        <div class="row">${isHr ? `<a class="btn btn-quiet" href="#/courses/${c.id}/edit">Edit course</a>` : ''}<button class="btn" id="assign">Assign to people</button></div></div>
      <div class="grid-2">
        <section class="panel" style="margin:0"><h3>${isHr ? 'Where it stands' : 'Your team'}</h3>${d.stats.total ? `${segbar(d.stats, true)}${legend()}
          <p style="margin-top:12px"><strong>${d.stats.compliantPct}%</strong> compliant · ${d.stats.overdue + d.stats.expired} need chasing</p>
          <a href="#/compliance" class="small">See who on the compliance page</a>` : '<p class="muted">Nobody has this course yet.</p>'}</section>
        <section class="panel" style="margin:0"><h3>Who must take it</h3>
          ${d.rules.length ? `<ul class="list" style="margin-bottom:12px">${d.rules.map(r => `<li><div class="grow"><strong>${esc(r.department || 'Everyone')}</strong><div class="meta">within ${plural(r.due_days, 'day')} of being assigned or joining</div></div>
            ${isHr ? `<button class="btn btn-danger btn-small" data-del-rule="${r.id}" aria-label="Remove rule for ${esc(r.department || 'everyone')}">${icon('trash', 14)}</button>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No rule — only people assigned by hand get this course.</p>'}
          ${isHr ? `<form id="rule-form" class="row" novalidate style="align-items:end">
            <div style="flex:2;min-width:160px"><label for="rd" class="small">Department</label><select id="rd"><option value="">Everyone</option>${depts.departments.map(x => `<option>${esc(x.name)}</option>`).join('')}</select></div>
            <div style="flex:1;min-width:100px"><label for="rdays" class="small">Days to finish</label><input id="rdays" type="number" min="1" max="365" value="30"></div>
            <button class="btn btn-quiet" type="submit">Add rule</button></form>
            <p class="small muted" style="margin-top:8px">Rules apply now and to everyone who joins or moves into the department later.</p><div id="rule-msg"></div>` : ''}
        </section></div>
      <h2 style="margin-top:32px">Lessons</h2>
      <ol class="list" style="padding:0">${d.lessons.map((l, i) => `<li><details style="width:100%"><summary style="cursor:pointer"><strong>${i + 1}. ${esc(l.title)}</strong></summary><div class="lesson-body" style="margin-top:12px">${renderText(l.body)}</div></details></li>`).join('')}</ol>
      ${isHr ? `<h2 style="margin-top:32px">Quiz (${d.questions.length} questions)</h2><ol class="list" style="padding:0">${d.questions.map((q, i) => `<li><div><strong>${i + 1}. ${esc(q.prompt)}</strong>
        <div class="small muted">${q.options.map((o, j) => j === q.correct_index ? `<strong style="color:var(--st-completed)">✓ ${esc(o)}</strong>` : esc(o)).join(' · ')}</div></div></li>`).join('')}</ol>` : ''}`;
    $('#rule-form')?.addEventListener('submit', async e => {
      e.preventDefault();
      try { const r = await api('POST', `/api/courses/${c.id}/rules`, { department: $('#rd').value, due_days: Number($('#rdays').value) }); toast(`Rule added — ${plural(r.assignmentsCreated, 'person', 'people')} newly assigned.`); viewCourse(id); }
      catch (err) { $('#rule-msg').innerHTML = errBlock(err); }
    });
    $$('[data-del-rule]').forEach(b => b.onclick = async () => {
      if (!(await dialog({ title: 'Remove this rule?', body: '<p>People already assigned keep the course. New joiners won\'t get it automatically.</p>', confirm: 'Remove rule', danger: true }))) return;
      try { await api('DELETE', `/api/rules/${b.dataset.delRule}`); toast('Rule removed'); viewCourse(id); } catch (err) { toast(errText(err)); }
    });
    $('#assign').onclick = async () => {
      let people;
      try { people = (await api('GET', '/api/people')).people; } catch (e) { toast(errText(e)); return; }
      if (!people.length) { toast(isHr ? 'There are no employees yet.' : 'Nobody reports to you yet.'); return; }
      const result = await dialog({ title: `Assign ${c.code}`, confirm: 'Assign', body: `
        <div class="field"><label for="ad">Days to finish</label><input id="ad" type="number" min="1" max="365" value="14"></div>
        <div class="field" style="margin:0"><div class="between"><label style="margin:0">People</label><button type="button" class="link-btn small" id="all">Select all</button></div>
        <input type="search" id="af" placeholder="Filter" style="margin:6px 0">
        <div class="checklist">${people.map(p => `<label data-n="${esc((p.name + ' ' + (p.department || '')).toLowerCase())}"><input type="checkbox" value="${p.id}"> ${esc(p.name)} <span class="small muted">${esc(p.department || '')}</span></label>`).join('')}</div></div><div id="am"></div>`,
        onOpen: w => {
          $('#af', w).oninput = e => $$('.checklist label', w).forEach(l => { l.hidden = !l.dataset.n.includes(e.target.value.toLowerCase()); });
          $('#all', w).onclick = () => $$('.checklist label:not([hidden]) input', w).forEach(i => { i.checked = true; });
          w.__validate = () => {
            const ids = $$('.checklist input:checked', w).map(i => Number(i.value)); const days = Number($('#ad', w).value);
            if (!ids.length) { $('#am', w).innerHTML = notice('bad', '<p>Pick at least one person.</p>'); return false; }
            if (!(days >= 1 && days <= 365)) { $('#am', w).innerHTML = notice('bad', '<p>Days to finish must be 1–365.</p>'); return false; }
            w.__value = { ids, days }; return true;
          };
        } });
      if (!result) return;
      try { const r = await api('POST', `/api/courses/${c.id}/assign`, { user_ids: result.ids, due_days: result.days });
        toast(`Assigned to ${plural(r.created, 'person', 'people')}${r.alreadyAssigned ? ` (${r.alreadyAssigned} already had it)` : ''}.`); viewCourse(id); }
      catch (e) { toast(errText(e)); }
    };
  }

  async function viewCourseEdit(id) {
    const main = shell(loading(), 'courses');
    let d = { course: { code: '', title: '', summary: '', category: 'Compliance', est_minutes: 15, pass_mark: 80, validity_months: 12, max_attempts: 3 },
      lessons: [{ title: '', body: '' }], questions: [{ prompt: '', options: ['', '', '', ''], correct_index: null }] };
    if (id) d = await api('GET', `/api/courses/${id}`);
    const lessons = d.lessons.map(l => ({ title: l.title, body: l.body, video_url: l.video_url || '' }));
    const qs = d.questions.map(q => ({ prompt: q.prompt, options: [...q.options, '', ''].slice(0, Math.max(4, q.options.length)), correct_index: q.correct_index ?? null }));
    const c = d.course;
    main.innerHTML = `<div class="crumbs"><a href="#/courses">Courses</a>${id ? ` / <a href="#/courses/${id}">${esc(c.code)}</a>` : ''}</div>
      <div class="page-head"><h1>${id ? 'Edit course' : 'New course'}</h1>${id ? '<p>Changes apply straight away. People keep the lessons they\'ve already finished.</p>' : ''}</div>
      <form id="cf" novalidate><section class="panel">
        <div class="fields"><div class="field"><label for="cc">Code <span class="hint">Short and unique, e.g. FIRE-01.</span></label><input id="cc" type="text" value="${esc(c.code)}" maxlength="16"></div>
          <div class="field" style="grid-column:span 2"><label for="ct">Title</label><input id="ct" type="text" value="${esc(c.title)}" maxlength="150"></div></div>
        <div class="field"><label for="cs">Summary <span class="hint">One or two sentences: what it covers and who it's for.</span></label><textarea id="cs" style="min-height:70px">${esc(c.summary || '')}</textarea></div>
        <div class="fields">
          <div class="field"><label for="ccat">Category</label><select id="ccat">${['Compliance', 'Onboarding', 'Skills'].map(x => `<option ${x === c.category ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
          <div class="field"><label for="cp">Pass mark (%)</label><input id="cp" type="number" min="1" max="100" value="${c.pass_mark}"></div>
          <div class="field"><label for="cv">Certificate valid for (months) <span class="hint">Blank = never expires.</span></label><input id="cv" type="number" min="1" max="120" value="${c.validity_months ?? ''}"></div>
          <div class="field"><label for="cm">Attempts allowed <span class="hint">Blank = unlimited.</span></label><input id="cm" type="number" min="1" max="20" value="${c.max_attempts ?? ''}"></div>
          <div class="field"><label for="ce">Minutes to complete</label><input id="ce" type="number" min="1" value="${c.est_minutes}"></div></div>
      </section>
      <h2>Lessons</h2><p class="muted small">Keep each lesson short. Leave a blank line between paragraphs; start lines with "• " for a list.</p><div id="ls"></div>
      <button class="btn btn-quiet" type="button" id="addl" style="margin-bottom:32px">${icon('plus')} Add lesson</button>
      <h2>Quiz</h2><p class="muted small">Multiple choice. Select the correct option with the round button.</p><div id="qs"></div>
      <button class="btn btn-quiet" type="button" id="addq" style="margin-bottom:32px">${icon('plus')} Add question</button>
      <div id="cerr"></div><div class="row"><button class="btn" type="submit">${id ? 'Save changes' : 'Create course'}</button><a class="btn btn-quiet" href="${id ? `#/courses/${id}` : '#/courses'}">Cancel</a></div></form>`;
    const renderL = () => { $('#ls').innerHTML = lessons.map((l, i) => `<div class="edit-block" data-l="${i}"><div class="between" style="margin-bottom:8px"><strong>Lesson ${i + 1}</strong>
      ${lessons.length > 1 ? `<button type="button" class="btn btn-danger btn-small" data-dl="${i}">${icon('trash', 14)} Remove</button>` : ''}</div>
      <div class="field"><label class="visually-hidden" for="lt${i}">Lesson ${i + 1} title</label><input id="lt${i}" type="text" data-k="title" value="${esc(l.title)}" placeholder="Lesson title"></div>
      <div class="field"><label class="visually-hidden" for="lb${i}">Lesson ${i + 1} content</label><textarea id="lb${i}" data-k="body" placeholder="Lesson content" style="min-height:140px">${esc(l.body)}</textarea></div>
      <div class="field" style="margin:0"><label class="small" for="lv${i}">Video link (optional)</label><input id="lv${i}" type="url" data-k="video_url" value="${esc(l.video_url)}" placeholder="https://"></div></div>`).join(''); };
    const renderQ = () => { $('#qs').innerHTML = qs.map((q, i) => `<div class="edit-block" data-q="${i}"><div class="between" style="margin-bottom:8px"><strong>Question ${i + 1}</strong>
      ${qs.length > 1 ? `<button type="button" class="btn btn-danger btn-small" data-dq="${i}">${icon('trash', 14)} Remove</button>` : ''}</div>
      <div class="field"><label class="visually-hidden" for="qp${i}">Question ${i + 1}</label><input id="qp${i}" type="text" data-k="prompt" value="${esc(q.prompt)}" placeholder="Question"></div>
      <fieldset style="border:0;padding:0;margin:0"><legend class="small muted" style="margin-bottom:6px">Options</legend>${q.options.map((o, j) => `<div class="opt-row"><input type="radio" name="cq${i}" value="${j}" ${q.correct_index === j ? 'checked' : ''} aria-label="Option ${j + 1} is correct">
        <input type="text" data-o="${j}" value="${esc(o)}" placeholder="Option ${j + 1}" aria-label="Option ${j + 1}"></div>`).join('')}</fieldset></div>`).join(''); };
    renderL(); renderQ();
    $('#ls').oninput = e => { const b = e.target.closest('[data-l]'); if (b && e.target.dataset.k) lessons[b.dataset.l][e.target.dataset.k] = e.target.value; };
    $('#ls').onclick = e => { const x = e.target.closest('[data-dl]'); if (x) { lessons.splice(Number(x.dataset.dl), 1); renderL(); } };
    $('#qs').oninput = e => { const b = e.target.closest('[data-q]'); if (!b) return; const q = qs[b.dataset.q];
      if (e.target.dataset.k) q.prompt = e.target.value; if (e.target.dataset.o !== undefined) q.options[e.target.dataset.o] = e.target.value; };
    $('#qs').onchange = e => { if (e.target.type === 'radio') qs[e.target.closest('[data-q]').dataset.q].correct_index = Number(e.target.value); };
    $('#qs').onclick = e => { const x = e.target.closest('[data-dq]'); if (x) { qs.splice(Number(x.dataset.dq), 1); renderQ(); } };
    $('#addl').onclick = () => { lessons.push({ title: '', body: '', video_url: '' }); renderL(); $(`#lt${lessons.length - 1}`).focus(); };
    $('#addq').onclick = () => { qs.push({ prompt: '', options: ['', '', '', ''], correct_index: null }); renderQ(); $(`#qp${qs.length - 1}`).focus(); };
    $('#cf').onsubmit = async e => {
      e.preventDefault(); const btn = $('button[type=submit]', e.target); btn.disabled = true;
      const body = { code: $('#cc').value, title: $('#ct').value, summary: $('#cs').value, category: $('#ccat').value, pass_mark: Number($('#cp').value),
        validity_months: $('#cv').value, max_attempts: $('#cm').value, est_minutes: Number($('#ce').value), lessons, questions: qs };
      try { const r = await api(id ? 'PUT' : 'POST', id ? `/api/courses/${id}` : '/api/courses', body); toast(id ? 'Course saved' : 'Course created'); go(`#/courses/${r.id}`); }
      catch (err) { $('#cerr').innerHTML = errBlock(err); btn.disabled = false; $('#cerr').scrollIntoView({ block: 'center' }); }
    };
  }

  // ---------------- Feature 1: import ----------------
  async function viewImport() {
    const main = shell(`<div class="page-head"><h1>Import employees</h1><p>Upload the staff list exported from your HR or payroll system. Upload it again whenever it changes — new joiners are added, moves are updated, leavers are switched off.</p></div>
      <div class="grid-2" style="margin-bottom:24px">
        <section class="panel" style="margin:0"><h3>Columns</h3><dl class="spec">
          <dt>employee_id</dt><dd>Required. Their first password until they set up their account.</dd><dt>name</dt><dd>Required.</dd>
          <dt>email</dt><dd>Required. Work email; used to sign in.</dd><dt>department</dt><dd>Required. Decides which courses they must take.</dd>
          <dt>manager_email</dt><dd>Optional. Managers see their reports' training.</dd><dt>joined_on</dt><dd>Optional. YYYY-MM-DD or DD/MM/YYYY. Deadlines count from here.</dd>
          <dt>job_title, role, status</dt><dd>Optional. Status "left" switches the person off.</dd></dl>
          <p class="small muted" style="margin-top:12px">Common names like "Emp Code", "Reporting Manager" or "Date of Joining" are recognised. <a href="/samples/employees-template.csv" download>Template</a> · <a href="/samples/employees-sample.csv" download>Sample with mistakes</a></p></section>
        <section class="panel" style="margin:0"><h3>What happens</h3><ul class="small" style="padding-left:1.1em;margin:0">
          <li><strong>You see every change before it's saved.</strong></li>
          <li><strong>Rows with mistakes are left out</strong>; everything else goes in. Download just the bad rows, fix them, upload again.</li>
          <li>Training rules run straight away: new joiners get onboarding and compliance courses with deadlines.</li>
          <li>An email or employee ID that belongs to someone else is an error, never a silent merge.</li>
          <li>Uploading the same file twice changes nothing.</li></ul></section></div>
      <section class="panel"><div class="dropzone" id="drop"><p>${icon('upload', 28)}</p><p><strong>Drop a CSV file here</strong> or</p>
        <label class="btn btn-quiet" style="display:inline-flex;margin:0">Choose file<input type="file" id="file" accept=".csv,text/csv" class="visually-hidden"></label>
        <p class="small muted" id="fname" style="margin:12px auto 0">Up to 10,000 rows. From Excel, save as "CSV UTF-8".</p></div></section>
      <div id="res"></div><h2 style="margin-top:32px">Recent imports</h2><div id="hist">${loading()}</div>`, 'import');
    let csv = null, filename = null, plan = null, filter = 'all';
    const res = $('#res');
    const LABEL = { create: ['st-completed', 'New'], update: ['st-in_progress', 'Update'], deactivate: ['st-expiring', 'Left'], skip: ['st-not_started', 'No change'], error: ['st-expired', 'Mistake'] };
    async function hist() {
      try {
        const { batches } = await api('GET', '/api/import/batches');
        $('#hist').innerHTML = batches.length ? `<div class="table-wrap"><table class="cards"><thead><tr><th>When</th><th>File</th><th class="num">New</th><th class="num">Updated</th><th class="num">Left</th><th class="num">Mistakes</th><th class="num">Courses assigned</th><th></th></tr></thead><tbody>
          ${batches.map(b => `<tr><td data-label="When">${new Date(b.created_at).toLocaleString('en-IN')}<div class="small muted">${esc(b.admin_name)}</div></td><td data-label="File">${esc(b.filename)}</td>
          <td class="num" data-label="New">${b.summary.create}</td><td class="num" data-label="Updated">${b.summary.update}</td><td class="num" data-label="Left">${b.summary.deactivate}</td>
          <td class="num" data-label="Mistakes">${b.summary.errors ? `<span class="chip st-expired">${b.summary.errors}</span>` : 0}</td><td class="num" data-label="Courses assigned">${b.summary.assignmentsCreated}</td>
          <td data-label="Report"><a href="/api/import/batches/${b.id}/report.csv" download>Report</a>${b.summary.errors ? ` · <a href="/api/import/batches/${b.id}/report.csv?errors=1" download>Rows to fix</a>` : ''}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty"><h3>No imports yet</h3><p class="muted">Your first upload will appear here with a downloadable report.</p></div>';
      } catch (e) { $('#hist').innerHTML = errBlock(e); }
    }
    hist();
    function show(done) {
      const s = plan.summary, valid = s.create + s.update + s.deactivate;
      const rows = plan.results.filter(r => filter === 'all' || r.status === filter);
      res.innerHTML = `<section class="panel">
        ${done ? notice('ok', `<p><strong>Import finished.</strong> ${plural(s.create, 'new person', 'new people')}, ${s.update} updated, ${s.deactivate} marked as left. <strong>${plural(s.assignmentsCreated, 'course')} assigned</strong> by your training rules.
          ${s.errors ? ` ${plural(s.errors, 'row')} with mistakes ${s.errors === 1 ? 'was' : 'were'} left out — <a href="/api/import/batches/${done}/report.csv?errors=1" download>download them to fix</a>.` : ''}</p>`) : ''}
        <h2>${done ? 'Import report' : 'Check before importing'} <span class="small muted" style="font-weight:400">${esc(filename)}</span></h2>
        <div class="stats"><div class="stat"><span class="n">${s.total}</span><span class="l">rows</span></div><div class="stat ok"><span class="n">${s.create}</span><span class="l">new people</span></div>
          <div class="stat"><span class="n">${s.update}</span><span class="l">updates</span></div><div class="stat warn"><span class="n">${s.deactivate}</span><span class="l">leavers</span></div>
          <div class="stat"><span class="n">${s.skip}</span><span class="l">no change</span></div><div class="stat ${s.errors ? 'bad' : ''}"><span class="n">${s.errors}</span><span class="l">mistakes</span></div></div>
        ${plan.ignoredColumns?.length ? notice('info', `<p>Not used, will be ignored: ${plan.ignoredColumns.map(esc).join(', ')}.</p>`) : ''}${(plan.warnings || []).map(w => notice('warn', `<p>${esc(w)}</p>`)).join('')}
        ${done ? '' : `<div class="row" style="margin-bottom:20px"><button class="btn" id="go" ${valid ? '' : 'disabled'}>Apply ${plural(valid, 'change')}</button><button class="btn btn-quiet" id="again">Choose a different file</button>
          <span class="small muted">${s.errors ? `${plural(s.errors, 'row')} with mistakes will be left out.` : ''}${!valid ? ' Nothing to change.' : ''}</span></div>`}
        <div class="pills" role="group" aria-label="Show rows">${[['all', 'All', s.total], ['error', 'Mistakes', s.errors], ['create', 'New', s.create], ['update', 'Updates', s.update], ['deactivate', 'Leavers', s.deactivate], ['skip', 'No change', s.skip]]
          .map(([k, l, n]) => `<button type="button" data-f="${k}" aria-pressed="${filter === k}">${l} (${n})</button>`).join('')}</div>
        ${rows.length ? `<div class="table-wrap"><table class="cards"><thead><tr><th>Line</th><th>Employee</th><th>Department</th><th>Manager</th><th>What happens</th></tr></thead><tbody>
          ${rows.slice(0, 500).map(r => `<tr class="${r.status === 'error' ? 'row-error' : ''}"><td data-label="Line">${r.line}</td><td data-label="Employee"><strong>${esc(r.name) || '<span class="muted">no name</span>'}</strong><div class="small muted">${esc(r.employee_id)} · ${esc(r.email)}</div></td>
          <td data-label="Department">${esc(r.department)}</td><td data-label="Manager" class="small">${esc(r.manager_email || '—')}</td>
          <td data-label="Result"><span class="chip ${LABEL[r.status][0]}">${LABEL[r.status][1]}</span> <span class="small">${esc(r.message)}</span></td></tr>`).join('')}</tbody></table></div>
          ${rows.length > 500 ? `<p class="small muted">Showing the first 500 of ${rows.length}.</p>` : ''}` : '<p class="muted">No rows in this group.</p>'}</section>`;
      $$('[data-f]', res).forEach(b => b.onclick = () => { filter = b.dataset.f; show(done); });
      $('#again', res)?.addEventListener('click', () => { res.innerHTML = ''; $('#file').value = ''; $('#drop').scrollIntoView(); });
      $('#go', res)?.addEventListener('click', async e => {
        if (!(await dialog({ title: `Apply ${plural(valid, 'change')}?`, body: `<p>${plural(s.create, 'new account')} will be created${s.deactivate ? ` and ${plural(s.deactivate, 'person', 'people')} switched off` : ''}. Training rules will then assign courses.</p>`, confirm: 'Apply' }))) return;
        e.target.disabled = true; e.target.innerHTML = '<span class="spinner"></span> Importing…';
        try { plan = await api('POST', '/api/import/commit', { csv, filename }); filter = plan.summary.errors ? 'error' : 'all'; show(plan.batchId); hist(); res.scrollIntoView(); }
        catch (err) { e.target.disabled = false; e.target.textContent = 'Apply'; res.insertAdjacentHTML('afterbegin', errBlock(err)); }
      });
    }
    async function take(file) {
      if (!file) return;
      if (!/\.csv$/i.test(file.name)) { res.innerHTML = notice('bad', `<p>"${esc(file.name)}" isn't a CSV file. In Excel use File → Save As → "CSV UTF-8 (Comma delimited)".</p>`); return; }
      filename = file.name; csv = await file.text(); $('#fname').textContent = `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB`;
      res.innerHTML = `<section class="panel">${loading(`Checking ${file.name}…`)}</section>`;
      try { plan = await api('POST', '/api/import/preview', { csv }); filter = plan.summary.errors ? 'error' : 'all'; show(); }
      catch (e) { res.innerHTML = errBlock(e); }
    }
    $('#file').onchange = e => take(e.target.files[0]);
    const drop = $('#drop');
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); take(e.dataTransfer.files[0]); };
  }

  route();
})();
