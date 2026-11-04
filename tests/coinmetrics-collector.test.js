'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../scripts/update-parallel-prices.js');
const P = require('../parallel-data.js');

const NOW = Date.parse('2026-11-04T00:46:12Z');
const START = '2026-11-03T23:00:00.000Z';
const MINUTE = 60000;
const clone = value => JSON.parse(JSON.stringify(value));
const clock = value => () => value;
const apiTime = at => new Date(at).toISOString().replace('.000Z', '.000000000Z');

function emptySeries(label, panel = 'crypto') {
  return { id: `${panel}-${label.toLowerCase()}`, panel, label, instrument: `${label} · 공급자 미확인`,
    basis: '공급자 기준 미확인', provider: '미확인', sourceUrl: null, verification: 'unverified',
    redistribution: 'unverified', availability: 'unsupported', asOf: null, observedAt: null,
    delaySeconds: null, marketState: 'unknown', points: [] };
}
function initial() {
  return { schemaVersion: 1, mode: 'observed', title: '병렬 시장 표본',
    publishedAt: new Date(NOW - MINUTE).toISOString(),
    window: { start: START, end: '2026-11-04T00:30:00.000Z', timezone: 'Asia/Seoul', intervalMinutes: 15 },
    series: [emptySeries('표본 지수', 'indices'), ...C.ASSETS.map(a => emptySeries(a.label))], events: [], stories: [] };
}
function rowsFor(nowMs = NOW, { minutes = [0, 15, 30, 45, 60, 75, 90, 105, 106], exclude = [] } = {}) {
  const start = Date.parse(C.sessionWindow(nowMs).start);
  return C.ASSETS.flatMap((a, i) => exclude.includes(a.asset) ? [] : minutes.map(minute => ({
    asset: a.asset, time: apiTime(start + minute * MINUTE), ReferenceRateUSD: (100 + i * 100 + minute / 10).toFixed(8)
  })));
}
function receipt(rows, nowMs = NOW) {
  const window = C.sessionWindow(nowMs);
  return { window, rows, observedAt: new Date(nowMs).toISOString(), pages: 1, requestUrl: C.requestUrl(window) };
}
function build(previous = initial(), rows = rowsFor(), nowMs = NOW) {
  return C.buildDataset(previous, receipt(rows, nowMs), { now: clock(nowMs + 500) });
}
function byAsset(data, asset) {
  return data.providers.flatMap(p => p.series).find(s => s.asset === asset);
}
function numericSeries(data, asset) {
  const raw = byAsset(data, asset);
  return raw && data.series.find(s => s.id === raw.id);
}
function response(body, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    text: async () => JSON.stringify(body) };
}
function temporaryDirectory() {
  return fs.mkdtempSync(path.join(__dirname, '..', '.collector-test-'));
}
function removeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(__dirname, '..'));
  assert.ok(path.basename(resolved).startsWith('.collector-test-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}

test('KST 08:00 sessions cross UTC midnight and the pre-08:00 period uses the previous day', () => {
  assert.equal(C.sessionWindow(NOW).start, START);
  assert.equal(C.sessionWindow(NOW).end, '2026-11-04T00:46:00.000Z');
  assert.equal(C.sessionWindow(NOW).sessionDate, '2026-11-04');
  const before = C.sessionWindow(Date.parse('2026-11-04T22:59:59Z'));
  assert.equal(before.start, START);
  assert.equal(before.sessionDate, '2026-11-04');
  const after = C.sessionWindow(Date.parse('2026-11-04T23:01:05Z'));
  assert.equal(after.start, '2026-11-04T23:00:00.000Z');
  assert.equal(after.sessionDate, '2026-11-05');
  assert.throws(() => C.sessionWindow(Date.parse('2026-11-04T23:00:30Z')), /completed minute/);
  assert.throws(() => C.sessionWindow(Number.NaN));
});

test('request selects exactly the reviewed assets, metric, one-minute range and oldest-first paging', () => {
  const u = new URL(C.requestUrl(C.sessionWindow(NOW)));
  assert.equal(u.origin, 'https://community-api.coinmetrics.io');
  assert.equal(u.pathname, '/v4/timeseries/asset-metrics');
  assert.deepEqual(new Set(u.searchParams.get('assets').split(',')), new Set(['btc', 'eth', 'hype', 'zec', 'xmr']));
  assert.equal(u.searchParams.get('metrics'), 'ReferenceRateUSD');
  assert.equal(u.searchParams.get('frequency'), '1m');
  assert.equal(u.searchParams.get('paging_from'), 'start');
  assert.equal(Date.parse(u.searchParams.get('start_time')), Date.parse(START));
  assert.equal(Date.parse(u.searchParams.get('end_time')), Date.parse('2026-11-04T00:46:00Z'));
  assert.equal(u.searchParams.has('api_key'), false);
});

test('a fresh publication derives exact 15-minute samples while preserving raw decimals and source clocks', () => {
  const previous = initial(), snapshot = clone(previous);
  const { data } = build(previous);
  assert.deepEqual(previous, snapshot);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.mode, 'observed');
  assert.equal(data.series.filter(s => s.points.length).length, 5);
  assert.deepEqual(data.series.find(s => s.panel === 'indices'), previous.series[0]);
  const btc = numericSeries(data, 'btc'), raw = byAsset(data, 'btc');
  assert.equal(raw.baseline.at, START);
  assert.equal(raw.baseline.value, '100.00000000');
  assert.equal(raw.latest.at, '2026-11-04T00:46:00.000Z');
  assert.equal(raw.latest.value, '110.60000000');
  assert.equal(btc.asOf, '2026-11-04T00:45:00.000Z');
  assert.equal(btc.observedAt, new Date(NOW).toISOString());
  assert.equal(raw.observedAt, btc.observedAt);
  assert.equal(raw.samples.length, 8);
  assert.equal(raw.samples[1].value, '101.50000000');
  assert.equal(btc.points[1].pct, (101.5 / 100 - 1) * 100);
  assert.ok(btc.points.every(p => Date.parse(p.at) % (15 * MINUTE) === 0));
  assert.equal(btc.points.some(p => p.at === raw.latest.at), false);
  assert.equal(data.providers[0].licenseName, 'CC BY-NC 4.0');
  assert.equal(data.providers[0].licenseUrl, 'https://creativecommons.org/licenses/by-nc/4.0/');
  assert.match(data.providers[0].attribution, /Coin Metrics/);
  assert.equal(P.validateDataset(data, { now: NOW + 500 }).schemaVersion, 2);
});

test('missing observation rows remain chart gaps and are never interpolated or zero-filled', () => {
  const rows = rowsFor().filter(r => r.asset !== 'btc' || !['2026-11-03T23:30:00.000000000Z', '2026-11-03T23:45:00.000000000Z'].includes(r.time));
  const { data } = build(initial(), rows);
  const btc = numericSeries(data, 'btc');
  assert.equal(btc.points.length, 6);
  assert.equal(btc.points.some(p => p.at === '2026-11-03T23:30:00.000Z'), false);
  assert.equal(P.segments(btc.points).length, 2);
  assert.equal(P.summarizeSeries(btc, data.window).missingGridCount, 2);
});

test('a recent-only response can extend a session using its previously observed exact baseline', () => {
  const first = build().data;
  const nextNow = NOW + 15 * MINUTE;
  const nextRows = rowsFor(nextNow, { minutes: [120, 121] });
  const { data } = build(first, nextRows, nextNow);
  const before = byAsset(first, 'btc'), after = byAsset(data, 'btc');
  assert.deepEqual(after.baseline, before.baseline);
  assert.deepEqual(after.samples.slice(0, before.samples.length), before.samples);
  assert.deepEqual(numericSeries(data, 'btc').points.slice(0, before.samples.length), numericSeries(first, 'btc').points);
  assert.equal(after.samples.at(-1).at, '2026-11-04T01:00:00.000Z');
  assert.equal(after.latest.at, '2026-11-04T01:01:00.000Z');
  assert.equal(numericSeries(data, 'btc').id, numericSeries(first, 'btc').id);
});

test('an unverified near-baseline price cannot substitute for a missing exact 08:00 baseline', () => {
  const previous = initial(), snapshot = clone(previous);
  const rows = rowsFor(NOW, { minutes: [1, 15, 30, 105, 106] });
  assert.throws(() => build(previous, rows));
  assert.deepEqual(previous, snapshot);
});

test('a newly unsupported asset does not prevent independently valid assets from updating', () => {
  const { data } = build(initial(), rowsFor(NOW, { exclude: ['zec'] }));
  assert.equal(data.series.filter(s => s.points.length).length, 4);
  assert.equal(data.series.find(s => s.label === 'ZEC').points.length, 0);
  assert.equal(data.series.find(s => s.label === 'ZEC').availability, 'unsupported');
  assert.equal(byAsset(data, 'zec'), undefined);
});

test('an asset missing from a later response retains its own last-good values and observation time', () => {
  const first = build().data;
  const nextNow = NOW + 15 * MINUTE;
  const { data } = build(first, rowsFor(nextNow, { minutes: [120, 121], exclude: ['btc'] }), nextNow);
  assert.deepEqual(numericSeries(data, 'btc'), numericSeries(first, 'btc'));
  assert.deepEqual(byAsset(data, 'btc'), byAsset(first, 'btc'));
  assert.equal(byAsset(data, 'eth').observedAt, new Date(nextNow).toISOString());
});

test('conflicting overlapping raw prices fail instead of silently rewriting published history', () => {
  const first = build().data, snapshot = clone(first);
  const changed = rowsFor().map(r => r.asset === 'btc' && r.time === '2026-11-03T23:15:00.000000000Z' ? { ...r, ReferenceRateUSD: '999.00000000' } : r);
  assert.throws(() => build(first, changed));
  assert.deepEqual(first, snapshot);
});

test('decimal formatting may vary but a real raw-rate revision cannot hide behind floating-point rounding', () => {
  const initialRows = rowsFor().map(r => r.asset === 'btc' && r.time === '2026-11-03T23:00:00.000000000Z'
    ? { ...r, ReferenceRateUSD: '100.000000000000000001' } : r);
  const first = build(initial(), initialRows).data;
  const changed = initialRows.map(r => r.asset === 'btc' && r.time === '2026-11-03T23:00:00.000000000Z'
    ? { ...r, ReferenceRateUSD: '100.000000000000000002' } : r);
  assert.throws(() => build(first, changed));
  const ordinary = build().data;
  const reformatted = rowsFor().map(r => r.asset === 'btc' && r.time === '2026-11-03T23:00:00.000000000Z'
    ? { ...r, ReferenceRateUSD: '100.0' } : r);
  const next = build(ordinary, reformatted).data;
  assert.equal(byAsset(next, 'btc').baseline.value, '100.00000000');
});

test('a regressing asset calculation clock cannot advance its observation clock while other assets update', () => {
  const first = build().data;
  const nextNow = NOW + 15 * MINUTE;
  const nextRows = rowsFor(nextNow, { minutes: [120, 121], exclude: ['btc'] }).concat(
    rowsFor(NOW, { minutes: [0, 15, 30] }).filter(r => r.asset === 'btc'));
  const { data, summary } = build(first, nextRows, nextNow);
  assert.deepEqual(numericSeries(data, 'btc'), numericSeries(first, 'btc'));
  assert.deepEqual(byAsset(data, 'btc'), byAsset(first, 'btc'));
  assert.ok(summary.retained.some(row => row.asset === 'btc'));
  assert.equal(byAsset(data, 'eth').latest.at, '2026-11-04T01:01:00.000Z');
});

test('new sessions use new identity and baseline rather than relabeling the previous day percentage series', () => {
  const first = build().data;
  const nextNow = Date.parse('2026-11-04T23:01:12Z');
  const { data } = build(first, rowsFor(nextNow, { minutes: [0, 1] }), nextNow);
  assert.equal(data.window.start, '2026-11-04T23:00:00.000Z');
  assert.notEqual(numericSeries(data, 'btc').id, numericSeries(first, 'btc').id);
  assert.notEqual(numericSeries(data, 'btc').basis, numericSeries(first, 'btc').basis);
  assert.deepEqual(numericSeries(data, 'btc').points, [{ at: data.window.start, pct: 0 }]);
});

test('a missing asset at the next 08:00 session becomes unsupported instead of reusing yesterday baseline', () => {
  const first = build().data;
  const nextNow = Date.parse('2026-11-04T23:01:12Z');
  const { data } = build(first, rowsFor(nextNow, { minutes: [0, 1], exclude: ['btc'] }), nextNow);
  const btc = data.series.find(s => s.panel === 'crypto' && s.label === 'BTC');
  assert.equal(btc.availability, 'unsupported');
  assert.equal(btc.asOf, null);
  assert.deepEqual(btc.points, []);
  assert.notEqual(btc.id, numericSeries(first, 'btc').id);
  assert.equal(byAsset(data, 'btc'), undefined);
  assert.equal(data.series.filter(s => s.points.length).length, 4);
});

test('an asset missing across consecutive sessions receives the current session placeholder identity and basis', () => {
  const first = build(initial(), rowsFor(NOW, { exclude: ['btc'] })).data;
  const nextNow = Date.parse('2026-11-04T23:01:12Z');
  const second = build(first, rowsFor(nextNow, { minutes: [0, 1], exclude: ['btc'] }), nextNow).data;
  const thirdNow = Date.parse('2026-11-05T23:01:12Z');
  const third = build(second, rowsFor(thirdNow, { minutes: [0, 1], exclude: ['btc'] }), thirdNow).data;
  const missing = data => data.series.find(s => s.panel === 'crypto' && s.label === 'BTC');
  assert.equal(missing(second).id, 'cm-btc-unsupported-2026-11-05');
  assert.equal(missing(third).id, 'cm-btc-unsupported-2026-11-06');
  assert.match(missing(third).basis, /2026-11-06 08:00 KST/);
  assert.notEqual(missing(third).basis, missing(second).basis);
  assert.equal(missing(third).availability, 'unsupported');
  assert.equal(missing(third).asOf, null);
  assert.deepEqual(missing(third).points, []);
  const laterNow = thirdNow + MINUTE;
  const later = build(third, rowsFor(laterNow, { minutes: [0, 1, 2], exclude: ['btc'] }), laterNow).data;
  assert.deepEqual(missing(later), missing(third));
});

test('invalid numeric raw rates are never promoted to verified public points', () => {
  for (const bad of ['0', '-1', 'NaN', 'Infinity', '1e309', ' 100 ', '1e2']) {
    const rows = rowsFor().map(r => ({ ...r, ReferenceRateUSD: bad }));
    assert.throws(() => build(initial(), rows), `raw rate ${bad}`);
  }
});

test('pagination follows the original permitted next-page URL and never publishes its page token', async () => {
  const window = C.sessionWindow(NOW), firstUrl = C.requestUrl(window);
  const next = new URL(firstUrl); next.searchParams.set('next_page_token', 'public-pagination-cursor');
  const calls = [], sleeps = [];
  const rows = rowsFor();
  const fetched = await C.fetchRows({ window, now: clock(NOW), sleepImpl: async ms => sleeps.push(ms), fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return response({ data: calls.length === 1 ? rows.slice(0, 20) : rows.slice(20), next_page_url: calls.length === 1 ? next.href : null });
  }});
  assert.deepEqual(calls.map(c => c.url), [firstUrl, next.href]);
  assert.equal(fetched.pages, 2);
  assert.equal(fetched.rows.length, rows.length);
  assert.equal(fetched.requestUrl, firstUrl);
  assert.equal(fetched.requestUrl.includes('next_page_token'), false);
  assert.ok(calls.every(c => c.options.signal instanceof AbortSignal));
  assert.ok(sleeps.length > 0);
});

