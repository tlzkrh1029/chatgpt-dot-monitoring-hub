#!/usr/bin/env node
'use strict';

// This collector owns only data/parallel.json. Reference CSVs and the five
// existing monitoring publishers are never inputs or write targets.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const contract = require('../parallel-data.js');

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const QUARTER = 15 * MINUTE;
const ORIGIN = 'https://community-api.coinmetrics.io';
const ENDPOINT = '/v4/timeseries/asset-metrics';
const METRIC = 'ReferenceRateUSD';
const SOURCE_URL = 'https://gitbook-docs.coinmetrics.io/coin-metrics-prices/coin-metrics-prices/reference-rate-metrics';
const PROVIDER_ID = 'coinmetrics-community-reference-rate-usd';
const ASSETS = Object.freeze(['btc', 'eth', 'hype', 'zec', 'xmr'].map(asset => Object.freeze({ asset, label: asset.toUpperCase() })));
const ASSET_KEYS = ASSETS.map(item => item.asset);
const clone = value => JSON.parse(JSON.stringify(value));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fail = code => { throw new Error(code); };
const iso = milliseconds => new Date(milliseconds).toISOString();

function sessionWindow(now = Date.now()) {
  const value = Number(new Date(now));
  if (!Number.isFinite(value)) fail('invalid collector clock');
  const local = new Date(value + 9 * 60 * MINUTE);
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), -1);
  if (value < start) start -= DAY;
  const end = Math.floor(value / MINUTE) * MINUTE;
  if (end <= start) fail('waiting for the first completed minute of the KST session');
  return { start: iso(start), end: iso(end), sessionDate: iso(start + 9 * 60 * MINUTE).slice(0, 10) };
}

function requestUrl(window) {
  const url = new URL(ENDPOINT, ORIGIN);
  url.search = new URLSearchParams({ assets: ASSET_KEYS.join(','), metrics: METRIC,
    frequency: '1m', page_size: '1000', paging_from: 'start',
    start_time: window.start, end_time: window.end }).toString();
  return url.href;
}

function validContinuation(value, initial) {
  let url;
  try { url = new URL(value); } catch (_) { fail('invalid API continuation'); }
  if (url.origin !== ORIGIN || url.pathname !== ENDPOINT || url.username || url.password || url.hash) fail('unsafe API continuation');
  const first = new URL(initial);
  const allowed = new Set([...first.searchParams.keys(), 'next_page_token']);
  for (const [key] of url.searchParams) if (!allowed.has(key)) fail('unexpected API continuation parameter');
  for (const [key, expected] of first.searchParams) {
    const actual = url.searchParams.get(key);
    // Coin Metrics normalizes .000Z to Z in continuation URLs. That changes
    // the spelling, not the requested range; never change the returned URL.
    const same = ['start_time', 'end_time'].includes(key)
      ? actual !== null && sourceTime(actual) === sourceTime(expected)
      : actual === expected;
    if (!same || url.searchParams.getAll(key).length !== 1) fail('API continuation changed the requested scope');
  }
  if (url.searchParams.getAll('next_page_token').length > 1) fail('duplicate API continuation token');
  return url.href;
}

function rawValue(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ||
    !Number.isFinite(Number(value)) || Number(value) <= 0) fail('invalid positive reference-rate decimal');
  return value;
}

function sourceTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)) fail('invalid API calculation timestamp');
  const at = Date.parse(value);
  if (!Number.isFinite(at) || iso(at).slice(0, 19) !== value.slice(0, 19) || at % MINUTE !== 0 ||
    /\.[0-9]*[1-9][0-9]*Z$/.test(value)) fail('reference-rate timestamp is not an exact minute');
  return iso(at);
}

async function readBody(response, maximum) {
  const header = response.headers?.get?.('content-length');
  if (header !== null && header !== undefined && Number(header) > maximum) fail('API page exceeds the size limit');
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maximum) { await reader.cancel(); fail('API page exceeds the size limit'); }
        parts.push(item.value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) { body.set(part, offset); offset += part.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } finally { reader.releaseLock(); }
  }
  const text = typeof response.text === 'function' ? await response.text() : JSON.stringify(await response.json());
  if (new TextEncoder().encode(text).byteLength > maximum) fail('API page exceeds the size limit');
  return JSON.parse(text);
}

