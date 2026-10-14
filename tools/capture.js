// Renders every release asset from the real game with headless Chrome over the
// DevTools protocol. No dependencies: Node 22+ (global fetch and WebSocket) and a
// local Chrome. Run: npm run assets   (set CHROME=/path/to/chrome to override)
//
// Writes:
//   public/icon-512.png, public/apple-touch-icon.png, public/og.png
//   docs/assets/icon-1024.png, docs/assets/social-preview.png
//   docs/screenshots/*.png   (and .webp + -small.webp with --webp, for the portfolio)
//
// Screenshots are real play: a fixed seed, a saved week, and decisions taken from
// the engine's own verdicts, so every ticket on screen is one the game generated.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const V = require('../public/engine.js');

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9339;
const WEBP = process.argv.includes('--webp');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = rel => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
const fileUrl = rel => 'file://' + path.join(ROOT, rel).split(path.sep).map(encodeURIComponent).join('/');

// ---------- a very small DevTools client ----------

let ws;
let nextId = 0;
const pending = new Map();
const listeners = new Set();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
        ws.onmessage = ev => {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            const p = pending.get(m.id);
            pending.delete(m.id);
            if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
          } else if (m.method) listeners.forEach(l => l(m));
        };
        return;
      }
    } catch (e) { /* Chrome is still starting */ }
    await sleep(250);
  }
  throw new Error('Chrome did not open a debugging port. Set CHROME to your Chrome binary.');
}

async function load(url) {
  const done = new Promise(resolve => {
    const l = m => { if (m.method === 'Page.loadEventFired') { listeners.delete(l); resolve(); } };
    listeners.add(l);
  });
  await send('Page.navigate', { url });
  await done;
  await sleep(250);
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
  return r.result.value;
}

async function viewport(width, height, scale, mobile) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: !!mobile });
}

async function media(scheme, reduced) {
  await send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-color-scheme', value: scheme },
    { name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' },
  ] });
}

async function shot(rel, transparent) {
  if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (transparent) await send('Emulation.setDefaultBackgroundColorOverride', {});
  fs.writeFileSync(out(rel), Buffer.from(r.data, 'base64'));
  console.log('  ' + rel);
  return r.data;
}

// Re-encode a PNG as WebP in the page itself (Chrome has the encoder; this Mac has no cwebp).
async function webp(pngBase64, rel, width) {
  const data = await evaluate(`new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = ${width}, h = Math.round(img.height * w / img.width);
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/webp', 0.86).split(',')[1]);
    };
    img.onerror = reject;
    img.src = 'data:image/png;base64,${pngBase64}';
  })`);
  fs.writeFileSync(out(rel), Buffer.from(data, 'base64'));
  console.log('  ' + rel);
}

// ---------- driving the game ----------

const REASON_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'];

async function saveRun(run, theme) {
  await evaluate(`(() => {
    localStorage.clear();
    localStorage.setItem('vierauge:run', ${JSON.stringify(JSON.stringify(run))});
    localStorage.setItem('vierauge:relaxed', ${JSON.stringify(String(!!run.relaxed))});
    localStorage.setItem('vierauge:sound', 'false');
    ${theme ? `localStorage.setItem('vierauge:theme', '"${theme}"');` : ''}
  })()`);
}