test('the provider may normalize equivalent ISO bounds in a continuation without changing the requested range', async () => {
  const window = C.sessionWindow(NOW), firstUrl = C.requestUrl(window);
  const next = new URL(firstUrl);
  for (const key of ['start_time', 'end_time']) next.searchParams.set(key, next.searchParams.get(key).replace('.000Z', 'Z'));
  next.searchParams.set('next_page_token', 'normalized-cursor');
  const urls = [];
  const fetched = await C.fetchRows({ window, now: clock(NOW), sleepImpl: async () => {}, fetchImpl: async url => {
    urls.push(String(url));
    return response({ data: [], next_page_url: urls.length === 1 ? next.href : null });
  }});
  assert.deepEqual(urls, [firstUrl, next.href]);
  assert.equal(fetched.requestUrl, firstUrl);
  assert.equal(fetched.pages, 2);
});

test('repeated page-boundary observations collapse only when their exact decimal values agree', () => {
  const original = rowsFor();
  const same = original.concat({ ...original[0], ReferenceRateUSD: '100.0' });
  const { data } = build(initial(), same);
  assert.equal(numericSeries(data, 'btc').points.length, 8);
  assert.equal(byAsset(data, 'btc').baseline.value, '100.00000000');
  assert.throws(() => build(initial(), original.concat({ ...original[0], ReferenceRateUSD: '101.0' })));
});