async function fetchRows({ window, fetchImpl = globalThis.fetch, now = Date.now, sleepImpl = sleep,
  timeoutMs = 15000, maxPages = 12, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (typeof fetchImpl !== 'function' || !window) fail('collector input is incomplete');
  const initial = requestUrl(window);
  const seen = new Set();
  const rows = [];
  let next = initial;
  let pages = 0;
  while (next) {
    if (pages >= maxPages || seen.has(next)) fail('API pagination limit or loop');
    seen.add(next);
    if (pages) await sleepImpl(700); // Remains below the Community sliding rate limit.
    let body;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      let timer;
      try {
        body = await Promise.race([
          (async () => {
            const response = await fetchImpl(next, { credentials: 'omit', cache: 'no-store', signal: controller.signal,
              headers: { Accept: 'application/json' } });
            if (!response.ok) {
              const error = new Error('reference-rate API request failed');
              error.status = response.status;
              const retry = Number(response.headers?.get?.('retry-after'));
              error.retryAfter = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 30000) : 1000 * (attempt + 1);
              throw error;
            }
            return readBody(response, maxBytes);
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('reference-rate API timeout')); }, timeoutMs); })
        ]);
        break;
      } catch (error) {
        controller.abort();
        if (attempt === 2 || ![429, 500, 502, 503, 504].includes(error.status)) throw error;
        await sleepImpl(error.retryAfter);
      } finally { clearTimeout(timer); }
    }
    if (!body || !Array.isArray(body.data) || body.data.length > 10000) fail('invalid API page');
    rows.push(...body.data);
    if (rows.length > 10000) fail('API row limit exceeded');
    pages++;
    if (body.next_page_url !== null && body.next_page_url !== undefined && typeof body.next_page_url !== 'string') fail('invalid API pagination field');
    next = body.next_page_url ? validContinuation(body.next_page_url, initial) : null;
  }
  const observedAt = iso(Number(new Date(now())));
  return { window, rows, observedAt, pages, requestUrl: initial };
}

function priorAsset(previous, asset, id) {
  const provider = previous.schemaVersion === 2 ? previous.providers?.find(item => item.id === PROVIDER_ID) : null;
  const evidence = provider?.series?.find(item => item.id === id && item.asset === asset);
  const series = previous.series.find(item => item.id === id);
  return evidence && series ? { evidence, series } : null;
}

function sameValue(left, right) {
  const canonical = value => value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return canonical(left) === canonical(right);
}

