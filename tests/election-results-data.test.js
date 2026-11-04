'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../election-results-data.js');

const FILE = path.join(__dirname, '..', 'data', 'election-results.json');
const NOW = '2026-11-04T12:00:00Z';
const live = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
// A fixed-time copy of the published file, so these tests keep passing when the writer updates it.
function fixture() {
  const d = live();
  d.publishedAt = '2026-11-04T11:30:00Z';
  d.observedAt = '2026-11-04T11:00:00Z';
  d.chambers.senate.control = null;
  d.chambers.house.control = null;
  for (const office of ['senate', 'governor']) for (const r of Object.values(d.races[office])) r.calledAt = null;
  return d;
}
const check = (d) => E.validateDataset(d, { now: NOW });

test('the published results file passes its own contract', () => {
  assert.doesNotThrow(() => E.validateDataset(live()));
});

test('a fixed-time copy passes and keeps every state', () => {
  const d = check(fixture());
  assert.equal(Object.keys(d.races.senate).length, 35);
  assert.equal(Object.keys(d.races.governor).length, 36);
});

test('unknown fields, missing states and extra states are rejected', () => {
  const extraTop = fixture(); extraTop.extra = 1;
  assert.throws(() => check(extraTop), /unrecognized field/);
  const missing = fixture(); delete missing.races.senate.GA;
  assert.throws(() => check(missing), /required state missing/);
  const extraState = fixture(); extraState.races.senate.CA = extraState.races.senate.GA;
  assert.throws(() => check(extraState), /unexpected state/);
});

test('a call needs a winner and only a call may have one', () => {
  const noWinner = fixture();
  const called = Object.keys(noWinner.races.senate).find((k) => noWinner.races.senate[k].status === 'called');
  noWinner.races.senate[called].winner = null;
  assert.throws(() => check(noWinner), /expected a plain object/);
  const leaderAsWinner = fixture();
  leaderAsWinner.races.governor.WY = { status: 'uncalled', special: false, winner: { name: 'Someone', party: 'R' }, calledBy: null, calledAt: null, leader: 'R', candidates: [], reported: null, otherCalls: [], note: '' };
  assert.throws(() => check(leaderAsWinner), /only a called race may have a winner/);
  const unknownLeader = fixture();
  unknownLeader.races.governor.WY = { status: 'unknown', special: false, winner: null, calledBy: null, calledAt: null, leader: 'D', candidates: [], reported: null, otherCalls: [], note: '' };
  assert.throws(() => check(unknownLeader), /an unverified race has no leader/);
});

test('links in prose, bad URLs and impossible numbers are rejected', () => {
  const link = fixture(); link.note = '자세한 내용은 https://example.org 참고';
  assert.throws(() => check(link), /links or contact details/);
  const privateSource = fixture(); privateSource.sources = ['https://www.notion.so/page'];
  assert.throws(() => check(privateSource), /private or unsupported source host/);
  const pct = fixture();
  const open = Object.keys(pct.races.senate).find((k) => pct.races.senate[k].status === 'uncalled');
  if (open) {
    pct.races.senate[open].reported = 120;
    assert.throws(() => check(pct), /percentage/);
  }
  const house = fixture(); house.chambers.house.totals.uncalled += 1;
  assert.throws(() => check(house), /must add up to 435/);
  const senate = fixture(); senate.chambers.senate.notUp.D += 1;
  assert.throws(() => check(senate), /must equal the chamber size/);
});

test('times may not run ahead of publication or the clock', () => {
  const future = fixture(); future.publishedAt = '2026-11-04T12:30:00Z';
  assert.throws(() => check(future), /in the future/);
  const order = fixture(); order.observedAt = '2026-11-04T11:45:00Z';
  assert.throws(() => check(order), /observation is newer than publication/);
  const call = fixture();
  const called = Object.keys(call.races.senate).find((k) => call.races.senate[k].status === 'called');
  call.races.senate[called].calledAt = '2026-11-04T11:40:00Z';
  assert.throws(() => check(call), /call is newer than publication/);
});