test('pagination rejects a changed origin, path or asset selection before making that request', async () => {
  const window = C.sessionWindow(NOW), base = C.requestUrl(window);
  for (const edit of [u => { u.hostname = 'attacker.invalid'; }, u => { u.pathname = '/v4/other'; }, u => { u.searchParams.set('assets', 'btc'); }]) {
    const next = new URL(base); edit(next);
    let calls = 0;
    await assert.rejects(C.fetchRows({ window, now: clock(NOW), sleepImpl: async () => {}, fetchImpl: async () => {
      calls++; return response({ data: [], next_page_url: next.href });
    }}));
    assert.equal(calls, 1);
  }
});

test('pagination loops, excessive page count and oversized bodies are bounded', async () => {
  const window = C.sessionWindow(NOW), base = C.requestUrl(window);
  await assert.rejects(C.fetchRows({ window, now: clock(NOW), sleepImpl: async () => {}, fetchImpl: async () => response({ data: [], next_page_url: base }) }));
  let calls = 0;
  const next = new URL(base); next.searchParams.set('next_page_token', 'second');
  await assert.rejects(C.fetchRows({ window, maxPages: 1, now: clock(NOW), sleepImpl: async () => {}, fetchImpl: async () => {
    calls++; return response({ data: [], next_page_url: next.href });
  }}));
  assert.equal(calls, 1);
  await assert.rejects(C.fetchRows({ window, maxBytes: 100, now: clock(NOW), sleepImpl: async () => {}, fetchImpl: async () => response({ data: [], padding: 'a'.repeat(200) }) }));
});

