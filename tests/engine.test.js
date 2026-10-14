// Run with: npm test   (node --test, no dependencies)
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const V = require('../public/engine.js');

const SEEDS = Array.from({ length: 400 }, (_, i) => 1000 + i * 7919);

test('a seed always builds the same world and the same days', () => {
  const a = V.createWorld(42);
  const b = V.createWorld(42);
  assert.deepEqual(a.people, b.people);
  assert.deepEqual(a.agents, b.agents);
  for (let d = 1; d <= 5; d++) {
    assert.deepEqual(V.generateDay(a, d).map(t => t.id + t.ent), V.generateDay(b, d).map(t => t.id + t.ent));
  }
  assert.notDeepEqual(V.createWorld(43).people.map(p => p.name), a.people.map(p => p.name));
});

test('every world plants the problems the reviews depend on', () => {
  for (const seed of SEEDS) {
    const w = V.createWorld(seed);
    const p = w.problems;
    assert.equal(p.leavers.length, 4, 'leavers');
    assert.equal(p.ended.length, 2, 'ended contracts');
    assert.equal(p.endsMidweek.length, 1, 'contract ending Wednesday');
    assert.equal(p.movers.length, 4, 'movers');
    assert.ok(p.sodHolders.length >= 1, 'toxic pair holders');
    const orphan = w.agentsById[p.orphanAgent];
    assert.equal(w.byId[orphan.owner].status, 'left', 'orphan agent owner left');
    assert.ok(w.agentsById[p.expiredAgent].expires < '2026-10-19', 'expired agent');
    for (const a of w.agents.filter(x => x.parent)) {
      const parent = w.agentsById[a.parent];
      for (const s of a.scopes) assert.ok(parent.scopes.includes(s), 'sub-agent scopes are a subset of the parent');
    }
  }
});

test('IDs are unique across people and agents', () => {
  for (const seed of SEEDS.slice(0, 50)) {
    const w = V.createWorld(seed);
    const ids = [...w.people.map(p => p.id), ...w.agents.map(a => a.id)];
    assert.equal(new Set(ids).size, ids.length);
    const names = w.people.map(p => p.name);
    assert.equal(new Set(names).size, names.length, 'no two people share a name');
  }
});

test('generator and validator agree on every ticket of every day', () => {
  let tickets = 0;
  let fallbacks = 0;
  const seenRules = new Set();
  for (const seed of SEEDS) {
    const w = V.createWorld(seed);
    for (let d = 1; d <= 5; d++) {
      const day = V.generateDay(w, d);
      fallbacks += day.fallbacks;
      assert.equal(day.length, V.DAYS[d - 1].tickets, `seed ${seed} day ${d} ticket count`);
      const ids = new Set();
      for (const t of day) {
        tickets++;
        assert.ok(!ids.has(t.id), 'ticket ids unique within a day');
        ids.add(t.id);
        assert.ok(t.violations.length <= 1, `seed ${seed} day ${d} ${t.id} has ${t.violations.join(',')}`);
        if (t.intended) assert.deepEqual(t.violations, [t.intended], `seed ${seed} day ${d} ${t.id}`);
        else assert.deepEqual(t.violations, []);
        for (const v of t.violations) {
          assert.ok(V.RULES[v].day <= d, `${v} fired before it exists`);
          assert.ok(V.KIND_RULES[t.kind].includes(v), `${v} on a ${t.kind} ticket`);
          assert.ok(t.evidence[v] && t.evidence[v].length > 20, `evidence for ${v}`);
          seenRules.add(v);
        }
      }
    }
  }
  assert.deepEqual([...seenRules].sort(), [...V.RULE_ORDER].sort(), 'every rule shows up somewhere');
  assert.ok(fallbacks / tickets < 0.01, `fallback rate ${(fallbacks / tickets * 100).toFixed(2)}%`);
});

test('each day teaches its new rules at least once', () => {
  for (const seed of SEEDS.slice(0, 100)) {
    const w = V.createWorld(seed);
    for (let d = 1; d <= 5; d++) {
      const day = V.generateDay(w, d);
      const fired = new Set(day.flatMap(t => t.violations));
      for (const id of V.RULE_ORDER.filter(x => V.RULES[x].day === d)) {
        assert.ok(fired.has(id), `seed ${seed} day ${d} never shows ${id}`);
      }
    }
  }
});