function buildDataset(previous, receipt, { now = Date.now, validateDataset = contract.validateDataset } = {}) {
  const publicationMs = Number(new Date(now()));
  if (!Number.isFinite(publicationMs)) fail('invalid publication clock');
  validateDataset(previous, { now: publicationMs });
  if (previous.mode !== 'observed') fail('local reference data cannot be a publication input');
  const window = receipt.window;
  if (!window || receipt.requestUrl !== requestUrl(window) || !Array.isArray(receipt.rows)) fail('invalid collector receipt');
  const start = Date.parse(window.start), end = Date.parse(window.end), observed = Date.parse(receipt.observedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(observed) || observed < end || publicationMs < observed ||
    publicationMs < Date.parse(previous.publishedAt) || start < Date.parse(previous.window.start)) fail('collector clock regression');
  const maps = new Map(ASSET_KEYS.map(asset => [asset, new Map()]));
  for (const row of receipt.rows) {
    if (!row || !maps.has(row.asset)) fail('API row changed the requested asset scope');
    const at = sourceTime(row.time);
    if (Date.parse(at) < start || Date.parse(at) > end) fail('API row is outside the requested time range');
    // A missing value stays a gap. It is never a zero, prior close, or interpolated rate.
    if (row[METRIC] === null || row[METRIC] === undefined || row[METRIC] === '') continue;
    const value = rawValue(row[METRIC]);
    const map = maps.get(row.asset);
    if (map.has(at) && !sameValue(map.get(at), value)) fail('conflicting API duplicate calculation');
    if (!map.has(at)) map.set(at, value);
  }

  const summary = { provider: PROVIDER_ID, sessionDate: window.sessionDate, requestedStartAt: window.start,
    requestedEndAt: window.end, pages: receipt.pages, receivedRows: receipt.rows.length, observedAt: receipt.observedAt,
    publishedAt: iso(publicationMs), fresh: [], retained: [], unsupported: [] };
  const evidenceRows = [];
  const crypto = [];
  let freshCount = 0;
  for (const { asset, label } of ASSETS) {
    const id = `cm-${asset}-usd-${window.sessionDate}-0800-kst-v1`;
    const prior = priorAsset(previous, asset, id);
    const map = maps.get(asset);
    const ordered = [...map].sort(([a], [b]) => Date.parse(a) - Date.parse(b));
    const newest = ordered.at(-1);
    const canonicalStart = iso(start);
    const baseline = map.get(canonicalStart) || prior?.evidence.baseline.value;
    if (prior) {
      const protectedValues = [prior.evidence.baseline, ...prior.evidence.samples, prior.evidence.latest];
      for (const point of protectedValues) {
        if (map.has(point.at) && !sameValue(map.get(point.at), point.value)) fail('published reference-rate value was revised; explicit correction is required');
      }
    }
    const reason = !baseline ? 'exact 08:00 KST baseline unavailable' : !newest ? 'asset missing from API response' :
      prior && Date.parse(newest[0]) < Date.parse(prior.evidence.latest.at) ? 'API calculation time regressed' : null;
    if (reason) {
      if (prior) {
        crypto.push(clone(prior.series)); evidenceRows.push(clone(prior.evidence));
        summary.retained.push({ asset, reason, sourceAsOf: prior.evidence.latest.at, sampleAsOf: prior.series.asOf, observedAt: prior.series.observedAt });
      } else {
        const placeholderId = `cm-${asset}-unsupported-${window.sessionDate}`;
        let placeholder = previous.series.find(item => item.panel === 'crypto' && item.label === label && !item.points.length &&
          (previous.schemaVersion === 1 || item.id === placeholderId));
        if (!placeholder) {
          // At a new 08:00 session an old populated series cannot provide the
          // new baseline. Give the empty state a distinct identity as well.
          placeholder = { id: placeholderId, panel: 'crypto', label,
            instrument: `${label} · USD · Coin Metrics ReferenceRateUSD 복합 기준가격`,
            basis: `${window.sessionDate} 08:00 KST 기준값 미확보`, provider: 'Coin Metrics Community · ReferenceRateUSD',
            sourceUrl: SOURCE_URL, verification: 'unverified', redistribution: 'unverified', availability: 'unsupported',
            asOf: null, observedAt: null, delaySeconds: null, marketState: 'unknown', points: [] };
        }
        crypto.push(clone(placeholder)); summary.unsupported.push({ asset, reason });
      }
      continue;
    }
    rawValue(baseline);
    const samples = new Map((prior?.evidence.samples || []).map(point => [point.at, point.value]));
    samples.set(canonicalStart, prior?.evidence.baseline.value || baseline);
    for (const [at, value] of ordered) if ((Date.parse(at) - start) % QUARTER === 0) samples.set(at, samples.get(at) || value);
    const rawSamples = [...samples].sort(([a], [b]) => Date.parse(a) - Date.parse(b)).map(([at, value]) => ({ at, value }));
    const baselineValue = prior?.evidence.baseline.value || baseline;
    const points = rawSamples.map(point => ({ at: point.at, pct: (Number(point.value) / Number(baselineValue) - 1) * 100 }));
    const lag = Math.max(0, (observed - Date.parse(newest[0])) / 1000);
    const series = { id, panel: 'crypto', label,
      instrument: `${label} · USD · Coin Metrics ReferenceRateUSD 복합 기준가격`,
      basis: `${window.sessionDate} 08:00 KST 복합 기준가격 대비`,
      provider: 'Coin Metrics Community · ReferenceRateUSD', sourceUrl: SOURCE_URL,
      verification: 'verified', redistribution: 'permitted', availability: lag > 20 * 60 ? 'delayed' : 'available',
      asOf: points.at(-1).at, observedAt: receipt.observedAt, delaySeconds: lag, marketState: 'unknown', points };
    const latestValue = prior?.evidence.latest.at === newest[0] ? prior.evidence.latest.value : samples.get(newest[0]) || newest[1];
    const evidence = { id, asset, observedAt: receipt.observedAt,
      baseline: { at: canonicalStart, value: baselineValue }, latest: { at: newest[0], value: latestValue }, samples: rawSamples };
    crypto.push(series); evidenceRows.push(evidence); freshCount++;
    summary.fresh.push({ asset, sourceAsOf: evidence.latest.at, sampleAsOf: series.asOf, observedAt: series.observedAt, samples: points.length });
  }
  if (!freshCount) fail('no fresh asset with a verified exact baseline; previous publication retained');
  const keepOther = previous.series.filter(item => item.panel !== 'crypto').map(item => {
    const series = clone(item);
    series.points = series.points.filter(point => Date.parse(point.at) >= start && Date.parse(point.at) <= end);
    series.asOf = series.points.at(-1)?.at || null;
    return series;
  });
  const provider = { id: PROVIDER_ID, label: 'Coin Metrics Community Reference Rates', metric: METRIC, frequency: '1m',
    sourceUrl: SOURCE_URL, requestUrl: receipt.requestUrl, licenseName: 'CC BY-NC 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/', attribution: 'Data: Coin Metrics. Sampling and percentage changes by this dashboard.',
    attributionUrl: 'https://coinmetrics.io/',
    transformation: '1분 복합 기준가격에서 정확한 15분 시각만 표본 추출. 당일 08:00 KST 기준으로 등락률 계산. 원가격 문자열 보존; 보간하지 않음.',
    observedAt: receipt.observedAt, requestedStartAt: window.start, requestedEndAt: window.end, pages: receipt.pages, series: evidenceRows };
  const data = { schemaVersion: 2, mode: 'observed', title: '네 시장 병렬 타임라인 · Coin Metrics 크립토 자동 갱신',
    publishedAt: iso(publicationMs), window: { start: window.start, end: window.end, timezone: 'Asia/Seoul', intervalMinutes: 15 },
    series: [...keepOther.filter(item => item.panel === 'indices'), ...keepOther.filter(item => item.panel === 'ai'), ...crypto, ...keepOther.filter(item => item.panel === 'fx')],
    events: clone(previous.events.filter(item => Date.parse(item.at) >= start && Date.parse(item.at) <= end)),
    stories: clone(previous.stories.filter(item => Date.parse(item.at) >= start && Date.parse(item.at) <= end)), providers: [provider] };
  return { data: validateDataset(data, { now: publicationMs }), summary };
}