test('rate-limit retry is bounded and a later successful response keeps the original request scope', async () => {
  const window = C.sessionWindow(NOW), sleeps = [], urls = [];
  const data = rowsFor();
  const fetched = await C.fetchRows({ window, now: clock(NOW), sleepImpl: async ms => sleeps.push(ms), fetchImpl: async url => {
    urls.push(String(url));
    return urls.length === 1 ? response({}, 429, { 'retry-after': '3' }) : response({ data });
  }});
  assert.deepEqual(urls, [C.requestUrl(window), C.requestUrl(window)]);
  assert.deepEqual(sleeps, [3000]);
  assert.equal(fetched.pages, 1);
  assert.equal(fetched.rows.length, data.length);
  let failures = 0;
  await assert.rejects(C.fetchRows({ window, now: clock(NOW), sleepImpl: async () => {}, fetchImpl: async () => {
    failures++; return response({}, 429, { 'retry-after': '300' });
  }}));
  assert.equal(failures, 3);
});

test('streamed API bodies stop reading and cancel when the byte limit is crossed', async () => {
  const window = C.sessionWindow(NOW);
  let cancelled = false, released = false, reads = 0;
  await assert.rejects(C.fetchRows({ window, maxBytes: 100, now: clock(NOW), sleepImpl: async () => {}, fetchImpl: async () => ({
    ok: true, status: 200, headers: new Headers(), body: { getReader() { return {
      async read() { reads++; return { done: false, value: new Uint8Array(60) }; },
      async cancel() { cancelled = true; }, releaseLock() { released = true; }
    }; }}
  }) }));
  assert.equal(reads, 2);
  assert.equal(cancelled, true);
  assert.equal(released, true);
});