test('Monday opens with a clean ticket', () => {
  for (const seed of SEEDS.slice(0, 100)) {
    assert.deepEqual(V.generateDay(V.createWorld(seed), 1)[0].violations, []);
  }
});

test('agents and AutoReview stay out of Monday and Tuesday', () => {
  for (const seed of SEEDS.slice(0, 100)) {
    const w = V.createWorld(seed);
    for (const d of [1, 2]) {
      for (const t of V.generateDay(w, d)) {
        assert.notEqual(t.kind, 'agent');
        assert.equal(t.autoReview, null);
      }
    }
  }
});

test('AutoReview always falls for injected text, and that is the point', () => {
  let injected = 0;
  for (const seed of SEEDS.slice(0, 100)) {
    const w = V.createWorld(seed);
    for (let d = 3; d <= 5; d++) {
      for (const t of V.generateDay(w, d)) {
        if (!t.injected) continue;
        injected++;
        assert.equal(t.autoReview.rec, 'approve');
        assert.ok(t.text.includes(t.injection));
      }
    }
  }
  assert.ok(injected > 50);
});

test('AutoReview accuracy lands well under the vendor claim', () => {
  let seen = 0;
  let right = 0;
  for (const seed of SEEDS) {
    const w = V.createWorld(seed);
    for (let d = 3; d <= 5; d++) {
      for (const t of V.generateDay(w, d)) {
        seen++;
        if (V.autoReviewCorrect(t)) right++;
      }
    }
  }
  const pct = (right / seen) * 100;
  assert.ok(pct > 65 && pct < 90, `AutoReview measured at ${pct.toFixed(1)}%`);
});

test('the contract that ends on Wednesday is fine until Wednesday and ended after', () => {
  const w = V.createWorld(7);
  const p = w.byId[w.problems.endsMidweek[0]];
  const ent = p.holds.find(c => !w.ents[c].dept || w.ents[c].dept === p.dept);
  if (!ent) return;
  const recert = { kind: 'recert', requester: p.id, ent, approvals: [], until: null, injected: false };
  const clean = V.validate(w, recert, 3).filter(v => v === 'CONTRACT');
  assert.deepEqual(clean, []);
  assert.ok(V.validate(w, recert, 4).includes('CONTRACT'));
});

test('judge scores each outcome', () => {
  const clean = { id: 'A', kind: 'grant', violations: [], evidence: {} };
  const bad = { id: 'B', kind: 'grant', violations: ['SOD'], evidence: { SOD: 'x holds y' } };
  assert.equal(V.judge(clean, { action: 'approve' }).outcome, 'correct');
  assert.equal(V.judge(clean, { action: 'deny', reason: 'SOD' }).outcome, 'false-deny');
  assert.equal(V.judge(bad, { action: 'approve' }).outcome, 'missed');
  assert.equal(V.judge(bad, { action: 'deny', reason: 'SOD' }).outcome, 'correct');
  assert.equal(V.judge(bad, { action: 'deny', reason: 'CONTRACT' }).outcome, 'wrong-reason');
  assert.equal(V.judge(bad, { action: 'approve' }).points, V.POINTS.missed);
});

test('summarize counts automation bias only where AutoReview was wrong', () => {
  const s = V.summarize([
    { outcome: 'correct', points: 10, action: 'approve', ar: { rec: 'approve', correct: true } },
    { outcome: 'missed', points: -20, action: 'approve', ar: { rec: 'approve', correct: false } },
    { outcome: 'correct', points: 15, action: 'deny', ar: { rec: 'approve', correct: false } },
    { outcome: 'unprocessed', points: -5 },
  ]);
  assert.equal(s.processed, 3);
  assert.equal(s.unprocessed, 1);
  assert.equal(s.arWrong, 2);
  assert.equal(s.followedWrong, 1);
  assert.equal(s.overrodeWrong, 1);
  assert.equal(s.points, 0);
});

test('no em dash anywhere in the shipped files', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = dir => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name === 'node_modules' || f.name === '.git') continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|html|css|md|json|jsonc|svg)$/.test(f.name)) files.push(p);
    }
  };
  walk(root);
  const dash = String.fromCharCode(0x2014);
  for (const f of new Set(files)) {
    assert.ok(!fs.readFileSync(f, 'utf8').includes(dash), `em dash in ${path.relative(root, f)}`);
  }
});
