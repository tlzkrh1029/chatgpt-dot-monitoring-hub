'use strict';
/* Operations checks for the parallel timeline (병렬 타임라인):
 * - the collect workflow (.github/workflows/update-parallel-prices.yml): gates, permissions, repository guard,
 *   concurrency, dispatch inputs, the Pages step condition, the probe artifact (static checks), and its shell
 *   steps (data branch, overlay, mirror, archive, retries) executed in a local git sandbox;
 * - scripts/validate-parallel.js --notes=warn;
 * - scripts/probe-parallel-sources.js with a stubbed fetch.
 * Review findings: tests-01, data-03, security-1, security-3, security-4, security-5, security-7, security-8,
 * security-9, security-10, tests-09.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Core = require('../parallel-core.js');
const Validate = require('../scripts/validate-parallel.js');
const Probe = require('../scripts/probe-parallel-sources.js');
const { userAgent } = require('../scripts/collect-parallel.js');

const ROOT = path.join(__dirname, '..');
const WORKFLOW_FILE = path.join(ROOT, '.github', 'workflows', 'update-parallel-prices.yml');
const UPSTREAM = 'tlzkrh1029/chatgpt-dot-monitoring-hub';
// Child processes never see the workflow step's own GITHUB_OUTPUT or annotation mode (this file runs in the gate).
const CHILD_ENV = { ...process.env, GITHUB_OUTPUT: '', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' };

// ---------------------------------------------------------------- a YAML reader for the workflow's subset

/**
 * Block maps and sequences, plain/quoted scalars, flow sequences of plain scalars, literal (|) and folded (>-)
 * block scalars, comments. Throws on anything else, so a construct it does not know cannot pass silently;
 * the result is compared with PyYAML below when python3 has it.
 */