test('a stalled request times out and aborts without mutating the previous dataset', async () => {
  const before = initial(), snapshot = clone(before);
  let aborted = false;
  await assert.rejects(C.collectDataset(before, { now: clock(NOW), timeoutMs: 15, sleepImpl: async () => {}, fetchImpl: async (_url, options) => {
    options.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  }}));
  assert.equal(aborted, true);
  assert.deepEqual(before, snapshot);
});

test('atomic publication replaces only its target and leaves no partial output or unrelated data changes', () => {
  const directory = temporaryDirectory();
  try {
    const output = path.join(directory, 'parallel.json'), other = path.join(directory, 'macro.json');
    fs.writeFileSync(output, 'old publication\n');
    fs.writeFileSync(other, '{"untouched":true}\n');
    const data = build().data;
    C.atomicWrite(output, data);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), data);
    assert.equal(fs.readFileSync(other, 'utf8'), '{"untouched":true}\n');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['macro.json', 'parallel.json']);
  } finally {
    removeTemporaryDirectory(directory);
  }
});

test('a failed atomic replacement preserves the old publication and cleans its temporary file', () => {
  const directory = temporaryDirectory();
  try {
    const output = path.join(directory, 'parallel.json');
    fs.writeFileSync(output, '{"lastGood":true}\n');
    const fakeFs = { ...fs, renameSync() { throw new Error('simulated replacement failure'); } };
    assert.throws(() => C.atomicWrite(output, build().data, { fsImpl: fakeFs }), /simulated replacement failure/);
    assert.equal(fs.readFileSync(output, 'utf8'), '{"lastGood":true}\n');
    assert.deepEqual(fs.readdirSync(directory), ['parallel.json']);
  } finally { removeTemporaryDirectory(directory); }
});

test('CLI collection requires explicit noncommercial use before reading or requesting provider data', async () => {
  const saved = process.env.COIN_METRICS_USAGE;
  const oldFetch = globalThis.fetch;
  let requested = false;
  delete process.env.COIN_METRICS_USAGE;
  globalThis.fetch = async () => { requested = true; throw new Error('network must not be reached'); };
  try {
    await assert.rejects(C.main(['--dry-run']), /noncommercial/);
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = oldFetch;
    if (saved === undefined) delete process.env.COIN_METRICS_USAGE;
    else process.env.COIN_METRICS_USAGE = saved;
  }
});
