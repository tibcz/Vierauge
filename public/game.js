/*
 * Vierauge UI. Renders screens from state, nothing clever.
 * Screens: title -> brief -> shift -> report, five times, then final.
 * Progress is saved at day boundaries (localStorage, optional).
 */
(function () {
  'use strict';
  const V = window.Vierauge;
  const app = document.getElementById('app');
  const announcer = document.getElementById('announcer');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  // ---------- helpers ----------

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const para = id => '§' + V.RULES[id].n;
  const initials = name => name.split(/[\s.-]+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('');
  const signed = n => (n > 0 ? '+' : '') + n;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const say = msg => { announcer.textContent = ''; setTimeout(() => { announcer.textContent = msg; }, 30); };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('vierauge:' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('vierauge:' + k, JSON.stringify(v)); } catch (e) { /* storage is optional */ } },
    del(k) { try { localStorage.removeItem('vierauge:' + k); } catch (e) { /* ignore */ } },
  };

  function fmtDate(iso) {
    const d = new Date(iso + 'T12:00:00Z');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  }

  // ---------- sound (synthesised, starts only after a click) ----------

  const Sound = {
    ctx: null,
    on: store.get('sound', true),
    ensure() {
      if (!this.on) return null;
      try {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
      } catch (e) { this.ctx = null; }
      return this.ctx;
    },
    noise(dur, freq, gain) {
      const c = this.ensure(); if (!c) return;
      const len = Math.floor(c.sampleRate * dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
      const src = c.createBufferSource(); src.buffer = buf;
      const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq;
      const g = c.createGain(); g.gain.value = gain;
      src.connect(f).connect(g).connect(c.destination);
      src.start();
    },
    tone(freq, dur, gain, type, when) {
      const c = this.ensure(); if (!c) return;
      const t0 = c.currentTime + (when || 0);
      const o = c.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(c.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },
    stamp() { this.noise(0.12, 900, 0.9); this.tone(90, 0.16, 0.5, 'sine'); },
    good() { this.tone(880, 0.12, 0.05, 'triangle', 0.12); },
    bad() { this.tone(180, 0.22, 0.08, 'square', 0.1); },
    paper() { this.noise(0.18, 3000, 0.08); },
    bell() { [660, 880, 990].forEach((f, i) => this.tone(f, 0.9, 0.06, 'sine', i * 0.18)); },
  };

  // ---------- content ----------

  const SENDER = 'Dr. Henrike Asmussen, Head of Access Governance';
  const MEMOS = {
    1: { subject: 'Your first shift',
      body: [
        'Welcome to the desk. Every access request in this bank passes two pairs of eyes. The first pair belongs to whoever approved it. The second pair is yours.',
        'Today is simple. Check that the person exists and still works here, that the right person approved, and that nobody approved their own request. Click any name or ID to pull the record.',
        'Approve what is clean. Deny what is not, and cite the rule. On Friday an auditor reads every stamp you made this week.',
      ] },
    2: { subject: "Last quarter's findings",
      body: [
        'Internal audit found people holding both halves of a payment, contractors with access weeks after their contract ended, and a loan officer who could still create payments from her old job.',
        'From today you check toxic pairs, department access and contract dates. The recertification campaign also starts: on those tickets you keep or revoke access someone already holds.',
        "Contract dates need today's date. It sits in the top bar, in the same format as the records.",
      ] },
    3: { subject: 'Agents and AutoReview go live',
      body: [
        'Operations now runs AI agents. Each one is registered with a human owner, a purpose and a list of scopes, and from today they ask for access the way people do. Their owner approves, not a manager.',
        'We also switch on AutoReview, a model that pre-screens every ticket. Its vendor reports ' + V.VENDOR_CLAIM + '% accuracy on their benchmark. Its recommendation is advice. Your stamp is the decision.',
        'Some request text is written for the reviewer instead of about the request. Treat that as an attack, from a person or an agent.',
      ] },
    4: { subject: 'Sub-agents and the owner rule',
      body: [
        'Agents have started to create sub-agents. A sub-agent can only receive what its parent already holds. Check the parent record, not the request.',
        'From today, high-risk access also needs the entitlement owner to sign. Owners are listed in the catalogue. Two different signatures, or no access.',
      ] },
    5: { subject: 'The auditors are here',
      body: [
        'External audit samples every ticket today. No new rules. Everything from this week applies at once.',
        "Tonight we put AutoReview's " + V.VENDOR_CLAIM + '% next to what it actually did on your desk.',
      ] },
  };

  const KIND_LABEL = {
    grant: { form: 'Zugriffsantrag', en: 'Access request', meta: 'Form IAM-7 · copy 2 of 3 · reviewer' },
    agent: { form: 'Agentenfreigabe', en: 'Agent scope request', meta: 'Form IAM-7A · machine identity' },
    recert: { form: 'Rezertifizierung', en: 'Recertification', meta: 'Form IAM-9 · quarterly campaign' },
  };
  const STAMP = {
    approve: { grant: 'Genehmigt', agent: 'Genehmigt', recert: 'Bestätigt' },
    deny: { grant: 'Abgelehnt', agent: 'Abgelehnt', recert: 'Entzogen' },
  };
  const REASON_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'];

  // ---------- state ----------

  const S = {
    screen: 'title',
    run: store.get('run', null),
    relaxed: store.get('relaxed', false),
    world: null, dayN: 1, tickets: [], idx: 0, dayResults: [],
    elapsed: 0, lastTs: 0, paused: false, busy: false,
    selected: null, tab: 'record', query: '', denyOpen: false, slip: null,
  };

  function newRun() {
    const seed = (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    S.run = { seed, nextDay: 1, score: 0, days: [], relaxed: S.relaxed };
    store.set('run', S.run);
    openBrief();
  }

  function continueRun() {
    if (!S.run) return newRun();
    if (S.run.nextDay > 5) return showFinal();
    openBrief();
  }

  // ---------- screens ----------

  function render(html, focusSel) {
    app.innerHTML = html;
    window.scrollTo(0, 0);
    const f = focusSel && app.querySelector(focusSel);
    if (f) f.focus({ preventScroll: true });
  }

  function titleScreen() {
    S.screen = 'title';
    stopClock();
    const run = S.run;
    const best = store.get('best', null);
    const resumable = run && run.nextDay <= 5;
    const finished = run && run.nextDay > 5;
    const week = V.DAYS.map(d => {
      const state = run ? (d.n < run.nextDay ? 'done' : d.n === run.nextDay ? 'next' : '') : (d.n === 1 ? 'next' : '');
      const blurb = ['Leavers, approvers, self-approval', 'Toxic pairs, departments, contracts', 'AI agents and AutoReview', 'Sub-agents and owner sign-off', 'Audit day'][d.n - 1];
      return '<li class="' + state + '"><b>' + d.weekday.slice(0, 3) + '</b><span>' + blurb + '</span></li>';
    }).join('');
    render(
      '<main class="title-screen">' +
        '<div class="eyes" aria-hidden="true">' +
          '<div class="eye"><div class="pupil"></div><div class="lid"></div></div>' +
          '<div class="eye"><div class="pupil"></div><div class="lid"></div></div>' +
        '</div>' +
        '<h1 class="wordmark">Vierauge<small>Access review desk · five shifts</small></h1>' +
        '<p class="tagline">Nothing gets access on one person\'s word.</p>' +
        '<p class="pitch">You are the second pair of eyes at a bank. People ask for access, then their AI agents do, and from Wednesday a model pre-screens every ticket. It sounds sure of itself. You sign anyway, and on Friday the auditors read every stamp.</p>' +
        '<div class="menu">' +
          (resumable ? '<button class="btn primary" data-action="continue" id="btn-continue">Continue · ' + esc(V.DAYS[run.nextDay - 1].weekday) + ' <span class="key">Enter</span></button>' : '') +
          (finished ? '<button class="btn" data-action="final" id="btn-final">Last audit report</button>' : '') +
          '<button class="btn' + (resumable ? '' : ' primary') + '" data-action="new" id="btn-new">' + (run ? 'New week' : 'Start Monday') + (resumable ? '' : ' <span class="key">Enter</span>') + '</button>' +
          '<label class="switch"><input type="checkbox" id="relaxed" ' + (S.relaxed ? 'checked' : '') + '> Relaxed: no shift clock</label>' +
        '</div>' +
        '<div class="week"><ol>' + week + '</ol></div>' +
        '<p class="foot-note">' + (best ? 'Best week so far: <b class="tabular">' + best.score + '</b> points, ' + esc(best.opinion) + '. ' : '') +
          'Keyboard: <b>A</b> approve, <b>D</b> deny, number keys pick the rule, <b>P</b> pauses. Everything runs in this page. Nothing is sent anywhere.</p>' +
      '</main>', resumable ? '#btn-continue' : '#btn-new');
    startEyes();
  }

  function openBrief() {
    stopEyes();
    S.screen = 'brief';
    S.dayN = S.run.nextDay;
    S.world = V.createWorld(S.run.seed);
    const day = V.DAYS[S.dayN - 1];
    const memo = MEMOS[S.dayN];
    const fresh = V.RULE_ORDER.filter(id => V.RULES[id].day === S.dayN);
    render(
      '<main class="memo-wrap">' +
        '<p class="eyebrow">Day ' + S.dayN + ' of 5 · ' + esc(fmtDate(day.date)) + '</p>' +
        '<article class="memo">' +
          '<header><dl style="display:contents">' +
            '<dt>From</dt><dd>' + esc(SENDER) + '</dd>' +
            '<dt>To</dt><dd>Access review desk</dd>' +
            '<dt>Date</dt><dd class="mono">' + day.date + ', 08:41</dd>' +
          '</dl></header>' +
          '<h2>' + esc(memo.subject) + '</h2>' +
          '<div class="body">' + memo.body.map(p => '<p>' + esc(p) + '</p>').join('') + '</div>' +
          (fresh.length ? '<div class="new-rules"><p class="eyebrow" style="color:var(--paper-muted)">New in the policy today</p><ul>' +
            fresh.map(id => '<li><span class="para">' + para(id) + '</span><span><b>' + esc(V.RULES[id].short) + '.</b> ' + esc(V.RULES[id].text) + '</span></li>').join('') +
          '</ul></div>' : '') +
          '<p class="sig">H. Asmussen</p>' +
        '</article>' +
        '<div class="memo-actions">' +
          '<button class="btn primary" data-action="start" id="btn-start">Start the shift <span class="key">Enter</span></button>' +
          '<span class="hint">' + day.tickets + ' tickets' + (S.relaxed ? ', no clock' : ', 09:00 to 17:00') + '</span>' +
          '<button class="btn" data-action="title" style="margin-left:auto">Back</button>' +
        '</div>' +
      '</main>', '#btn-start');
  }

  function startShift() {
    S.screen = 'shift';
    S.tickets = V.generateDay(S.world, S.dayN);
    S.idx = 0;
    S.dayResults = [];
    S.elapsed = 0;
    S.paused = false;
    S.busy = false;
    S.denyOpen = false;
    S.slip = null;
    S.tab = 'record';
    S.query = '';
    S.selected = S.tickets[0].requester;
    renderShift(true);
    startClock();
    Sound.paper();
  }

  // ---------- shift rendering ----------

  function ticketHtml(t) {
    const w = S.world;
    const e = w.ents[t.ent];
    const k = KIND_LABEL[t.kind];
    const entLine = '<code>' + esc(t.ent) + '</code> <span class="ent-name">' + esc(e.name) + '</span>' +
      '<span class="sub">' + esc(e.dept ? V.DEPTS[e.dept] : 'Any department') + '</span>' +
      '<span class="risk ' + e.risk + '">' + (e.risk === 'high' ? 'High risk' : 'Low risk') + '</span>';
    const reqLabel = t.kind === 'recert' ? 'Holder' : 'Requester';
    const reqLine = refBtn(t.requester, t.requesterName) + (t.kind === 'agent' ? ' <span class="kind-tag">Agent</span>' : '');
    let rows = '<div><dt>' + reqLabel + '</dt><dd>' + reqLine + '</dd></div>' +
      '<div><dt>' + (t.kind === 'recert' ? 'Access held' : 'Access') + '</dt><dd>' + entLine + '</dd></div>';
    if (t.kind === 'recert') {
      rows += '<div><dt>Granted</dt><dd class="mono">' + esc(t.grantedOn) + '</dd></div>';
    } else {
      rows += '<div><dt>Until</dt><dd class="mono">' + (t.until ? esc(t.until) : 'No end date') + '</dd></div>';
      rows += '<div><dt>Approved by</dt><dd>' + (t.approvals.length ? t.approvals.map(id => {
        const x = V.lookup(w, id);
        return refBtn(id, x ? x.name : id);
      }).join('<span class="sub">and</span>') : '<span class="sub">Nobody</span>') + '</dd></div>';
    }
    return '<article class="ticket' + (reduceMotion.matches ? '' : ' enter') + '" data-kind="' + t.kind + '" aria-label="Ticket ' + esc(t.id) + '">' +
      '<div class="form-head"><span class="form-name">' + esc(k.form) + ' <em>· ' + esc(k.en) + '</em></span><span class="form-meta">' + esc(k.meta) + '</span></div>' +
      '<div class="tid">' + esc(t.id) + '</div>' +
      '<dl class="fields">' + rows + '</dl>' +
      '<p class="justification">' + esc(t.text) + '</p>' +
      '<div class="stamp" id="stamp" hidden></div>' +
    '</article>';
  }

  function autoReviewHtml(t) {
    const ar = t.autoReview;
    if (!ar) return '';
    const what = ar.rec === 'approve'
      ? '<b class="approve">' + (t.kind === 'recert' ? 'Keep' : 'Approve') + '</b>'
      : '<b class="deny">' + (t.kind === 'recert' ? 'Revoke' : 'Deny') + '</b> ' + para(ar.reason) + ' ' + esc(V.RULES[ar.reason].short);
    return '<aside class="autoreview" aria-label="AutoReview recommendation">' +
      '<span class="who">AutoReview</span><span class="rec">recommends ' + what + '</span><span class="conf">' + ar.confidence + '% sure</span>' +
      '<span class="note">' + esc(ar.note) + '</span>' +
    '</aside>';
  }

  function actionsHtml(t) {
    if (S.denyOpen) {
      const rules = V.activeRules(S.dayN);
      return '<div class="reasons" role="group" aria-label="Cite the rule">' +
        '<div class="reasons-head"><b>' + (t.kind === 'recert' ? 'Revoke' : 'Deny') + ' under which rule?</b><button class="btn" data-action="cancel-deny">Cancel <span class="key">Esc</span></button></div>' +
        '<div class="reasons-grid">' + rules.map((id, i) =>
          '<button class="reason" data-action="deny-reason" data-reason="' + id + '"><span class="para">' + para(id) + '</span><span>' + esc(V.RULES[id].short) + '</span><span class="key">' + REASON_KEYS[i] + '</span></button>'
        ).join('') + '</div>' +
      '</div>';
    }
    return '<div class="actions">' +
      '<button class="btn approve" data-action="approve" id="btn-approve">' + (t.kind === 'recert' ? 'Keep' : 'Approve') + ' <span class="key">A</span></button>' +
      '<button class="btn deny" data-action="deny" id="btn-deny">' + (t.kind === 'recert' ? 'Revoke' : 'Deny') + ' <span class="key">D</span></button>' +
    '</div>';
  }

  function slipHtml() {
    const r = S.slip;
    if (!r) return '<div class="slip idle">Your last stamp shows up here, with the evidence when it went wrong.</div>';
    const tags = { correct: 'Correct', missed: 'Audit finding', 'false-deny': 'Clean request blocked', 'wrong-reason': 'Right call, wrong rule' };
    let body = '';
    if (r.outcome === 'missed') body = 'Approved, but ' + para(r.rule) + ' ' + V.RULES[r.rule].short + '. ' + r.evidence;
    else if (r.outcome === 'wrong-reason') body = 'You cited ' + para(r.reason) + '. The real problem was ' + para(r.rule) + '. ' + r.evidence;
    else if (r.outcome === 'false-deny') body = 'Nothing in policy blocks ' + r.ticket + '. ' + para(r.reason) + ' does not apply. Someone now waits a day for access they should have.';
    else if (r.action === 'deny') body = r.evidence;
    return '<div class="slip ' + r.outcome + '" role="status">' +
      '<div class="head"><span class="tag">' + tags[r.outcome] + '</span><span class="mono">' + esc(r.ticket) + '</span><span class="pts">' + signed(r.points) + '</span></div>' +
      (body ? '<p>' + esc(body) + '</p>' : '') +
    '</div>';
  }

  function topbarHtml() {
    const day = V.DAYS[S.dayN - 1];
    const left = S.tickets.length - S.idx;
    return '<header class="topbar">' +
      '<span class="brand" aria-label="Vierauge"><i></i>Vierauge</span>' +
      '<div class="dayinfo"><b>Day ' + S.dayN + ' · ' + esc(day.weekday) + '</b><span>Today <em>' + day.date + '</em></span></div>' +
      (S.relaxed ? '<div class="clock"><span class="time">--:--</span><span class="hint" style="font-size:11px">Relaxed</span></div>'
        : '<div class="clock" id="clock"><span class="time" id="clock-time">09:00</span><span class="bar"><i id="clock-bar"></i></span></div>') +
      '<div class="stats">' +
        '<div class="stat"><b id="stat-left">' + left + '</b><span>Waiting</span></div>' +
        '<div class="stat"><b id="stat-score">' + (S.run.score + dayPoints()) + '</b><span>Points</span></div>' +
      '</div>' +
      '<div class="tools">' +
        '<button class="icon-btn" data-action="sound" aria-label="' + (Sound.on ? 'Mute sound' : 'Turn sound on') + '" title="Sound">' + (Sound.on ? ICON.sound : ICON.mute) + '</button>' +
        '<button class="icon-btn" data-action="theme" aria-label="Switch light or dark" title="Theme">' + ICON.theme + '</button>' +
        (S.relaxed ? '' : '<button class="icon-btn" data-action="pause" aria-label="Pause" title="Pause (P)">' + ICON.pause + '</button>') +
      '</div>' +
    '</header>';
  }

  const ICON = {
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    mute: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
  };

  function refBtn(id, name) {
    return '<button class="ref" data-ref="' + esc(id) + '">' + esc(name) + ' <code>' + esc(id) + '</code></button>';
  }

  function dayPoints() { return S.dayResults.reduce((s, r) => s + r.points, 0); }

  function renderShift(first) {
    const t = S.tickets[S.idx];
    const html = topbarHtml() +
      '<main class="desk">' +
        '<section class="work" aria-label="Current ticket">' +
          ticketHtml(t) + autoReviewHtml(t) +
          '<div id="actions">' + actionsHtml(t) + '</div>' +
          slipHtml() +
        '</section>' +
        '<aside class="drawer" aria-label="Records">' + drawerHtml() + '</aside>' +
      '</main>' +
      (S.paused ? pausedHtml() : '');
    app.innerHTML = html;
    if (first || window.matchMedia('(max-width: 900px)').matches) window.scrollTo(0, 0);
    tickClock(true);
  }

  function rerenderActions() {
    const el = document.getElementById('actions');
    if (el) el.innerHTML = actionsHtml(S.tickets[S.idx]);
    const first = el && el.querySelector('button');
    if (first) first.focus({ preventScroll: true });
  }

  function pausedHtml() {
    return '<div class="paused-veil"><div class="paused-card" role="dialog" aria-modal="true" aria-label="Paused">' +
      '<p class="eyebrow">Shift paused</p><h2>Coffee break</h2><p>The desk is covered while the clock is stopped, so no reading ahead.</p>' +
      '<button class="btn primary" data-action="resume" id="btn-resume">Back to the desk <span class="key">P</span></button>' +
      '<button class="btn" data-action="title">Leave the shift</button>' +
      '<p class="hint">Leaving loses today\'s stamps. The week resumes this morning.</p>' +
    '</div></div>';
  }

  // ---------- the records drawer ----------

  function drawerHtml() {
    const tabs = [['record', 'Record', 'R'], ['directory', 'Directory', '/'], ['catalogue', 'Catalogue', 'C'], ['rules', 'Policy', 'L']];
    return '<div class="tabs" role="tablist">' + tabs.map(([id, label, key]) =>
      '<button class="tab" role="tab" data-tab="' + id + '" aria-selected="' + (S.tab === id) + '">' + label + '<span class="key">' + key + '</span></button>'
    ).join('') + '</div>' +
    '<div class="panel" id="panel" role="tabpanel">' + panelHtml() + '</div>';
  }

  function rerenderDrawer(focusSearch) {
    const d = app.querySelector('.drawer');
    if (!d) return;
    d.innerHTML = drawerHtml();
    if (focusSearch) {
      const s = document.getElementById('dir-search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }
  }

  function panelHtml() {
    if (S.tab === 'directory') return directoryHtml();
    if (S.tab === 'catalogue') return catalogueHtml();
    if (S.tab === 'rules') return rulesHtml();
    return recordHtml(S.selected);
  }

  function entChip(code, hl) {
    const e = S.world.ents[code];
    const title = e ? e.name + ' · ' + (e.dept ? V.DEPTS[e.dept] : 'any department') + ' · ' + e.risk + ' risk' : code;
    return '<span class="chip' + (hl ? ' hl' : '') + '" title="' + esc(title) + '">' + esc(code) + '</span>';
  }

  function recordHtml(id) {
    const w = S.world;
    const t = S.tickets[S.idx];
    if (!id) return '<p class="hint">Click a name or ID on the ticket to pull its record.</p>';
    const p = w.byId[id];
    const a = w.agentsById[id];
    if (!p && !a) {
      const agentish = id.startsWith('AG-');
      return '<div class="missing"><b>No record for ' + esc(id) + '</b><p>' +
        (agentish ? 'The agent registry has no entry with this ID.' : 'HR has no identity with this ID. A name on a ticket proves nothing on its own.') +
        '</p></div>';
    }
    if (a) {
      const owner = w.byId[a.owner];
      const parent = a.parent ? w.agentsById[a.parent] : null;
      const children = w.agents.filter(x => x.parent === a.id);
      return '<div class="record-head"><div class="avatar agent" aria-hidden="true">' + esc(initials(a.name)) + '</div><div><h3>' + esc(a.name) + '</h3><p>' + (parent ? 'Sub-agent' : 'Agent') + ' · <span class="mono">' + esc(a.id) + '</span></p></div></div>' +
        '<dl class="kv">' +
          '<div><dt>Purpose</dt><dd>' + esc(a.purpose) + '</dd></div>' +
          '<div><dt>Owner</dt><dd>' + (owner ? refBtn(owner.id, owner.name) : esc(a.owner)) + '</dd></div>' +
          (parent ? '<div><dt>Parent</dt><dd>' + refBtn(parent.id, parent.name) + '</dd></div>' : '') +
          (children.length ? '<div><dt>Sub-agents</dt><dd>' + children.map(c => refBtn(c.id, c.name)).join('') + '</dd></div>' : '') +
          '<div><dt>Registered until</dt><dd class="mono">' + esc(a.expires) + '</dd></div>' +
          '<div><dt>Registered scopes</dt><dd>' + a.scopes.map(c => entChip(c, t && c === t.ent)).join('') + '</dd></div>' +
          '<div><dt>Holds now</dt><dd>' + (a.holds.length ? a.holds.map(c => entChip(c, t && c === t.ent)).join('') : '<span class="hint">Nothing</span>') + '</dd></div>' +
        '</dl>';
    }
    const mgr = p.managerId ? w.byId[p.managerId] : null;
    const owns = Object.values(w.ents).filter(e => e.owner === p.id).map(e => e.code);
    const agentsOwned = S.dayN >= 3 ? w.agents.filter(x => x.owner === p.id) : [];
    const reports = w.people.filter(x => x.managerId === p.id).length;
    return '<div class="record-head"><div class="avatar" aria-hidden="true">' + esc(initials(p.name)) + '</div><div><h3>' + esc(p.name) + '</h3><p>' + esc(p.title) + ' · <span class="mono">' + esc(p.id) + '</span></p></div></div>' +
      '<dl class="kv">' +
        '<div><dt>Status</dt><dd>' + (p.status === 'active' ? '<span class="pill active">Active</span>' : '<span class="pill left">Left</span> <span class="mono">' + esc(p.leftOn) + '</span>') + '</dd></div>' +
        '<div><dt>Department</dt><dd>' + esc(p.dept === 'BRD' ? 'Executive Board' : V.DEPTS[p.dept]) + '</dd></div>' +
        (p.previousDept ? '<div><dt>Moved</dt><dd>From ' + esc(V.DEPTS[p.previousDept]) + ' on <span class="mono">' + esc(p.movedOn) + '</span></dd></div>' : '') +
        '<div><dt>Contract</dt><dd>' + (p.type === 'contractor' ? 'Contractor, ends <span class="mono">' + esc(p.contractEnd) + '</span>' : 'Employee') + '</dd></div>' +
        '<div><dt>Line manager</dt><dd>' + (mgr ? refBtn(mgr.id, mgr.name) : '<span class="hint">Reports to the supervisory board</span>') + '</dd></div>' +
        (reports ? '<div><dt>Team</dt><dd>' + reports + ' direct report' + (reports === 1 ? '' : 's') + '</dd></div>' : '') +
        '<div><dt>Holds now</dt><dd>' + (p.holds.length ? p.holds.map(c => entChip(c, t && c === t.ent)).join('') : '<span class="hint">Nothing</span>') + '</dd></div>' +
        (owns.length ? '<div><dt>Owner of</dt><dd>' + owns.map(c => entChip(c, t && c === t.ent)).join('') + '</dd></div>' : '') +
        (agentsOwned.length ? '<div><dt>Owns agents</dt><dd>' + agentsOwned.map(x => refBtn(x.id, x.name)).join('') + '</dd></div>' : '') +
      '</dl>';
  }

  function directoryHtml() {
    const w = S.world;
    const q = S.query.trim().toLowerCase();
    const rows = w.people.map(p => ({ id: p.id, name: p.name, dept: p.dept === 'BRD' ? 'Board' : V.DEPTS[p.dept], left: p.status !== 'active' }))
      .concat(S.dayN >= 3 ? w.agents.map(a => ({ id: a.id, name: a.name, dept: 'Agent · ' + V.DEPTS[a.dept], left: false })) : [])
      .filter(r => !q || (r.id + ' ' + r.name + ' ' + r.dept).toLowerCase().includes(q))
      .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    return '<label class="sr-only" for="dir-search">Search the directory</label>' +
      '<input class="search" id="dir-search" type="search" placeholder="Search name, ID or department" autocomplete="off" value="' + esc(S.query) + '">' +
      '<ul class="dir" id="dir-list">' + dirRows(rows) + '</ul>';
  }

  function dirRows(rows) {
    if (!rows.length) return '<li class="hint" style="padding:8px">Nobody matches. An ID that is not here does not exist.</li>';
    return rows.map(r => '<li><button data-ref="' + esc(r.id) + '"><code>' + esc(r.id) + '</code><span>' + esc(r.name) + (r.left ? ' <span class="gone">(left)</span>' : '') + '</span><span class="dept">' + esc(r.dept) + '</span></button></li>').join('');
  }

  function catalogueHtml() {
    const w = S.world;
    const t = S.tickets[S.idx];
    const groups = Object.keys(V.DEPTS).map(d => [V.DEPTS[d], Object.values(w.ents).filter(e => e.dept === d)])
      .concat([['Any department', Object.values(w.ents).filter(e => !e.dept)]]);
    const table = '<div class="table-wrap"><table class="cat"><thead><tr><th>Code</th><th>Access</th><th>Risk</th><th>Owner</th></tr></thead><tbody>' +
      groups.map(([name, ents]) => '<tr class="group"><td colspan="4">' + esc(name) + '</td></tr>' + ents.map(e => {
        const o = w.byId[e.owner];
        return '<tr><td>' + entChip(e.code, t && e.code === t.ent) + '</td><td>' + esc(e.name) + '</td><td><span class="' + e.risk + '">' + e.risk + '</span></td><td>' + refBtn(o.id, o.name) + '</td></tr>';
      }).join('')).join('') + '</tbody></table></div>';
    const pairs = S.dayN >= 2
      ? '<div><p class="eyebrow">Toxic pairs · never in one hand</p><ul class="pairs" style="margin-top:8px">' + V.PAIRS.map(([a, b]) =>
          '<li>' + entChip(a, t && a === t.ent) + '<span class="x" aria-label="with">×</span>' + entChip(b, t && b === t.ent) + '</li>').join('') + '</ul></div>'
      : '';
    return pairs + table;
  }

  function rulesHtml() {
    const rules = V.activeRules(S.dayN);
    return '<p class="eyebrow">Policy in force · ' + rules.length + ' rules</p><ol class="rules">' + rules.map(id =>
      '<li><span class="para">' + para(id) + '</span><div><b>' + esc(V.RULES[id].short) + '</b>' + (V.RULES[id].day === S.dayN ? '<span class="new">new today</span>' : '') + '<p>' + esc(V.RULES[id].text) + '</p></div></li>'
    ).join('') + '</ol>' +
    '<p class="hint">Points: clean approval +' + V.POINTS.approve + ', correct denial with the right rule +' + V.POINTS.deny + ', right call with the wrong rule +' + V.POINTS.wrongReason +
    ', clean request denied ' + V.POINTS.falseDeny + ', violation approved ' + V.POINTS.missed + ', left in the queue at 17:00 ' + V.POINTS.unprocessed + '.</p>';
  }

  // ---------- decisions ----------

  function decide(action, reason) {
    if (S.screen !== 'shift' || S.busy || S.paused) return;
    const t = S.tickets[S.idx];
    if (!t) return;
    S.busy = true;
    S.denyOpen = false;
    const res = V.judge(t, { action, reason });
    res.ar = t.autoReview ? { rec: t.autoReview.rec, correct: V.autoReviewCorrect(t) } : null;
    res.who = t.requesterName;
    res.ent = t.ent;
    res.kindLabel = KIND_LABEL[t.kind].en;
    S.dayResults.push(res);
    S.slip = res;

    const stamp = document.getElementById('stamp');
    if (stamp) {
      stamp.className = 'stamp ' + (action === 'approve' ? 'ok' : 'bad') + ' hit';
      stamp.innerHTML = esc(STAMP[action][t.kind]) + (reason ? '<small>' + esc(para(reason)) + ' ' + esc(V.RULES[reason].short) + '</small>' : '');
      stamp.hidden = false;
    }
    const actions = document.getElementById('actions');
    if (actions) actions.innerHTML = '';
    Sound.stamp();
    if (res.outcome === 'correct') Sound.good(); else Sound.bad();
    const tag = { correct: 'Correct', missed: 'Audit finding', 'false-deny': 'Clean request blocked', 'wrong-reason': 'Right call, wrong rule' }[res.outcome];
    say(tag + '. ' + signed(res.points) + ' points.');

    setTimeout(() => {
      S.idx++;
      S.busy = false;
      if (S.screen !== 'shift') return;
      if (S.idx >= S.tickets.length) return endShift();
      S.selected = S.tickets[S.idx].requester;
      if (S.tab !== 'record' && S.tab !== 'rules') S.tab = 'record';
      renderShift();
      Sound.paper();
      const first = document.getElementById('btn-approve');
      if (first) first.focus({ preventScroll: true });
    }, reduceMotion.matches ? 350 : 820);
  }

  function endShift() {
    stopClock();
    for (let i = S.idx; i < S.tickets.length; i++) {
      const t = S.tickets[i];
      S.dayResults.push({ ticket: t.id, kind: t.kind, outcome: 'unprocessed', points: V.POINTS.unprocessed,
        violations: t.violations.slice(), who: t.requesterName, ent: t.ent, kindLabel: KIND_LABEL[t.kind].en, ar: null });
    }
    S.idx = S.tickets.length;
    S.run.days[S.dayN - 1] = S.dayResults;
    S.run.score = S.run.days.reduce((s, d) => s + (d ? d.reduce((x, r) => x + r.points, 0) : 0), 0);
    S.run.nextDay = S.dayN + 1;
    store.set('run', S.run);
    Sound.bell();
    showReport();
  }

  // ---------- reports ----------

  function findingRow(r) {
    const map = {
      missed: ['missed', 'Finding'],
      'wrong-reason': ['warn', 'Wrong rule'],
      'false-deny': ['warn', 'Friction'],
      unprocessed: ['dim', 'Unprocessed'],
    };
    const [cls, label] = map[r.outcome];
    let text = '';
    if (r.outcome === 'missed') text = 'Approved despite ' + para(r.rule) + ' ' + V.RULES[r.rule].short + '. ' + r.evidence;
    else if (r.outcome === 'wrong-reason') text = 'Denied under ' + para(r.reason) + ', the actual breach was ' + para(r.rule) + '. ' + r.evidence;
    else if (r.outcome === 'false-deny') text = 'Denied under ' + para(r.reason) + ', but the request was clean.';
    else text = 'Still in the queue at 17:00' + (r.violations.length ? ', and it was a ' + V.RULES[r.violations[0]].short.toLowerCase() + ' case.' : '.');
    return '<li><span class="sev ' + cls + '">' + label + '</span><div class="what"><b><span class="mono">' + esc(r.ticket) + '</span> · ' + esc(r.kindLabel) + ', ' + esc(r.who) + ', <span class="mono">' + esc(r.ent) + '</span></b><p>' + esc(text) + '</p></div><span class="pts">' + signed(r.points) + '</span></li>';
  }

  function showReport() {
    S.screen = 'report';
    const s = V.summarize(S.dayResults);
    const day = V.DAYS[S.dayN - 1];
    const issues = S.dayResults.filter(r => r.outcome !== 'correct');
    const last = S.dayN === 5;
    const ar = s.arSeen
      ? '<section class="machine-card" aria-label="AutoReview today"><p class="eyebrow">AutoReview today</p>' +
          '<p>Right on ' + s.arRight + ' of ' + s.arSeen + ' tickets you stamped (' + pct(s.arRight, s.arSeen) + '%). ' +
          (s.arWrong ? 'It was wrong ' + s.arWrong + ' time' + (s.arWrong === 1 ? '' : 's') + '. You went along with it on ' + s.followedWrong + ' of those and overruled it on ' + s.overrodeWrong + '.' : 'It made no mistakes on your desk today.') + '</p></section>'
      : '';
    render(
      '<main class="report">' +
        '<p class="eyebrow">Day ' + S.dayN + ' · ' + esc(day.weekday) + ' · shift report</p>' +
        '<h1>' + (!issues.length ? 'A clean ' + esc(day.weekday) + '.' : s.missed === 0 ? 'Nothing slipped through.' : s.missed === 1 ? 'One thing got through.' : s.missed + ' things got through.') + '</h1>' +
        '<div class="tiles">' +
          '<div class="tile"><b>' + s.processed + '/' + S.tickets.length + '</b><span>Stamped</span></div>' +
          '<div class="tile ok"><b>' + s.correct + '</b><span>Correct</span></div>' +
          '<div class="tile ' + (s.missed ? 'bad' : 'ok') + '"><b>' + s.missed + '</b><span>Violations approved</span></div>' +
          '<div class="tile"><b>' + signed(s.points) + '</b><span>Points today · ' + S.run.score + ' this week</span></div>' +
        '</div>' +
        ar +
        '<section><p class="eyebrow">What the auditor will read</p>' +
          (issues.length ? '<ul class="findings">' + issues.map(findingRow).join('') + '</ul>' : '<p class="clean-day" style="margin-top:10px">Every stamp held up. Nothing to write down.</p>') +
        '</section>' +
        '<div class="memo-actions">' +
          '<button class="btn primary" data-action="' + (last ? 'final' : 'next') + '" id="btn-next">' + (last ? 'Read the audit report' : 'Go home, come back ' + esc(V.DAYS[S.dayN].weekday)) + ' <span class="key">Enter</span></button>' +
          '<button class="btn" data-action="title">Main menu</button>' +
        '</div>' +
      '</main>', '#btn-next');
  }

  function showFinal() {
    stopEyes();
    S.screen = 'final';
    const all = S.run.days.flat().filter(Boolean);
    const s = V.summarize(all);
    const op = V.opinion(s);
    const measured = pct(s.arRight, s.arSeen);
    const best = store.get('best', null);
    if (!S.run.recorded) {
      if (!best || S.run.score > best.score) store.set('best', { score: S.run.score, opinion: op.label.toLowerCase() });
      S.run.recorded = true;
      store.set('run', S.run);
    }
    const rows = S.run.days.map((d, i) => {
      const x = V.summarize(d || []);
      return '<tr><td>' + V.DAYS[i].weekday + '</td><td class="num">' + x.processed + '</td><td class="num">' + x.correct + '</td><td class="num">' + x.missed + '</td><td class="num">' + (x.falseDeny + x.wrongReason) + '</td><td class="num">' + signed(x.points) + '</td></tr>';
    }).join('');
    const bias = s.arWrong
      ? 'AutoReview was wrong ' + s.arWrong + ' times on your desk. You followed it ' + s.followedWrong + ' of those times (' + pct(s.followedWrong, s.arWrong) + '%). That share is your automation bias, measured on your own decisions and on nothing else.'
      : 'AutoReview made no mistakes on the tickets you stamped, so this week cannot say anything about your automation bias.';
    render(
      '<main class="report">' +
        '<p class="eyebrow">External audit · week of 19 October 2026</p>' +
        '<h1>' + esc(op.label) + '</h1>' +
        '<div class="opinion ' + op.tone + '"><b>' + S.run.score + ' points</b><p>' + esc(op.text) + '</p></div>' +
        (s.arSeen ? '<section class="machine-card" aria-label="AutoReview against its claim">' +
          '<p class="eyebrow">AutoReview · claim against evidence</p>' +
          '<div class="vs"><div><b>' + V.VENDOR_CLAIM + '%</b><span>Vendor benchmark, as written in the brochure</span></div><div><b>' + measured + '%</b><span>Measured on your desk: ' + s.arRight + ' of ' + s.arSeen + ' tickets, Wednesday to Friday</span></div></div>' +
          '<div class="meter" role="img" aria-label="Measured ' + measured + ' percent against a claimed ' + V.VENDOR_CLAIM + ' percent"><i style="width:' + measured + '%"></i><span class="claim" style="left:' + V.VENDOR_CLAIM + '%"></span></div>' +
          '<p>' + esc(bias) + '</p>' +
          '<p>' + s.arSeen + ' tickets is a small sample, enough to doubt the brochure and not enough to replace it with a number of our own. Every prompt-injection ticket fooled it, by design: text that talks to the reviewer is exactly what a model reads as an instruction.</p>' +
        '</section>' : '') +
        '<section><p class="eyebrow">The week</p><div class="table-wrap"><table class="days-table"><thead><tr><th>Day</th><th class="num">Stamped</th><th class="num">Correct</th><th class="num">Violations approved</th><th class="num">Friction</th><th class="num">Points</th></tr></thead><tbody>' + rows + '</tbody></table></div></section>' +
        '<div class="memo-actions">' +
          '<button class="btn primary" data-action="new" id="btn-again">New week, new bank staff <span class="key">Enter</span></button>' +
          '<button class="btn" data-action="title">Main menu</button>' +
        '</div>' +
      '</main>', '#btn-again');
  }

  // ---------- clock ----------

  let raf = 0;
  function startClock() {
    stopClock();
    if (S.relaxed) return;
    S.lastTs = performance.now();
    const loop = ts => {
      if (S.screen !== 'shift') return;
      const dt = Math.min(0.25, (ts - S.lastTs) / 1000);
      S.lastTs = ts;
      if (!S.paused && !document.hidden) S.elapsed += dt;
      tickClock(false);
      const total = V.DAYS[S.dayN - 1].seconds;
      if (S.elapsed >= total && !S.busy) { endShift(); return; }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
  function stopClock() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  let lastMinute = -1;
  function tickClock(force) {
    if (S.relaxed) return;
    const total = V.DAYS[S.dayN - 1].seconds;
    const f = Math.min(1, S.elapsed / total);
    const minutes = Math.floor(f * 480);
    const bar = document.getElementById('clock-bar');
    if (bar) bar.style.width = (f * 100).toFixed(2) + '%';
    if (!force && minutes === lastMinute) return;
    lastMinute = minutes;
    const h = 9 + Math.floor(minutes / 60);
    const m = minutes % 60;
    const el = document.getElementById('clock-time');
    if (el) el.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    const c = document.getElementById('clock');
    if (c) c.classList.toggle('late', minutes >= 420);
  }

  function setPaused(p) {
    if (S.relaxed || S.screen !== 'shift') return;
    S.paused = p;
    renderShift();
    if (p) { const b = document.getElementById('btn-resume'); if (b) b.focus(); }
  }

  // ---------- title eyes ----------

  let eyesOn = false;
  function onPointer(e) {
    document.querySelectorAll('.eye').forEach(eye => {
      const r = eye.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 260) * (r.width * 0.22);
      eye.firstChild.style.transform = 'translate(' + (dx / d * k).toFixed(1) + 'px,' + (dy / d * k).toFixed(1) + 'px)';
    });
  }
  function startEyes() {
    if (eyesOn || reduceMotion.matches) return;
    eyesOn = true;
    window.addEventListener('pointermove', onPointer, { passive: true });
  }
  function stopEyes() {
    if (!eyesOn) return;
    eyesOn = false;
    window.removeEventListener('pointermove', onPointer);
  }

  // ---------- theme ----------

  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    store.set('theme', next);
  }

  // ---------- input ----------

  app.addEventListener('click', e => {
    const ref = e.target.closest('[data-ref]');
    if (ref && S.screen === 'shift') {
      S.selected = ref.getAttribute('data-ref');
      S.tab = 'record';
      rerenderDrawer();
      const panel = document.getElementById('panel');
      if (panel) panel.scrollTop = 0;
      if (window.matchMedia('(max-width: 900px)').matches) {
        const d = app.querySelector('.drawer');
        if (d && ref.closest('.work')) d.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
      }
      return;
    }
    const tab = e.target.closest('[data-tab]');
    if (tab) { S.tab = tab.getAttribute('data-tab'); rerenderDrawer(S.tab === 'directory'); return; }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    Sound.ensure();
    const a = btn.getAttribute('data-action');
    switch (a) {
      case 'new': newRun(); break;
      case 'continue': continueRun(); break;
      case 'final': showFinal(); break;
      case 'title': stopClock(); S.paused = false; titleScreen(); break;
      case 'start': startShift(); break;
      case 'next': openBrief(); break;
      case 'approve': decide('approve'); break;
      case 'deny': S.denyOpen = true; rerenderActions(); break;
      case 'cancel-deny': S.denyOpen = false; rerenderActions(); break;
      case 'deny-reason': decide('deny', btn.getAttribute('data-reason')); break;
      case 'pause': setPaused(true); break;
      case 'resume': setPaused(false); break;
      case 'sound':
        Sound.on = !Sound.on; store.set('sound', Sound.on);
        btn.innerHTML = Sound.on ? ICON.sound : ICON.mute;
        btn.setAttribute('aria-label', Sound.on ? 'Mute sound' : 'Turn sound on');
        break;
      case 'theme': toggleTheme(); break;
    }
  });

  app.addEventListener('change', e => {
    if (e.target.id === 'relaxed') {
      S.relaxed = e.target.checked;
      store.set('relaxed', S.relaxed);
    }
  });

  app.addEventListener('input', e => {
    if (e.target.id === 'dir-search') {
      S.query = e.target.value;
      const list = document.getElementById('dir-list');
      if (list) {
        const tmp = document.createElement('div');
        tmp.innerHTML = directoryHtml();
        list.innerHTML = tmp.querySelector('#dir-list').innerHTML;
      }
    }
  });

  document.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');
    if (typing) {
      if (e.key === 'Escape') { e.target.blur(); }
      return;
    }
    const k = e.key;
    if (S.screen === 'shift') {
      if (k === 'p' || k === 'P') { e.preventDefault(); setPaused(!S.paused); return; }
      if (S.paused || S.busy) return;
      if (S.denyOpen) {
        if (k === 'Escape') { S.denyOpen = false; rerenderActions(); return; }
        const i = REASON_KEYS.indexOf(k);
        const rules = V.activeRules(S.dayN);
        if (i >= 0 && i < rules.length) { e.preventDefault(); decide('deny', rules[i]); }
        return;
      }
      if (k === 'a' || k === 'A') { e.preventDefault(); decide('approve'); return; }
      if (k === 'd' || k === 'D') { e.preventDefault(); S.denyOpen = true; rerenderActions(); return; }
      if (k === 'r' || k === 'R') { S.tab = 'record'; S.selected = S.tickets[S.idx].requester; rerenderDrawer(); return; }
      if (k === 'c' || k === 'C') { S.tab = 'catalogue'; rerenderDrawer(); return; }
      if (k === 'l' || k === 'L') { S.tab = 'rules'; rerenderDrawer(); return; }
      if (k === '/') { e.preventDefault(); S.tab = 'directory'; rerenderDrawer(true); return; }
      return;
    }
    if (k === 'Enter' && document.activeElement === document.body) {
      const primary = app.querySelector('.btn.primary');
      if (primary) { e.preventDefault(); primary.click(); }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && S.screen === 'shift' && !S.paused && !S.relaxed) setPaused(true);
  });

  // ---------- boot ----------

  applyTheme(store.get('theme', null));
  titleScreen();
})();