async function collectDataset(previous, options = {}) {
  const now = options.now || Date.now;
  const window = sessionWindow(now());
  const receipt = await fetchRows({ ...options, now, window });
  return buildDataset(previous, receipt, { now, validateDataset: options.validateDataset || contract.validateDataset });
}

function atomicWrite(outputPath, data, { fsImpl = fs } = {}) {
  const target = path.resolve(outputPath);
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fsImpl.openSync(temporary, 'wx', 0o644);
    fsImpl.writeFileSync(fd, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd); fd = undefined;
    fsImpl.renameSync(temporary, target);
  } finally {
    if (fd !== undefined) fsImpl.closeSync(fd);
    if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.some(arg => !['--dry-run', '--noncommercial'].includes(arg))) fail('Usage: node scripts/update-parallel-prices.js [--dry-run] --noncommercial');
  if (!args.includes('--noncommercial') && process.env.COIN_METRICS_USAGE !== 'noncommercial') fail('Confirm noncommercial use with --noncommercial or COIN_METRICS_USAGE=noncommercial before collecting');
  const output = path.join(__dirname, '..', 'data', 'parallel.json');
  const previous = JSON.parse(fs.readFileSync(output, 'utf8'));
  const result = await collectDataset(previous);
  if (!args.includes('--dry-run')) atomicWrite(output, result.data);
  console.log(JSON.stringify({ ...result.summary, written: !args.includes('--dry-run'), output: 'data/parallel.json' }));
}

module.exports = { ASSETS, sessionWindow, requestUrl, fetchRows, buildDataset, collectDataset, atomicWrite, main };
if (require.main === module) main().catch(error => { console.error(`Parallel collection failed: ${error.message}`); process.exitCode = 1; });