test('Senate math counts seats not up, caucusing independents and the tie-breaker', () => {
  const d = fixture();
  for (const k of E.SENATE_STATES) {
    d.races.senate[k] = { status: 'called', special: false, winner: { name: 'Winner', party: k < 'M' ? 'D' : 'R' }, calledBy: 'TEST', calledAt: null, leader: null, candidates: [], reported: null, otherCalls: [], note: '' };
  }
  d.races.senate.AK = { status: 'uncalled', special: false, winner: null, calledBy: null, calledAt: null, leader: 'R', candidates: [], reported: null, otherCalls: [], note: '' };
  const s = E.senateSummary(check(d));
  const calledD = E.SENATE_STATES.filter((k) => k !== 'AK' && k < 'M').length;
  const calledR = E.SENATE_STATES.filter((k) => k !== 'AK' && k >= 'M').length;
  assert.equal(s.seats.D, 32 + 2 + calledD);
  assert.equal(s.seats.R, 31 + calledR);
  assert.equal(s.seats.uncalled, 1);
  assert.equal(s.need.R, Math.max(0, 50 - s.seats.R));
  assert.equal(s.need.D, Math.max(0, 51 - s.seats.D));
});

// Flip a race between called and uncalled with fields the contract accepts.
function flip(r) {
  if (r.status === 'called') Object.assign(r, { status: 'uncalled', winner: null, calledBy: null, calledAt: null, leader: 'D' });
  else Object.assign(r, { status: 'called', winner: { name: 'Test Winner', party: 'D' }, calledBy: 'DDHQ', calledAt: null, leader: null });
}

test('comparing a file with itself finds no change', () => {
  const d = check(fixture());
  const diff = E.compareDatasets(d, check(fixture()));
  assert.deepEqual(diff.top, []);
  assert.deepEqual(diff.chambers, []);
  assert.deepEqual(diff.races, []);
  assert.equal(diff.unchanged, 71);
  assert.equal(diff.total, 71);
});

test('comparison lists changed races, fields, chambers and note-only rewrites', () => {
  const before = check(fixture());
  const after = fixture();
  flip(after.races.senate.AL);
  after.races.governor.AK.note = `${after.races.governor.AK.note} 재확인`.trim();
  after.chambers.house.totals.uncalled -= 1;
  after.chambers.house.totals.D += 1;
  after.observedAt = '2026-11-04T11:15:00Z';
  const diff = E.compareDatasets(before, check(after));
  assert.deepEqual(diff.top, ['observedAt']);
  assert.deepEqual(diff.chambers, ['house.totals']);
  const al = diff.races.find((r) => r.office === 'senate' && r.state === 'AL');
  assert.ok(al.fields.includes('status') && al.fields.includes('winner') && al.fields.includes('calledBy'));
  assert.equal(al.noteOnly, false);
  const ak = diff.races.find((r) => r.office === 'governor' && r.state === 'AK');
  assert.deepEqual(ak.fields, ['note']);
  assert.equal(ak.noteOnly, true);
  assert.equal(diff.unchanged, 69);
});

test('comparison ignores key order', () => {
  const before = check(fixture());
  const after = fixture();
  const called = Object.keys(after.races.senate).find((k) => after.races.senate[k].status === 'called');
  const w = after.races.senate[called].winner;
  after.races.senate[called].winner = { party: w.party, name: w.name };
  assert.deepEqual(E.compareDatasets(before, check(after)).races, []);
});

test('the validator command reports the scope of an update and warns about rewrites', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'election-results-'));
  const write = (name, d, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text || `${JSON.stringify(d, null, 2)}\n`); return f; };
  const before = write('before.json', fixture());
  const changed = fixture();
  flip(changed.races.senate.AL);
  changed.races.governor.AK.note = `${changed.races.governor.AK.note} 재확인`.trim();
  const after = write('after.json', changed);
  const script = path.join(__dirname, '..', 'scripts', 'validate-election-results.js');
  const run = spawnSync(process.execPath, [script, after, '--compare', before], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /2 of 71 races changed, 69 unchanged/);
  assert.match(run.stdout, /senate\.AL: status/);
  assert.match(run.stdout, /Warning: 1 race changed only in their note \(governor\.AK\)/);
  assert.match(run.stdout, /Commit summary: 2 races changed \(senate\.AL, governor\.AK\); 69 races unchanged/);
  assert.doesNotMatch(run.stdout, /canonical format/);
  const minified = write('minified.json', null, JSON.stringify(fixture()));
  const reformatted = spawnSync(process.execPath, [script, minified, '--compare', before], { encoding: 'utf8' });
  assert.equal(reformatted.status, 0, reformatted.stderr);
  assert.match(reformatted.stdout, /no race changed \(71 unchanged\)/);
  assert.match(reformatted.stdout, /not in the canonical format/);
  const broken = write('broken.json', null, '{');
  const failed = spawnSync(process.execPath, [script, after, '--compare', broken], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /previous file .* could not be read/);
  fs.rmSync(dir, { recursive: true, force: true });
});