const click = sel => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing ${sel}'); el.click(); })()`);
const key = k => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`);

async function waitFor(expr, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(`!!(${expr})`)) return;
    await sleep(60);
  }
  throw new Error('timed out waiting for ' + expr);
}

// Stamp ticket i of day d. follow: take AutoReview's advice instead of the truth.
async function stamp(ticket, dayN, follow) {
  const before = await evaluate(`document.querySelector('.tid') && document.querySelector('.tid').textContent`);
  let action = ticket.violations.length ? 'deny' : 'approve';
  let reason = ticket.violations[0];
  if (follow && ticket.autoReview) { action = ticket.autoReview.rec; reason = ticket.autoReview.reason; }
  if (action === 'approve') await key('a');
  else { await key('d'); await sleep(60); await key(REASON_KEYS[V.activeRules(dayN).indexOf(reason)]); }
  await waitFor(`!document.querySelector('.tid') || document.querySelector('.tid').textContent !== ${JSON.stringify(before)}`);
  await sleep(120);
}

// A seed where Thursday shows a sub-agent asking past its parent, AutoReview waving it
// through, early in the day. That is the whole game in one screen.
function pickSeed() {
  for (let seed = 1; seed < 5000; seed++) {
    const day = V.generateDay(V.createWorld(seed), 4);
    const i = day.findIndex(t => t.violations[0] === 'DELEGATION' && t.autoReview && t.autoReview.rec === 'approve');
    if (i >= 1 && i <= 3 && day.slice(0, i).every(t => t.kind !== 'agent' || t.violations.length === 0)) return { seed, index: i };
  }
  throw new Error('no seed found');
}

// ---------- scenes ----------

async function icons() {
  const svg = fs.readFileSync(path.join(ROOT, 'public/favicon.svg'), 'utf8');
  const page = body => 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><head><style>html,body{margin:0;height:100%;background:transparent}svg{display:block;width:100vw;height:100vh}</style></head><body>' + body + '</body></html>');
  const square = svg.replace(/rx="230"/g, 'rx="0"');
  await media('dark', true);
  await load(page(svg));
  await viewport(512, 512, 1);
  await shot('public/icon-512.png', true);
  await load(page(square));
  await viewport(180, 180, 1);
  await shot('public/apple-touch-icon.png');
  await viewport(1024, 1024, 1);
  await shot('docs/assets/icon-1024.png');
}

async function socials() {
  await media('dark', true);
  await viewport(1200, 630, 1);
  await load(fileUrl('tools/assets/social.html'));
  await sleep(200);
  await shot('public/og.png');
  await viewport(1280, 640, 1);
  await sleep(200);
  await shot('docs/assets/social-preview.png');
}

async function screenshots() {
  const game = fileUrl('public/index.html');
  const { seed, index } = pickSeed();
  console.log('  seed ' + seed + ', Thursday ticket ' + (index + 1));
  const world = V.createWorld(seed);
  const thursday = V.generateDay(world, 4);
  const shots = [];

  // 1. Title, dark.
  await media('dark', false);
  await viewport(1280, 800, 2);
  await load(game);
  await saveRun({ seed, nextDay: 4, score: 245, days: [], relaxed: false });
  await load(game);
  await sleep(400);
  shots.push(['01-title', await shot('docs/screenshots/01-title.png')]);

  // 2. Thursday at the desk: the sub-agent, AutoReview saying approve.
  await click('#btn-continue');
  await click('#btn-start');
  await sleep(500);
  for (let i = 0; i < index; i++) await stamp(thursday[i], 4, false);
  await sleep(700);
  shots.push(['02-desk', await shot('docs/screenshots/02-desk.png')]);

  // 3. The parent's record, which settles it.
  const parent = world.agentsById[world.agentsById[thursday[index].requester].parent];
  await evaluate(`document.querySelector('.drawer [data-ref="${parent.id}"]') ? document.querySelector('.drawer [data-ref="${parent.id}"]').click() : null`);
  await sleep(250);
  shots.push(['03-evidence', await shot('docs/screenshots/03-evidence.png')]);

  // 4. The stamp.
  await key('d');
  await sleep(80);
  await key(REASON_KEYS[V.activeRules(4).indexOf('DELEGATION')]);
  await sleep(420);
  shots.push(['04-stamp', await shot('docs/screenshots/04-stamp.png')]);
  await sleep(900);

  // 5. Phone, dark: the next ticket on a small screen.
  await viewport(390, 844, 3, true);
  await sleep(500);
  await evaluate('window.scrollTo(0, 0)');
  shots.push(['05-phone', await shot('docs/screenshots/05-phone.png')]);

  // 6. A whole week, played fast, then the audit report in the light theme.
  // The player is careful, except twice: they follow AutoReview when it is wrong.
  await viewport(1280, 1000, 2);
  await media('light', true);
  await load(game);
  await saveRun({ seed, nextDay: 1, score: 0, days: [], relaxed: true }, 'light');
  await load(game);
  let slips = 2;
  await click('#btn-continue');
  for (let d = 1; d <= 5; d++) {
    await waitFor(`document.querySelector('#btn-start')`);
    await click('#btn-start');
    await sleep(200);
    for (const t of V.generateDay(world, d)) {
      const wrong = t.autoReview && !V.autoReviewCorrect(t);
      const follow = wrong && slips > 0 && t.autoReview.rec === 'approve';
      if (follow) slips--;
      await stamp(t, d, follow);
    }
    await waitFor(`document.querySelector('.report')`);
    await click('#btn-next');
    await sleep(200);
  }
  await waitFor(`document.querySelector('.machine-card')`);
  await sleep(300);
  shots.push(['06-audit', await shot('docs/screenshots/06-audit.png')]);

  if (WEBP) {
    for (const [name, data] of shots.filter(([n]) => ['02-desk', '04-stamp', '06-audit'].includes(n))) {
      await webp(data, `docs/screenshots/${name}.webp`, 1440);
      await webp(data, `docs/screenshots/${name}-small.webp`, 440);
    }
  }
}

// ---------- main ----------

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vierauge-chrome-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio',
    '--allow-file-access-from-files', '--force-color-profile=srgb', 'about:blank',
  ], { stdio: 'ignore' });
  let failed = false;
  try {
    await connect();
    await send('Page.enable');
    await send('Runtime.enable');
    console.log('icons');
    await icons();
    console.log('social cards');
    await socials();
    console.log('screenshots');
    await screenshots();
  } catch (e) {
    failed = true;
    console.error(e);
  } finally {
    try { ws.close(); } catch (e) { /* closed */ }
    const exited = new Promise(resolve => chrome.once('exit', resolve));
    chrome.kill();
    await Promise.race([exited, sleep(5000)]);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* temp dir, the OS cleans it */ }
  }
  process.exit(failed ? 1 : 0);
})();