function parseYaml(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let pos = 0;
  const indentOf = (line) => line.length - line.replace(/^ +/, '').length;
  const skipBlank = () => {
    while (pos < lines.length && /^\s*(#.*)?$/.test(lines[pos])) pos++;
  };
  const isItem = (body) => /^-( |$)/.test(body);
  const KEY = /^([A-Za-z_][\w.-]*):(?:[ \t]+(.*))?$/;

  function scalar(raw) {
    const s = raw.trim();
    if (s[0] === "'") {
      let out = '';
      let k = 1;
      for (; k < s.length; k++) {
        if (s[k] === "'") {
          if (s[k + 1] === "'") {
            out += "'";
            k++;
            continue;
          }
          break;
        }
        out += s[k];
      }
      if (k >= s.length) throw new Error(`unterminated quoted scalar: ${s}`);
      const rest = s.slice(k + 1).trim();
      if (rest && !rest.startsWith('#')) throw new Error(`text after a quoted scalar: ${s}`);
      return out;
    }
    if (s[0] === '"') throw new Error(`double-quoted scalars are not used in the workflow: ${s}`);
    const hash = s.search(/(^|\s)#/);
    const v = (hash >= 0 ? s.slice(0, hash) : s).trim();
    if (v.startsWith('[')) {
      if (!v.endsWith(']')) throw new Error(`unterminated flow sequence: ${v}`);
      const inner = v.slice(1, -1).trim();
      return inner ? inner.split(',').map((x) => scalar(x)) : [];
    }
    if (/^[{&*!|>%@`]/.test(v)) throw new Error(`unsupported scalar: ${v}`);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === '' || v === 'null' || v === '~') return null;
    if (/^-?\d+$/.test(v)) return Number(v);
    return v;
  }

  function blockScalar(style, chomp, ind) {
    if (chomp === '+') throw new Error('keep chomping is not used in the workflow');
    const body = [];
    let at = null;
    while (pos < lines.length) {
      const line = lines[pos];
      if (line.trim() === '') {
        body.push('');
        pos++;
        continue;
      }
      const li = indentOf(line);
      if (li <= ind) break;
      if (at === null) at = li;
      if (li < at) throw new Error(`line ${pos + 1}: block scalar indentation`);
      body.push(line.slice(at));
      pos++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    let text;
    if (style === '|') {
      text = body.join('\n');
    } else {
      if (body.some((line) => line === '' || /^\s/.test(line))) throw new Error('folded scalar with blank or indented lines');
      text = body.join(' ');
    }
    return chomp === '-' ? text : `${text}\n`;
  }

  function value(rest, ind) {
    const t = rest.trim();
    const block = /^([|>])([+-]?)(?:\s+#.*)?$/.exec(t);
    if (block) return blockScalar(block[1], block[2], ind);
    if (t === '' || t.startsWith('#')) {
      skipBlank();
      if (pos < lines.length) {
        const li = indentOf(lines[pos]);
        if (li > ind || (li === ind && isItem(lines[pos].slice(li)))) return node(li);
      }
      return null;
    }
    return scalar(t);
  }

  function map(ind) {
    const out = {};
    for (;;) {
      skipBlank();
      if (pos >= lines.length) return out;
      const line = lines[pos];
      const li = indentOf(line);
      if (li < ind) return out;
      if (li > ind) throw new Error(`line ${pos + 1}: unexpected indentation`);
      const body = line.slice(li);
      if (isItem(body)) return out;
      const m = KEY.exec(body);
      if (!m) throw new Error(`line ${pos + 1}: expected "key: value"`);
      if (Object.prototype.hasOwnProperty.call(out, m[1])) throw new Error(`line ${pos + 1}: duplicate key ${m[1]}`);
      pos++;
      out[m[1]] = value(m[2] === undefined ? '' : m[2], ind);
    }
  }

  function seq(ind) {
    const out = [];
    for (;;) {
      skipBlank();
      if (pos >= lines.length) return out;
      const line = lines[pos];
      const li = indentOf(line);
      if (li !== ind || !isItem(line.slice(li))) {
        if (li > ind) throw new Error(`line ${pos + 1}: unexpected indentation`);
        return out;
      }
      const after = line.slice(li + 1);
      const rest = after.replace(/^ +/, '');
      const restIndent = li + 1 + (after.length - rest.length);
      if (KEY.test(rest)) {
        lines[pos] = ' '.repeat(restIndent) + rest; // "- key: v" opens a map at the key's column
        out.push(map(restIndent));
      } else if (rest === '' || rest.startsWith('#')) {
        pos++;
        out.push(node(ind + 1));
      } else {
        pos++;
        out.push(scalar(rest));
      }
    }
  }

  function node(minIndent) {
    skipBlank();
    if (pos >= lines.length) return null;
    const ind = indentOf(lines[pos]);
    if (ind < minIndent) return null;
    return isItem(lines[pos].slice(ind)) ? seq(ind) : map(ind);
  }

  const doc = map(0);
  skipBlank();
  if (pos < lines.length) throw new Error(`line ${pos + 1}: content after the document`);
  return doc;
}

// ---------------------------------------------------------------- GitHub expressions (the subset used)

/** Evaluates a GitHub Actions expression (optionally wrapped in ${{ }}) against ctx {github, inputs, steps}. */
function evalExpr(source, ctx) {
  const s = source.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim();
  const tokens = [];
  const re = /\s*(?:(\|\||&&|==|!=|!|\(|\)|,|\.)|'((?:[^']|'')*)'|(\d+(?:\.\d+)?)|([A-Za-z_][\w-]*))\s*/y;
  for (let k = 0; k < s.length;) {
    re.lastIndex = k;
    const m = re.exec(s);
    if (!m) throw new Error(`cannot read the expression at: ${s.slice(k)}`);
    k = re.lastIndex;
    if (m[1]) tokens.push({ op: m[1] });
    else if (m[2] !== undefined) tokens.push({ str: m[2].replace(/''/g, "'") });
    else if (m[3]) tokens.push({ num: Number(m[3]) });
    else tokens.push({ id: m[4] });
  }
  let i = 0;
  const take = (op) => {
    if (tokens[i] && tokens[i].op === op) {
      i++;
      return true;
    }
    return false;
  };
  const truthy = (v) => !(v === false || v === 0 || v === '' || v === null || v === undefined || Number.isNaN(v));
  const num = (v) => (v == null || v === false ? 0 : v === true ? 1 : typeof v === 'number' ? v : v.trim() === '' ? 0 : Number(v));
  const eq = (a, b) => {
    if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
    if ((a == null) && (b == null)) return true;
    if (typeof a === typeof b) return a === b;
    return num(a) === num(b);
  };
  const lower = (v) => (v == null ? '' : String(v)).toLowerCase();
  const fns = {
    startsWith: (a, b) => lower(a).startsWith(lower(b)),
    endsWith: (a, b) => lower(a).endsWith(lower(b)),
    contains: (a, b) => lower(a).includes(lower(b)),
  };
  function primary() {
    const t = tokens[i++];
    if (!t) throw new Error('unexpected end of expression');
    if (t.op === '(') {
      const v = or();
      if (!take(')')) throw new Error('expected )');
      return v;
    }
    if (t.str !== undefined) return t.str;
    if (t.num !== undefined) return t.num;
    if (!t.id) throw new Error(`unexpected ${t.op}`);
    if (t.id === 'true' || t.id === 'false') return t.id === 'true';
    if (t.id === 'null') return null;
    if (take('(')) {
      if (!fns[t.id]) throw new Error(`unsupported function ${t.id}`);
      const args = [];
      if (!take(')')) {
        do args.push(or()); while (take(','));
        if (!take(')')) throw new Error('expected ) after the arguments');
      }
      return fns[t.id](...args);
    }
    if (!Object.prototype.hasOwnProperty.call(ctx, t.id)) throw new Error(`unknown context ${t.id}`);
    let v = ctx[t.id];
    while (take('.')) {
      const p = tokens[i++];
      if (!p || !p.id) throw new Error('expected a property name');
      v = v == null ? undefined : v[p.id];
    }
    return v === undefined ? null : v;
  }
  function cmp() {
    let v = primary();
    for (;;) {
      if (take('==')) v = eq(v, primary());
      else if (take('!=')) v = !eq(v, primary());
      else return v;
    }
  }
  function not() {
    return take('!') ? !truthy(not()) : cmp();
  }
  function and() {
    let v = not();
    while (take('&&')) {
      const r = not();
      v = truthy(v) ? r : v;
    }
    return v;
  }
  function or() {
    let v = and();
    while (take('||')) {
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  }
  const out = or();
  if (i !== tokens.length) throw new Error('unexpected text after the expression');
  return out;
}

const WF = parseYaml(fs.readFileSync(WORKFLOW_FILE, 'utf8'));
const COLLECT = WF.jobs.collect;
const PROBE = WF.jobs.probe;
const stepById = (id) => COLLECT.steps.find((s) => s.id === id);
const allSteps = Object.entries(WF.jobs).flatMap(([job, j]) => j.steps.map((s, index) => ({ job, index, step: s })));
const runs = allSteps.filter(({ step }) => typeof step.run === 'string');
const context = ({ event = 'schedule', ref = 'refs/heads/main', repository = UPSTREAM, inputs = {}, steps = {} } = {}) => ({
  github: { event_name: event, ref, ref_name: ref.replace(/^refs\/(heads|tags)\//, ''), repository },
  inputs, steps, secrets: {}, env: {}, vars: {},
});

// ---------------------------------------------------------------- static checks of the workflow

test('the workflow reader understands the whole file and agrees with PyYAML when it is available', (t) => {
  assert.equal(WF.name, 'Update parallel market prices');
  assert.deepEqual(Object.keys(WF.jobs).sort(), ['collect', 'probe']);
  const py = spawnSync('python3', ['-I', '-c', [
    'import json, sys, yaml',
    'd = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))',
    'd["on"] = d.pop(True)',
    'print(json.dumps(d))',
  ].join('\n'), WORKFLOW_FILE], { encoding: 'utf8' });
  if (py.error || py.status !== 0) {
    t.diagnostic('python3 with PyYAML is not available; skipped the cross-check');
    return;
  }
  assert.deepEqual(WF, JSON.parse(py.stdout));
});

test('publication is gated only by the parallel tests and validate-parallel --notes=warn (tests-01, data-03, security-3)', () => {
  const steps = COLLECT.steps;
  const at = (pred) => steps.findIndex(pred);
  const testStep = at((s) => s.run === 'node --test tests/parallel-*.test.js');
  const validateStep = at((s) => s.run === 'node scripts/validate-parallel.js --notes=warn');
  const collectStep = at((s) => s.id === 'collect');
  const publishStep = at((s) => s.id === 'publish');
  const archiveStep = at((s) => s.id === 'archive');
  const pagesStep = at((s) => s.id === 'pages');
  assert.ok(testStep >= 0 && validateStep >= 0, 'both gates are steps of the collect job');
  assert.ok(testStep < collectStep, 'the code is tested before any provider request');
  assert.ok(collectStep < validateStep && validateStep < publishStep, 'the collected data is validated before it is published');
  assert.ok(publishStep < archiveStep && archiveStep < pagesStep);
  assert.equal(steps[testStep].env.PARALLEL_SKIP_LIVE_DATA_TESTS, '1', 'live data files are the validator\'s job, not the tests\'');
  for (const { job, step } of runs) {
    assert.doesNotMatch(step.run, /\bnpm\b/, `${job}: no npm test / npm run validate (the hub's other suites never gate this tab)`);
    assert.doesNotMatch(step.run, /validate-(publication|election-results)|tests\/\*\.test\.js/, job);
    for (const m of step.run.matchAll(/validate-parallel\.js([^\n]*)/g)) {
      assert.match(m[1], /^ --notes=warn\b/, `every validation in the workflow treats analyst notes as warnings: ${m[0]}`);
    }
  }
});

test('read-only by default; write access only for the collect job, held by the push steps alone (security-10)', () => {
  assert.deepEqual(WF.permissions, { contents: 'read' });
  assert.deepEqual(PROBE.permissions, { contents: 'read' });
  assert.deepEqual(COLLECT.permissions, { contents: 'write', pages: 'write' });
  for (const { job, step } of allSteps.filter(({ step: s }) => s.uses)) {
    assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${job}: ${step.uses} is pinned to a commit`);
    if (step.uses.startsWith('actions/checkout@')) {
      assert.equal(step.with['persist-credentials'], false, `${job}: the checkout must not store the token in .git/config`);
    }
  }
  const withSecrets = allSteps.filter(({ step }) => JSON.stringify(step).includes('secrets.'));
  assert.deepEqual(withSecrets.map(({ step }) => step.id).sort(), ['archive', 'pages', 'publish']);
  for (const { step } of withSecrets) {
    const env = Object.entries(step.env).filter(([, v]) => String(v).includes('secrets.'));
    assert.equal(env.length, 1, step.id);
    assert.equal(env[0][1], '${{ secrets.GITHUB_TOKEN }}');
    assert.ok(!String(step.run).includes('secrets.'), `${step.id}: the secret is never interpolated into the script`);
  }
  assert.ok(!JSON.stringify(COLLECT.env).includes('secrets.'), 'the job env holds no secret');
  for (const id of ['publish', 'archive']) {
    const run = stepById(id).run;
    assert.doesNotMatch(run, /https:\/\/x-access-token|git config|git remote set-url/, `${id}: the token never lands in a URL or .git/config`);
    assert.match(run, /GIT_CONFIG_KEY_0="http\.\$GITHUB_SERVER_URL\/\.extraheader"/);
  }
});

test('shell steps take every input through env, quoted, and never force a push', () => {
  for (const { job, step } of runs) {
    assert.ok(!step.run.includes('${{'), `${job}/${step.name || step.id}: no expression inside a script (injection)`);
    for (const line of step.run.split('\n').filter((l) => /\bgit\b.*\bpush\b/.test(l))) {
      assert.doesNotMatch(line, /--force|\s-f\b|--mirror|\s\+[\w$"]|"\+/, `no force push: ${line.trim()}`);
    }
  }
  for (const name of ['INPUT_DATE', 'INPUT_START', 'INPUT_END', 'INPUT_FORCE', 'INPUT_REPLACE_WINDOW', 'EVENT_NAME', 'OVERLAY_DIR']) {
    assert.ok(Object.prototype.hasOwnProperty.call(stepById('collect').env, name), name);
  }
});

test('repository guard: scheduled and push runs collect only on main of this repository (security-8)', () => {
  const runsCollect = (c) => Boolean(evalExpr(COLLECT.if, context(c)));
  const runsProbe = (c) => Boolean(evalExpr(PROBE.if, context(c)));
  assert.equal(runsCollect({ event: 'schedule' }), true);
  assert.equal(runsCollect({ event: 'push' }), true);
  assert.equal(runsCollect({ event: 'schedule', repository: 'someone/chatgpt-dot-monitoring-hub' }), false);
  assert.equal(runsCollect({ event: 'push', repository: 'someone/chatgpt-dot-monitoring-hub' }), false);
  assert.equal(runsCollect({ event: 'push', ref: 'refs/heads/dev' }), false);
  assert.equal(runsCollect({ event: 'workflow_dispatch', inputs: { mode: 'collect' } }), true);
  assert.equal(runsCollect({ event: 'workflow_dispatch', ref: 'refs/heads/claude/dev', repository: 'someone/fork', inputs: { mode: 'collect' } }), true);
  assert.equal(runsCollect({ event: 'workflow_dispatch', inputs: { mode: 'probe' } }), false);
  assert.equal(runsCollect({ event: 'workflow_dispatch', ref: 'refs/tags/v1', inputs: { mode: 'collect' } }), false);
  assert.equal(runsProbe({ event: 'workflow_dispatch', inputs: { mode: 'probe' } }), true);
  assert.equal(runsProbe({ event: 'workflow_dispatch', inputs: { mode: 'collect' } }), false);
  assert.equal(runsProbe({ event: 'schedule' }), false);
});

test('concurrency: job-level groups, so cron and push runs never cancel a queued manual run (security-9)', () => {
  assert.equal(WF.concurrency, undefined, 'no workflow-level group shared by every trigger');
  const group = (event) => evalExpr(COLLECT.concurrency.group, context({ event, inputs: event === 'workflow_dispatch' ? { mode: 'collect' } : {} }));
  assert.equal(group('schedule'), 'parallel-timeline-auto');
  assert.equal(group('push'), 'parallel-timeline-auto');
  assert.equal(group('workflow_dispatch'), 'parallel-timeline-manual');
  assert.equal(PROBE.concurrency.group, 'parallel-timeline-probe');
  assert.equal(COLLECT.concurrency['cancel-in-progress'], false);
  assert.equal(PROBE.concurrency['cancel-in-progress'], false);
});

test('dispatch inputs: force and replace_window default to false; notes pushes trigger a run (security-1)', () => {
  const on = WF.on;
  assert.deepEqual(on.workflow_dispatch.inputs.force, { description: on.workflow_dispatch.inputs.force.description, type: 'boolean', default: false });
  assert.equal(on.workflow_dispatch.inputs.replace_window.type, 'boolean');
  assert.equal(on.workflow_dispatch.inputs.replace_window.default, false);
  assert.deepEqual(on.workflow_dispatch.inputs.mode.options, ['collect', 'probe']);
  assert.deepEqual(on.push.branches, ['main']);
  for (const p of ['data/*.json', 'data/parallel/notes/**', 'scripts/collect-parallel.js', 'parallel-core.js']) assert.ok(on.push.paths.includes(p), p);
  assert.deepEqual(on.schedule.map((s) => s.cron), ['7,22,37,52 23 * * 0-4', '7,22,37,52 0-7 * * 1-5', '17 8,10,13 * * 1-5']);
});

test('the Pages step runs only after an archive push on main of this repository (security-4, security-5, security-8)', () => {
  const pages = stepById('pages');
  const verifies = (archived, c = {}) => Boolean(evalExpr(pages.if, context({ ...c, steps: { archive: { outputs: { archived } } } })));
  assert.equal(verifies('true'), true);
  assert.equal(verifies('false'), false);
  assert.equal(verifies(''), false);
  assert.equal(verifies('true', { event: 'workflow_dispatch', ref: 'refs/heads/dev', inputs: { mode: 'collect' } }), false);
  assert.equal(verifies('true', { repository: 'someone/chatgpt-dot-monitoring-hub' }), false);
  assert.equal(pages.env.INDEX_FILE, '${{ steps.archive.outputs.index_file }}');
  assert.equal(pages.run, 'node scripts/request-parallel-pages-build.js "$INDEX_FILE"');
  assert.match(stepById('publish').run, /echo "pushed=\$pushed" >> "\$GITHUB_OUTPUT"/);
  assert.match(stepById('archive').run, /echo "archived=\$archived"/);
});

test('the probe job uploads only its status report (security-7)', () => {
  const upload = PROBE.steps.find((s) => String(s.uses).startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.path, 'probe-out/report.json');
  assert.equal(upload.with['retention-days'], 3);
  assert.ok(PROBE.steps.some((s) => s.run === 'node scripts/probe-parallel-sources.js probe-out'));
});

/** Copy of the job env plus a step's own literal env values (expressions are supplied by the caller). */
function stepEnv(id, given) {
  const out = {};
  for (const [k, v] of Object.entries(stepById(id).env || {})) {
    if (!String(v).includes('${{')) out[k] = String(v);
  }
  for (const k of Object.keys(stepById(id).env || {})) {
    if (String(stepById(id).env[k]).includes('${{')) assert.ok(Object.prototype.hasOwnProperty.call(given, k), `test supplies ${k}`);
  }
  return { ...out, ...given };
}

test('the collect step turns inputs into separate arguments and throttles push runs only (data-09)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-ops-args-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$ARGS_FILE"\n', { mode: 0o755 });
  const script = path.join(dir, 'collect.sh');
  fs.writeFileSync(script, stepById('collect').run);
  const call = (given) => {
    const argsFile = path.join(dir, 'args.txt');
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, ARGS_FILE: argsFile, HOME: dir,
      ...stepEnv('collect', { EVENT_NAME: 'schedule', OVERLAY_DIR: '', INPUT_DATE: '', INPUT_START: '', INPUT_END: '',
        INPUT_FORCE: '', INPUT_REPLACE_WINDOW: '', ...given }) };
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(argsFile, 'utf8').split('\n').slice(0, -1);
  };
  assert.deepEqual(call({}), ['scripts/collect-parallel.js']);
  assert.deepEqual(call({ OVERLAY_DIR: '/tmp/o v/data/parallel' }), ['scripts/collect-parallel.js', '--overlay-dir', '/tmp/o v/data/parallel']);
  assert.deepEqual(call({ EVENT_NAME: 'push' }), ['scripts/collect-parallel.js', '--throttle']);
  assert.deepEqual(call({ EVENT_NAME: 'workflow_dispatch', INPUT_DATE: '2026-11-04', INPUT_START: '09:00', INPUT_END: '15:30',
    INPUT_FORCE: 'true', INPUT_REPLACE_WINDOW: 'true' }),
  ['scripts/collect-parallel.js', '--date', '2026-11-04', '--start', '09:00', '--end', '15:30', '--force', '--replace-window']);
  assert.deepEqual(call({ EVENT_NAME: 'workflow_dispatch', INPUT_FORCE: 'false' }), ['scripts/collect-parallel.js'], 'force is opt-in');
  const hostile = '2026-11-04"; touch pwned; echo "$(id)';
  assert.deepEqual(call({ EVENT_NAME: 'workflow_dispatch', INPUT_DATE: hostile }), ['scripts/collect-parallel.js', '--date', hostile]);
  assert.ok(!fs.existsSync(path.join(dir, 'pwned')));
});

// ---------------------------------------------------------------- synthetic data

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A small valid session: one KOSPI series with a point every 15 minutes from the window start. */
function makeSession(date, { final = true, generatedAt, values = [100, 101.5] } = {}) {
  const win = Core.sessionWindow(date);
  const t0 = Date.parse(win.start);
  const gen = generatedAt || win.end;
  const points = values.map((v, k) => [Core.isoUtc(t0 + k * 900e3), v, Math.round(100 * (v / 100 - 1) * 1000) / 1000]);
  return { schemaVersion: 3, kind: 'session', date, timezone: 'Asia/Seoul', window: win, intervalMinutes: 15,
    generatedAt: gen, final,
    series: [{ id: 'kospi', panel: 'indices', label: '코스피', basis: 'prevClose', baseline: { value: 100, label: '전일 종가' },
      source: { provider: 'yahoo', symbol: '^KS11' }, status: 'ok', note: '', fetchedAt: gen, points }] };
}

const makeNotes = (date, extra = {}) => ({ schemaVersion: 3, kind: 'notes', date, title: '시험용 분석 노트', ...extra });

function indexFor(sessions, notes = []) {
  const byDate = new Map(notes.map((n) => [n.date, n]));
  const entries = sessions.map((s) => ({ date: s.date, title: byDate.has(s.date) ? byDate.get(s.date).title : null, final: s.final,
    seriesWithData: s.series.filter((x) => x.points.length).length, updatedAt: s.generatedAt, hasNotes: byDate.has(s.date) }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  return { schemaVersion: 3, kind: 'index', updatedAt: sessions.map((s) => s.generatedAt).sort().pop(), sessions: entries };
}

function writeDataDir(dir, { sessions = [], notes = [], index = indexFor(sessions, notes) } = {}) {
  for (const s of sessions) writeJson(path.join(dir, 'sessions', `${s.date}.json`), s);
  for (const n of notes) writeJson(path.join(dir, 'notes', `${n.date}.json`), n);
  if (index) writeJson(path.join(dir, 'index.json'), index);
  return dir;
}

const BAD_NOTES = makeNotes('2026-03-03', {
  events: [{ at: '2026-03-03T10:30:00+09:00', label: '오프셋 시각', kind: 'call' }],
  story: [{ text: '평문 링크', sources: [{ label: '출처', url: 'http://example.com/x' }] }],
});

function capture() {
  const out = { log: [], warn: [], error: [] };
  return { out, io: { env: {}, log: (l) => out.log.push(l), warn: (l) => out.warn.push(l), error: (l) => out.error.push(l) } };
}

// ---------------------------------------------------------------- validate-parallel --notes=warn

test('validate-parallel --notes=warn reports invalid analyst notes as warnings; sessions and index stay fatal (data-03, security-3)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-ops-validate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const session = makeSession('2026-03-03');
  writeDataDir(dir, { sessions: [session], notes: [BAD_NOTES] });
  fs.writeFileSync(path.join(dir, 'notes', 'draft.json'), '{}\n');

  const strict = Validate.validateDataDir(dir);
  assert.equal(strict.notesErrors.length, 2, strict.notesErrors.join('\n'));
  assert.deepEqual(strict.errors, strict.notesErrors);
  const lenient = Validate.validateDataDir(dir, { notes: 'warn' });
  assert.deepEqual(lenient.errors, []);
  assert.ok(lenient.warnings.some((w) => w.startsWith('notes/2026-03-03.json: ')), lenient.warnings.join('\n'));
  assert.ok(lenient.warnings.some((w) => w.startsWith('notes/draft.json: file name')));
  assert.throws(() => Validate.validateDataDir(dir, { notes: 'ignore' }), /notes mode/);

  let c = capture();
  assert.equal(Validate.main([dir], c.io), 1);
  assert.ok(c.out.error.some((l) => l.startsWith('error: notes/2026-03-03.json')));
  c = capture();
  assert.equal(Validate.main(['--notes=warn', dir], c.io), 0);
  assert.ok(c.out.warn.some((l) => l.startsWith('warning: notes/2026-03-03.json')));
  assert.match(c.out.log.at(-1), /2 invalid notes file\(s\) reported as warnings/);
  assert.equal(c.out.log.filter((l) => l.startsWith('::warning')).length, 0, 'annotations only inside GitHub Actions');
  c = capture();
  c.io.env = { GITHUB_ACTIONS: 'true' };
  assert.equal(Validate.main(['--notes', 'warn', dir], c.io), 0);
  assert.ok(c.out.log.some((l) => l.startsWith('::warning title=parallel notes::notes/2026-03-03.json')), c.out.log.join('\n'));

  // A broken session or index is still fatal with --notes=warn.
  const broken = makeSession('2026-03-04', { final: false });
  broken.series[0].points[1][2] = 7;
  writeDataDir(dir, { sessions: [session, broken], notes: [], index: indexFor([session, broken]) });
  c = capture();
  assert.equal(Validate.main(['--notes=warn', dir], c.io), 1);
  assert.ok(c.out.error.some((l) => l.includes('sessions/2026-03-04.json')), c.out.error.join('\n'));
  writeJson(path.join(dir, 'sessions', '2026-03-04.json'), makeSession('2026-03-04', { final: false }));
  writeJson(path.join(dir, 'index.json'), indexFor([session]));
  c = capture();
  assert.equal(Validate.main(['--notes=warn', dir], c.io), 1);
  assert.ok(c.out.error.some((l) => l.includes('sessions/2026-03-04.json is not listed')));
});

test('validate-parallel CLI: a directory argument, usage errors exit 2, the process exit status', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-ops-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeDataDir(dir, { sessions: [makeSession('2026-03-03')], notes: [BAD_NOTES] });
  for (const argv of [['--notes=maybe'], ['--notes'], ['--strict'], [dir, dir]]) {
    const c = capture();
    assert.equal(Validate.main(argv, c.io), 2, argv.join(' '));
    assert.match(c.out.error.join('\n'), /Usage: node scripts\/validate-parallel\.js/);
  }
  const script = path.join(ROOT, 'scripts', 'validate-parallel.js');
  const warn = spawnSync(process.execPath, [script, '--notes=warn', dir], { encoding: 'utf8', env: CHILD_ENV });
  assert.equal(warn.status, 0, warn.stderr);
  assert.match(warn.stderr, /warning: notes\/2026-03-03\.json/);
  const strict = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', env: CHILD_ENV });
  assert.equal(strict.status, 1);
});

// ---------------------------------------------------------------- probe (stubbed fetch)

const YAHOO_SYMBOLS = Probe.catalogSymbols('yahoo');
const CM_ASSETS = Probe.catalogSymbols('coinmetrics');
const MARKER = 'RAW-BODY-MARKER-9137';

function stubFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const res = await answer(url, calls.length);
    if (res instanceof Error) throw res;
    return { status: res.status, text: async () => res.body };
  };
  return { calls, fetchImpl };
}

const yahooBody = JSON.stringify({ chart: { result: [{ meta: { gmtoffset: 32400, exchangeTimezoneName: 'Asia/Seoul', note: MARKER },
  timestamp: [1793750400, 1793751300], indicators: { quote: [{ close: [1.5, 2.5], open: [1, 2] }] } }], error: null } });
const cmBody = JSON.stringify({ data: CM_ASSETS.map((asset) => ({ asset, time: '2026-11-04T10:00:00.000000000Z', ReferenceRateUSD: '12345.678901' })),
  extra: MARKER });
const ok = (url) => ({ status: 200, body: url.includes('coinmetrics') ? cmBody : yahooBody });

async function runProbe(answer, extra = {}) {
  const stub = stubFetch(answer);
  const sleeps = [];
  const report = await Probe.probe({ fetchImpl: stub.fetchImpl, now: () => Date.parse('2026-11-04T11:36:30Z'),
    sleep: async (ms) => { sleeps.push(ms); }, env: { GITHUB_REPOSITORY: 'someone/fork-hub' }, log: () => {}, ...extra });
  return { ...stub, sleeps, report };
}

test('the probe sends every request with the honest User-Agent, Coin Metrics included, and never a raw body (security-7, tests-09)', async () => {
  const { calls, sleeps, report } = await runProbe(ok);
  assert.equal(YAHOO_SYMBOLS.length, 19);
  assert.deepEqual(CM_ASSETS, ['btc', 'eth', 'hype', 'zec', 'xmr']);
  assert.equal(calls.length, 1 + 2 * YAHOO_SYMBOLS.length);
  const ua = userAgent({ GITHUB_REPOSITORY: 'someone/fork-hub' });
  assert.equal(ua, 'chatgpt-dot-monitoring-hub/2.0 (+https://github.com/someone/fork-hub)');
  for (const { init } of calls) {
    assert.equal(init.headers['User-Agent'], ua, 'no request with the runtime default User-Agent');
    assert.equal(init.redirect, 'manual');
  }
  assert.equal(new Set(calls.map((c) => c.url)).size, calls.length, 'no URL is asked twice');
  const cm = new URL(calls[0].url);
  assert.equal(cm.host, 'community-api.coinmetrics.io');
  assert.equal(cm.searchParams.get('assets'), CM_ASSETS.join(','));
  assert.equal(Date.parse(cm.searchParams.get('end_time')) - Date.parse(cm.searchParams.get('start_time')), 3600e3);
  const intraday = new URL(calls[1].url);
  const nowSec = Math.floor(Date.parse('2026-11-04T11:36:30Z') / 1000);
  assert.equal(intraday.host, 'query1.finance.yahoo.com');
  assert.equal(Number(intraday.searchParams.get('period2')), nowSec);
  assert.equal(Number(intraday.searchParams.get('period1')), nowSec - 5 * 86400, 'the intraday window follows the clock (not a fixed date)');
  assert.equal(new URL(calls[2].url).searchParams.get('range'), '1mo');
  assert.equal(sleeps.length, calls.length - 1);
  assert.ok(sleeps.every((ms) => ms >= 700));
  assert.equal(report.stopped, null);
  assert.equal(report.userAgent, ua);
  assert.equal(report.requests[0].rows, CM_ASSETS.length);
  assert.equal(report.requests[1].bars, 2);
  const text = JSON.stringify(report);
  assert.ok(!text.includes(MARKER) && !text.includes('12345.678901'), 'summaries only, never response bodies or values');
});

test('the probe stops at the first refusal and never retries or switches User-Agent (security-7, tests-09)', async () => {
  const yahoo429 = await runProbe((url, n) => (n === 2 ? { status: 429, body: 'Too Many Requests' } : ok(url)));
  assert.equal(yahoo429.calls.length, 2);
  assert.deepEqual({ provider: yahoo429.report.stopped.provider, reason: yahoo429.report.stopped.reason },
    { provider: 'yahoo', reason: 'HTTP 429' });
  for (const status of [401, 403, 451]) {
    const r = await runProbe((url, n) => (n === 4 ? { status, body: '' } : ok(url)));
    assert.equal(r.calls.length, 4, `HTTP ${status}`);
  }
  const cm403 = await runProbe(() => ({ status: 403, body: 'Forbidden' }));
  assert.equal(cm403.calls.length, 1);
  assert.equal(cm403.report.stopped.provider, 'coinmetrics');
  const redirect = await runProbe((url, n) => (n === 3 ? { status: 302, body: '' } : ok(url)));
  assert.equal(redirect.calls.length, 3);
  assert.equal(redirect.report.stopped.reason, 'redirect');
  const consent = await runProbe((url, n) => (n === 2 ? { status: 200, body: '<html>consent</html>' } : ok(url)));
  assert.equal(consent.calls.length, 2);
  assert.equal(consent.report.stopped.reason, 'not JSON');
  assert.ok(!JSON.stringify(consent.report).includes('consent'));
  const silent = await runProbe(() => Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
  assert.equal(silent.calls.length, 2);
  assert.equal(silent.report.requests[0].error, 'timeout');
  const flaky = await runProbe((url, n) => (n === 2 ? { status: 503, body: 'busy' } : ok(url)));
  assert.equal(flaky.calls.length, 1 + 2 * YAHOO_SYMBOLS.length, 'a 5xx is recorded, not retried, and does not stop the probe');
  assert.equal(new Set(flaky.calls.map((c) => c.url)).size, flaky.calls.length);
});

test('the probe CLI writes report.json and nothing else', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-ops-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'probe-out');
  const stub = stubFetch((url, n) => (n === 5 ? { status: 429, body: MARKER } : ok(url)));
  await Probe.main([out], { fetchImpl: stub.fetchImpl, sleep: async () => {}, log: () => {}, env: {} });
  assert.deepEqual(fs.readdirSync(out), ['report.json']);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.requests.length, 5);
  assert.equal(report.stopped.reason, 'HTTP 429');
  assert.ok(!fs.readFileSync(path.join(out, 'report.json'), 'utf8').includes(MARKER));
});

// ---------------------------------------------------------------- shared session picker of the push steps

test('the push steps\' session picker keeps the newest copy and validates both sides', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-ops-pick-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const from = path.join(dir, 'from');
  const to = path.join(dir, 'to');
  const s = (date, gen, final = true) => makeSession(date, { generatedAt: gen, final });
  writeJson(path.join(from, '2026-03-02.json'), s('2026-03-02', '2026-03-02T08:00:00Z')); // newer than to's
  writeJson(path.join(from, '2026-03-03.json'), s('2026-03-03', '2026-03-03T08:00:00Z')); // older than to's
  writeJson(path.join(from, '2026-03-04.json'), s('2026-03-04', '2026-03-04T08:00:00Z')); // to's copy is invalid
  writeJson(path.join(from, '2026-03-05.json'), s('2026-03-05', '2026-03-05T03:00:00Z', false)); // not final
  writeJson(path.join(from, '2026-03-06.json'), { ...s('2026-03-06', '2026-03-06T08:00:00Z'), kind: 'nope' }); // invalid
  writeJson(path.join(from, '2026-03-09.json'), s('2026-03-10', '2026-03-10T08:00:00Z')); // date differs from the name
  writeJson(path.join(to, '2026-03-02.json'), s('2026-03-02', '2026-03-02T07:30:00Z'));
  writeJson(path.join(to, '2026-03-03.json'), s('2026-03-03', '2026-03-03T09:00:00Z'));
  fs.writeFileSync(path.join(to, '2026-03-04.json'), '{"broken":');
  const pick = (...args) => {
    const r = spawnSync(process.execPath, ['-e', COLLECT.env.PICK_NEWER_SESSIONS_JS, ...args], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.split('\n').filter(Boolean);
  };
  assert.deepEqual(pick(from, to, 'final'), ['2026-03-02', '2026-03-04']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(to, '2026-03-03.json'), 'utf8')).generatedAt, '2026-03-03T09:00:00Z');
  assert.deepEqual(pick(from, to), ['2026-03-05']);
  assert.ok(!fs.existsSync(path.join(to, '2026-03-06.json')) && !fs.existsSync(path.join(to, '2026-03-09.json')));
  assert.deepEqual(pick(path.join(dir, 'missing'), path.join(dir, 'fresh')), []);
});

test('tests that read the live data/parallel files can be skipped by the workflow gate', (t) => {
  const offenders = fs.readdirSync(__dirname)
    .filter((n) => /^parallel-.*\.test\.js$/.test(n) && n !== path.basename(__filename))
    .filter((n) => {
      const src = fs.readFileSync(path.join(__dirname, n), 'utf8');
      return /path\.join\([^)]*'data',\s*'parallel'/.test(src) && !src.includes('PARALLEL_SKIP_LIVE_DATA_TESTS');
    });
  if (offenders.length) {
    t.todo(`honour PARALLEL_SKIP_LIVE_DATA_TESTS=1 in ${offenders.join(', ')} so invalid analyst notes cannot block price publication`);
  }
});

// ---------------------------------------------------------------- shell steps in a git sandbox

const HAVE_GIT = spawnSync('git', ['--version']).status === 0 && spawnSync('bash', ['--version']).status === 0;
const CODE_FILES = ['parallel-core.js', 'scripts/collect-parallel.js', 'scripts/validate-parallel.js'];

/**
 * origin.git (bare, main + data) and ws (a clone like actions/checkout with fetch-depth 0), plus RUNNER_TEMP.
 * Steps run with bash -eo pipefail like `shell: bash`; `sleep` is a no-op so retries are instant.
 */
class Sandbox {
  constructor(t) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-ops-git-'));
    t.after(() => fs.rmSync(this.root, { recursive: true, force: true }));
    this.runner = this.mkdir('runner');
    const bin = this.mkdir('bin');
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    this.env = { PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(path.delimiter), HOME: this.mkdir('home'),
      GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8', TZ: 'UTC', GIT_AUTHOR_NAME: 'tester', GIT_AUTHOR_EMAIL: 'tester@example.com',
      GIT_COMMITTER_NAME: 'tester', GIT_COMMITTER_EMAIL: 'tester@example.com' };
    this.origin = path.join(this.root, 'origin.git');
    this.git(['init', '--quiet', '--bare', '-b', 'main', this.origin]);
    const seed = this.mkdir('seed');
    this.git(['init', '--quiet', '-b', 'main', seed]);
    for (const f of CODE_FILES) {
      fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), path.join(seed, f));
    }
    this.s0303 = makeSession('2026-03-03', { generatedAt: '2026-03-03T07:30:00Z' });
    this.n0303 = makeNotes('2026-03-03');
    writeDataDir(path.join(seed, 'data', 'parallel'), { sessions: [this.s0303], notes: [this.n0303] });
    this.rebuildIndex(path.join(seed, 'data', 'parallel'));
    this.git(['add', '-A'], seed);
    this.git(['commit', '--quiet', '-m', 'seed'], seed);
    this.git(['push', '--quiet', this.origin, 'HEAD:refs/heads/main', 'HEAD:refs/heads/claude/dev-x'], seed);
    this.ws = path.join(this.root, 'ws');
    this.git(['clone', '--quiet', this.origin, this.ws]);
    this.data = path.join(this.ws, 'data', 'parallel');
    this.outputs = 0;
  }

  mkdir(name) {
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  git(args, cwd = this.root) {
    const r = spawnSync('git', args, { cwd, env: this.env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  }

  rebuildIndex(dataDir) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'collect-parallel.js'), '--rebuild-index', '--data-dir', dataDir],
      { encoding: 'utf8', env: CHILD_ENV });
    assert.equal(r.status, 0, r.stderr);
  }

  /** The origin's copy of a file on a branch, or null. */
  show(branch, file) {
    const r = spawnSync('git', ['--git-dir', this.origin, 'show', `${branch}:${file}`], { env: this.env, encoding: 'utf8' });
    return r.status === 0 ? r.stdout : null;
  }

  files(branch) {
    return this.git(['--git-dir', this.origin, 'ls-tree', '-r', '--name-only', branch]).split('\n').filter(Boolean);
  }

  log(branch) {
    return this.git(['--git-dir', this.origin, 'log', '--format=%s', branch]).split('\n');
  }

  /** Run a collect-job step's script -> {status, stdout, stderr, outputs}. */
  step(id, given = {}) {
    const file = path.join(this.root, `${id}.sh`);
    fs.writeFileSync(file, stepById(id).run);
    const out = path.join(this.root, `output-${++this.outputs}.txt`);
    fs.writeFileSync(out, '');
    const env = { ...this.env, ...stepEnv(id, given), GITHUB_OUTPUT: out, RUNNER_TEMP: this.runner, GITHUB_WORKSPACE: this.ws,
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: UPSTREAM, GITHUB_RUN_ID: '7',
      PICK_NEWER_SESSIONS_JS: COLLECT.env.PICK_NEWER_SESSIONS_JS };
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], { cwd: this.ws, env, encoding: 'utf8' });
    const outputs = {};
    for (const line of fs.readFileSync(out, 'utf8').split('\n').filter(Boolean)) {
      const eq = line.indexOf('=');
      outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
    assert.ok(!`${r.stdout}${r.stderr}`.includes('test-token'), 'the token is never printed');
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, outputs };
  }

  prepare(ref = 'main') {
    return this.step('prepare', { REF_NAME: ref });
  }

  publish(branch = 'parallel-data', extra = {}) {
    return this.step('publish', { GH_TOKEN: 'test-token', DATA_BRANCH: branch, ...extra });
  }

  archive(ref = 'main') {
    return this.step('archive', { GH_TOKEN: 'test-token', REF_NAME: ref });
  }

  /** What the collector would leave behind: a session file (and its refreshed index) in the workspace. */
  collected(session) {
    writeJson(path.join(this.data, 'sessions', `${session.date}.json`), session);
    this.rebuildIndex(this.data);
  }
}

const sessionOn = (sb, branch, date) => {
  const text = sb.show(branch, `data/parallel/sessions/${date}.json`);
  return text === null ? null : JSON.parse(text);
};

test('first run: the data branch is created as an orphan holding data/parallel only; live data stays off main', { skip: !HAVE_GIT }, (t) => {
  const sb = new Sandbox(t);
  const mainBefore = sb.git(['--git-dir', sb.origin, 'rev-parse', 'main']);
  const prep = sb.prepare();
  assert.equal(prep.status, 0, prep.stderr);
  assert.deepEqual(prep.outputs, { overlay_dir: '', data_branch: 'parallel-data' });

  sb.collected(makeSession('2026-03-04', { final: false, generatedAt: '2026-03-04T01:07:00Z' }));
  const pub = sb.publish();
  assert.equal(pub.status, 0, pub.stderr);
  assert.equal(pub.outputs.pushed, 'true');
  assert.deepEqual(sb.files('parallel-data'), ['data/parallel/index.json', 'data/parallel/notes/2026-03-03.json',
    'data/parallel/sessions/2026-03-03.json', 'data/parallel/sessions/2026-03-04.json']);
  assert.equal(sb.git(['--git-dir', sb.origin, 'rev-list', '--count', 'parallel-data']), '1', 'an orphan branch: no main history');
  assert.match(sb.log('parallel-data')[0], /^Update parallel timeline data \(\d{4}-\d{2}-\d{2} \d{2}:\d{2} KST\)$/);
  const index = JSON.parse(sb.show('parallel-data', 'data/parallel/index.json'));
  assert.deepEqual(index.sessions.map((e) => [e.date, e.final, e.title]), [['2026-03-04', false, null], ['2026-03-03', true, '시험용 분석 노트']]);
  assert.equal(Validate.main(['--notes=warn', sb.data], capture().io), 0);

  const arc = sb.archive();
  assert.equal(arc.status, 0, arc.stderr);
  assert.equal(arc.outputs.archived, 'false', 'a live session is not archived');
  assert.equal(sb.git(['--git-dir', sb.origin, 'rev-parse', 'main']), mainBefore, 'main is untouched by intraday data');

  const again = sb.publish();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.outputs.pushed, 'false', 'nothing new: no empty commit');
  assert.equal(sb.git(['--git-dir', sb.origin, 'rev-list', '--count', 'parallel-data']), '1');
});

test('a later run reads the data branch as the overlay, publishes on top of it and archives the final session to main', { skip: !HAVE_GIT }, (t) => {
  const sb = new Sandbox(t);
  sb.collected(makeSession('2026-03-04', { final: false, generatedAt: '2026-03-04T01:07:00Z' }));
  assert.equal(sb.publish().outputs.pushed, 'true');

  // Next run: a fresh checkout of main (no 03-04 there) that fetched every branch.
  fs.rmSync(path.join(sb.data, 'sessions', '2026-03-04.json'));
  sb.git(['checkout', '--quiet', '--', 'data/parallel/index.json'], sb.ws);
  sb.git(['fetch', '--quiet', 'origin'], sb.ws);
  const prep = sb.prepare();
  assert.equal(prep.status, 0, prep.stderr);
  assert.equal(prep.outputs.overlay_dir, path.join(sb.runner, 'parallel-overlay', 'data', 'parallel'));
  assert.deepEqual(fs.readdirSync(path.join(prep.outputs.overlay_dir, 'sessions')).sort(), ['2026-03-03.json', '2026-03-04.json']);
  assert.ok(!fs.existsSync(path.join(prep.outputs.overlay_dir, 'notes')), 'notes never come from the overlay');
  assert.equal(fs.readFileSync(path.join(prep.outputs.overlay_dir, 'sessions', '2026-03-04.json'), 'utf8'),
    sb.show('parallel-data', 'data/parallel/sessions/2026-03-04.json'));

  const final = makeSession('2026-03-04', { final: true, generatedAt: '2026-03-04T07:22:00Z', values: [100, 99, 102] });
  sb.collected(final);
  const pub = sb.publish();
  assert.equal(pub.outputs.pushed, 'true', pub.stderr);
  assert.equal(sb.git(['--git-dir', sb.origin, 'rev-list', '--count', 'parallel-data']), '2');
  assert.deepEqual(sessionOn(sb, 'parallel-data', '2026-03-04'), final);

  const arc = sb.archive();
  assert.equal(arc.status, 0, arc.stderr);
  assert.equal(arc.outputs.archived, 'true');
  assert.equal(arc.outputs.dates, '2026-03-04');
  assert.equal(sb.log('main')[0], 'Archive parallel timeline session 2026-03-04');
  assert.deepEqual(sessionOn(sb, 'main', '2026-03-04'), final);
  const mainIndex = sb.show('main', 'data/parallel/index.json');
  assert.equal(fs.readFileSync(arc.outputs.index_file, 'utf8'), mainIndex, 'the Pages step verifies exactly what main serves');
  assert.deepEqual(JSON.parse(mainIndex).sessions.map((e) => [e.date, e.final]), [['2026-03-04', true], ['2026-03-03', true]]);
  assert.deepEqual(sb.files('main').filter((f) => !f.startsWith('data/')).sort(), [...CODE_FILES].sort(), 'only data/parallel changes on main');

  const again = sb.archive();
  assert.equal(again.outputs.archived, 'false');
  assert.equal(sb.log('main').length, 2);
});

test('overlapping runs: newest generatedAt wins, notes are mirrored from the branch, and a rejected push is rebuilt on the latest commit', { skip: !HAVE_GIT }, (t) => {
  const sb = new Sandbox(t);
  sb.collected(makeSession('2026-03-05', { final: false, generatedAt: '2026-03-05T02:00:00Z' }));
  assert.equal(sb.publish().outputs.pushed, 'true');

  // Another run has meanwhile published a newer 03-05; this run's older copy must not replace it.
  const other = path.join(sb.root, 'other');
  sb.git(['clone', '--quiet', '--branch', 'parallel-data', sb.origin, other]);
  const newer = makeSession('2026-03-05', { final: false, generatedAt: '2026-03-05T02:30:00Z', values: [100, 103] });
  writeJson(path.join(other, 'data', 'parallel', 'sessions', '2026-03-05.json'), newer);
  sb.rebuildIndex(path.join(other, 'data', 'parallel'));
  sb.git(['commit', '--quiet', '-am', 'Other run'], other);
  sb.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/parallel-data'], other);
  const stale = sb.publish();
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(stale.outputs.pushed, 'false');
  assert.deepEqual(sessionOn(sb, 'parallel-data', '2026-03-05'), newer);

  // Notes changed on main: mirrored, and the index title follows.
  writeJson(path.join(sb.data, 'notes', '2026-03-03.json'), makeNotes('2026-03-03', { title: '고친 제목' }));
  writeJson(path.join(sb.data, 'notes', '2026-03-05.json'), makeNotes('2026-03-05', { title: '새 노트' }));
  // The race: a concurrent run pushes just before this run's push, which is then rejected and rebuilt.
  const raceDir = sb.mkdir('race');
  writeJson(path.join(raceDir, '2026-03-06.json'), makeSession('2026-03-06', { final: false, generatedAt: '2026-03-06T01:00:00Z' }));
  const hook = path.join(sb.ws, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(hook, [
    '#!/bin/sh',
    'cat > /dev/null',
    `[ -f "${raceDir}/raced" ] && exit 0`,
    `touch "${raceDir}/raced"`,
    'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX',
    `cd "${other}" || exit 1`,
    'git pull --quiet --ff-only origin parallel-data || exit 1',
    `cp "${raceDir}/2026-03-06.json" data/parallel/sessions/2026-03-06.json`,
    'git add -A && git commit --quiet -m "Concurrent run" && git push --quiet origin HEAD:refs/heads/parallel-data',
    '',
  ].join('\n'), { mode: 0o755 });
  const raced = sb.publish();
  fs.rmSync(hook);
  assert.equal(raced.status, 0, raced.stderr);
  assert.equal(raced.outputs.pushed, 'true');
  assert.match(raced.stderr, /rejected \(attempt 1\)/);
  const subjects = sb.log('parallel-data');
  assert.match(subjects[0], /^Update parallel timeline data/);
  assert.equal(subjects[1], 'Concurrent run', 'rebuilt on top of the concurrent commit (no force push)');
  assert.ok(sessionOn(sb, 'parallel-data', '2026-03-06'), 'the concurrent run\'s session survives');
  assert.deepEqual(sessionOn(sb, 'parallel-data', '2026-03-05'), newer);
  assert.equal(JSON.parse(sb.show('parallel-data', 'data/parallel/notes/2026-03-05.json')).title, '새 노트');
  const index = JSON.parse(sb.show('parallel-data', 'data/parallel/index.json'));
  assert.deepEqual(index.sessions.map((e) => [e.date, e.title]),
    [['2026-03-06', null], ['2026-03-05', '새 노트'], ['2026-03-03', '고친 제목']]);
});

test('a push that keeps failing stops after 3 attempts without forcing; invalid notes never block publication', { skip: !HAVE_GIT }, (t) => {
  const sb = new Sandbox(t);
  // Invalid analyst notes on main: the data branch and the archive still publish (notes only warn).
  writeJson(path.join(sb.data, 'notes', '2026-03-03.json'), BAD_NOTES);
  sb.collected(makeSession('2026-03-04', { final: true, generatedAt: '2026-03-04T07:21:00Z' }));
  const pub = sb.publish();
  assert.equal(pub.status, 0, pub.stderr);
  assert.equal(pub.outputs.pushed, 'true');
  assert.match(pub.stderr, /warning: notes\/2026-03-03\.json/);
  sb.git(['add', '-A', 'data/parallel/notes'], sb.ws);
  sb.git(['commit', '--quiet', '-m', 'Bad notes'], sb.ws);
  sb.git(['push', '--quiet', 'origin', 'HEAD:refs/heads/main'], sb.ws);
  const arc = sb.archive();
  assert.equal(arc.status, 0, arc.stderr);
  assert.equal(arc.outputs.archived, 'true');

  const hook = path.join(sb.origin, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\necho "denied by test" >&2\nexit 1\n', { mode: 0o755 });
  const before = sb.git(['--git-dir', sb.origin, 'rev-parse', 'parallel-data']);
  sb.collected(makeSession('2026-03-05', { final: false, generatedAt: '2026-03-05T01:00:00Z' }));
  const denied = sb.publish();
  assert.equal(denied.status, 1);
  assert.equal(denied.outputs.pushed, 'false');
  assert.equal((denied.stderr.match(/rejected \(attempt \d\)/g) || []).length, 3);
  assert.match(denied.stderr, /no force push was attempted/);
  assert.equal(sb.git(['--git-dir', sb.origin, 'rev-parse', 'parallel-data']), before);
});

test('a branch other than main publishes to its own data branch and archives to itself', { skip: !HAVE_GIT }, (t) => {
  const sb = new Sandbox(t);
  const names = { 'claude/dev-x': 'parallel-data-claude-dev-x', 'feat/a+b@c': 'parallel-data-feat-a-b-c', main: 'parallel-data' };
  const locales = spawnSync('locale', ['-a'], { encoding: 'utf8' });
  if (/^C\.(utf8|UTF-8)$/m.test(locales.stdout || '')) names['fix/한글'] = 'parallel-data-fix---'; // one '-' per character
  for (const [ref, expected] of Object.entries(names)) {
    const prep = sb.prepare(ref);
    assert.equal(prep.status, 0, prep.stderr);
    assert.equal(prep.outputs.data_branch, expected, ref);
  }
  const mainBefore = sb.git(['--git-dir', sb.origin, 'rev-parse', 'main']);
  sb.collected(makeSession('2026-03-04', { final: true, generatedAt: '2026-03-04T07:21:00Z' }));
  assert.equal(sb.publish('parallel-data-claude-dev-x').outputs.pushed, 'true');
  const arc = sb.archive('claude/dev-x');
  assert.equal(arc.status, 0, arc.stderr);
  assert.equal(arc.outputs.archived, 'true');
  assert.ok(sessionOn(sb, 'claude/dev-x', '2026-03-04'));
  assert.ok(sessionOn(sb, 'parallel-data-claude-dev-x', '2026-03-04'));
  assert.equal(sb.git(['--git-dir', sb.origin, 'rev-parse', 'main']), mainBefore);
  assert.equal(spawnSync('git', ['--git-dir', sb.origin, 'rev-parse', '--verify', '--quiet', 'parallel-data'], { env: sb.env }).status, 1);
});
