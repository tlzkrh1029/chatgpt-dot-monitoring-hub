#!/usr/bin/env node
'use strict';
/* Parallel timeline collector (병렬 타임라인 v3).
 *
 * Writes data/parallel/sessions/<KST date>.json for one KST session window (default 08:00-16:00 KST)
 * and rebuilds data/parallel/index.json. Sources: Yahoo Finance chart API (15-minute bars, plus daily
 * bars for the previous close) and Coin Metrics Community ReferenceRateUSD for crypto (CC BY-NC 4.0).
 * Plain sequential requests with an honest User-Agent, at least 500 ms apart, one retry after 3 s on
 * 5xx/network errors and a full stop of Yahoo requests on HTTP 429. A failed series keeps the points
 * it already had for the same session; nothing is ever interpolated or invented.
 *
 * Usage: node scripts/collect-parallel.js [--date YYYY-MM-DD] [--start HH:MM] [--end HH:MM]
 *          [--data-dir DIR] [--now ISO] [--fixtures DIR] [--force] [--dry-run]
 * Data contract: docs/parallel-timeline.md (schemaVersion 3).
 */
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../parallel-core.js');

const USER_AGENT = 'chatgpt-dot-monitoring-hub/2.0 (+https://github.com/tlzkrh1029/chatgpt-dot-monitoring-hub)';
const YAHOO_HOST = 'query1.finance.yahoo.com';
const YAHOO_CHART_PATH = '/v8/finance/chart/';
const COIN_METRICS_HOST = 'community-api.coinmetrics.io';
const COIN_METRICS_PATH = '/v4/timeseries/asset-metrics';
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data', 'parallel');

const MINUTE = 60e3;
const BAR_SEC = 900; // 15-minute grid in seconds; Yahoo bar timestamps are bar starts
const BAR_MS = BAR_SEC * 1000;
const FINAL_AFTER_MS = 20 * MINUTE; // a session is final 20 minutes after its window end
const THROTTLE_MS = 10 * MINUTE; // minimum gap between two collections of the same session
const FIRST_VALUE_MS = 30 * MINUTE; // a "first observation" baseline must fall this close to the start
const YAHOO_GAP_MS = 500;
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 3000;
const CM_MAX_PAGES = 5;

const NOTE_NO_DATA = '자료 없음(휴장 또는 개장 전)';
const NOTE_RATE_LIMITED = 'Yahoo 요청 제한(HTTP 429)';
const LABEL_PREV_CLOSE_FALLBACK = '전일 종가';
const PROVIDER_NAMES = { yahoo: 'Yahoo', coinmetrics: 'Coin Metrics' };

const USAGE = `Usage: node scripts/collect-parallel.js [options]
  --date YYYY-MM-DD   KST session date (default: today's session; weekends are skipped unless set)
  --start HH:MM       window start in KST (default 08:00)
  --end HH:MM         window end in KST (default 16:00)
  --data-dir DIR      output directory (default data/parallel)
  --now ISO           pretend the current time is ISO (tests and backfills)
  --fixtures DIR      read provider responses from files instead of the network
                      (Yahoo <sym>.intraday.json / <sym>.daily.json, Coin Metrics coinmetrics.json)
  --force             collect even if the session is final or was collected less than 10 minutes ago
  --dry-run           collect and print a summary without writing files`;

// ---------------------------------------------------------------- small helpers

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoSec = (ms) => Core.isoUtc(Math.floor(ms / 1000) * 1000);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const joinNotes = (...parts) => parts.filter((p) => typeof p === 'string' && p).join(' · ');

/**
 * Positive finite price from a provider value (number or decimal string), else null.
 * Yahoo serializes float32 prices (5786.1298828125); the shortest decimal with the same float32
 * (5786.13) is recovered. Other values keep 10 significant digits.
 */
function cleanPrice(x) {
  const n = typeof x === 'string' && x.trim() !== '' ? Number(x) : x;
  if (!isNum(n) || n <= 0) return null;
  if (Math.fround(n) === n) {
    for (let digits = 1; digits <= 9; digits++) {
      const short = Number(n.toPrecision(digits));
      if (Math.fround(short) === n) return short;
    }
  }
  return Number(n.toPrecision(10));
}

/** File-name form of a symbol: characters outside [A-Za-z0-9.-] become '_' ('^KS11' -> '_KS11'). */
function sanitizeSymbol(symbol) {
  return String(symbol).replace(/[^A-Za-z0-9.-]/g, '_');
}

function sameWindow(a, b) {
  return Boolean(a && b) && Core.toMs(a.start) === Core.toMs(b.start) && Core.toMs(a.end) === Core.toMs(b.end);
}

function isWeekend(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

// ---------------------------------------------------------------- Yahoo

/** Trading periods flattened and sorted; each {start, end} (epoch s) knows whether it is the day's last. */
function tradingPeriods(raw) {
  let days = raw;
  if (days && !Array.isArray(days) && typeof days === 'object') days = days.regular; // includePrePost=true shape
  if (!Array.isArray(days)) return [];
  const out = [];
  for (const day of days) {
    const list = (Array.isArray(day) ? day : [day])
      .filter((p) => p && isNum(p.start) && isNum(p.end) && p.end > p.start)
      .sort((a, b) => a.start - b.start);
    list.forEach((p, i) => out.push({ start: p.start, end: p.end, lastOfDay: i === list.length - 1 }));
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Normalize a Yahoo chart response into {gmtoffset, regularMarketTime, chartPreviousClose, periods, bars}.
 * bars: [{ts, open, close}] sorted by ts, prices cleaned (null when absent). Throws on an unusable shape.
 */
function parseYahooChart(json) {
  const chart = json && typeof json === 'object' ? json.chart : null;
  if (!chart || typeof chart !== 'object') throw new Error('response has no chart object');
  if (chart.error) throw new Error(`chart error ${String(chart.error.code || '')}`.trim());
  const result = Array.isArray(chart.result) ? chart.result[0] : null;
  if (!result || typeof result !== 'object') throw new Error('chart.result[0] is missing');
  const meta = result.meta && typeof result.meta === 'object' ? result.meta : {};
  const stamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quotes = result.indicators && Array.isArray(result.indicators.quote) ? result.indicators.quote : [];
  const quote = quotes[0] && typeof quotes[0] === 'object' ? quotes[0] : {};
  const open = Array.isArray(quote.open) ? quote.open : [];
  const close = Array.isArray(quote.close) ? quote.close : [];
  if (stamps.length && close.length !== stamps.length) throw new Error('quote.close does not match the timestamps');
  const bars = [];
  stamps.forEach((ts, i) => {
    if (Number.isInteger(ts)) bars.push({ ts, open: cleanPrice(open[i]), close: cleanPrice(close[i]) });
  });
  bars.sort((a, b) => a.ts - b.ts);
  return {
    gmtoffset: isNum(meta.gmtoffset) ? meta.gmtoffset : 0,
    regularMarketTime: isNum(meta.regularMarketTime) ? meta.regularMarketTime : null,
    chartPreviousClose: cleanPrice(meta.chartPreviousClose),
    periods: tradingPeriods(meta.tradingPeriods),
    bars,
  };
}

/** Request range for the 15-minute chart: period1 = start - 1 h, period2 = min(end, now) + 60 s (epoch s). */
function yahooRange(win, nowMs) {
  const start = Math.floor(Core.toMs(win.start) / 1000);
  const end = Math.floor(Math.min(Core.toMs(win.end), nowMs) / 1000);
  return { period1: start - 3600, period2: end + 60 };
}

function yahooIntradayUrl(symbol, win, nowMs) {
  const { period1, period2 } = yahooRange(win, nowMs);
  return `https://${YAHOO_HOST}${YAHOO_CHART_PATH}${encodeURIComponent(symbol)}`
    + `?interval=15m&period1=${period1}&period2=${period2}&includePrePost=false`;
}

function yahooDailyUrl(symbol) {
  return `https://${YAHOO_HOST}${YAHOO_CHART_PATH}${encodeURIComponent(symbol)}?interval=1d&range=1mo`;
}

/**
 * The trading period a bar belongs to: the one containing its start (end inclusive, so a closing-print
 * bar stamped exactly at the period end belongs to it), else one that ended at most 15 minutes earlier.
 * A bar opening the next day's period (24h instruments: 23:59 end, 00:00 start) belongs to the new period.
 */
function periodOf(periods, ts) {
  let after = null;
  for (const p of periods) {
    if (ts >= p.start && ts <= p.end) return p;
    if (ts > p.end && ts - p.end <= BAR_SEC && (!after || p.end > after.end)) after = p;
  }
  return after;
}

/**
 * Plot points [{t (ms), v}] from 15-minute bars inside the session window (spec 4.1):
 * 1. a non-aligned timestamp is a live tick -> (ts, close);
 * 2. the last bar of a day's final trading period stamped at/after the period end is the closing print
 *    -> (closeTime, close) once the session is over (closeTime = that KST day at closeKst, else period end);
 * 3. otherwise (ts, open) when the bar starts a contiguous run, then (bar end, close) where the bar end is
 *    capped by now and, for the bar holding regularMarketTime, by that time.
 * Bars without a close are skipped; on equal times the later point wins.
 */
function yahooPoints(chart, opts) {
  const { window: win, nowMs, closeKst = null } = opts;
  const ws = Core.toMs(win.start);
  const we = Core.toMs(win.end);
  const { period1, period2 } = yahooRange(win, nowMs);
  const nowSec = Math.floor(nowMs / 1000);
  const rmt = chart.regularMarketTime;
  const bars = chart.bars.filter((b) => b.close !== null && b.ts >= period1 && b.ts < period2);
  const made = new Map();
  let lastT = null;
  const put = (t, v) => {
    made.set(t, v);
    lastT = t;
  };
  bars.forEach((bar, k) => {
    const { ts, open, close } = bar;
    if (ts % BAR_SEC !== 0) {
      put(ts, close);
      return;
    }
    const next = bars[k + 1];
    const period = periodOf(chart.periods, ts);
    if (period && period.lastOfDay && ts >= period.end && (!next || periodOf(chart.periods, next.ts) !== period)) {
      const closeAt = closeKst
        ? Math.floor(Date.parse(Core.kstToUtcIso(Core.kstDate(ts * 1000), closeKst)) / 1000)
        : period.end;
      if (nowSec >= closeAt) {
        put(closeAt, close);
        return;
      }
    }
    if (lastT === null || lastT < ts) {
      if (open !== null) put(ts, open);
    }
    const holdsRmt = rmt !== null && rmt >= ts && rmt < ts + BAR_SEC;
    const end = Math.min(ts + BAR_SEC, nowSec, holdsRmt ? rmt : Infinity);
    put(Math.max(ts, end), close);
  });
  return Array.from(made, ([t, v]) => ({ t: t * 1000, v }))
    .filter((p) => p.t >= ws && p.t <= we)
    .sort((a, b) => a.t - b.t);
}

/** Previous close from a daily chart: last non-null close whose exchange-local date is before `date`. */
function dailyPrevClose(daily, date) {
  let best = null;
  for (const bar of daily.bars) {
    if (bar.close === null) continue;
    const local = new Date((bar.ts + daily.gmtoffset) * 1000).toISOString().slice(0, 10);
    if (local < date && (!best || bar.ts > best.ts)) best = { ts: bar.ts, local, value: bar.close };
  }
  if (!best) return null;
  const [, month, day] = best.local.split('-').map(Number);
  return { value: best.value, label: `${month}/${day} 종가` };
}

/**
 * Baseline {value, label} for a Yahoo series, or null.
 * prevClose: the daily chart's previous close ("M/D 종가"), else intraday meta.chartPreviousClose ("전일 종가").
 * windowStart: close of the bar starting 15 min before the window start ("08:00 KST"), else the open of the
 * bar starting at the window start ("08:00 KST 시가"), else the first point within 30 min ("첫 관측 HH:MM KST").
 */
function yahooBaseline(chart, opts) {
  const { basis, window: win, points = [], daily = null } = opts;
  if (basis === 'prevClose') {
    const date = opts.date || Core.kstDate(win.start);
    const fromDaily = daily ? dailyPrevClose(daily, date) : null;
    if (fromDaily) return fromDaily;
    return chart.chartPreviousClose ? { value: chart.chartPreviousClose, label: LABEL_PREV_CLOSE_FALLBACK } : null;
  }
  const ws = Core.toMs(win.start);
  const startSec = Math.floor(ws / 1000);
  const hhmm = Core.kstTime(ws);
  const before = chart.bars.find((b) => b.ts === startSec - BAR_SEC && b.close !== null);
  if (before) return { value: before.close, label: `${hhmm} KST` };
  const at = chart.bars.find((b) => b.ts === startSec && b.open !== null);
  if (at) return { value: at.open, label: `${hhmm} KST 시가` };
  const first = points.find((p) => p.t >= ws && p.t <= ws + FIRST_VALUE_MS);
  return first ? { value: first.v, label: `첫 관측 ${Core.kstTime(first.t)} KST` } : null;
}

// ---------------------------------------------------------------- Coin Metrics

/** Epoch ms of a Coin Metrics time ("2026-11-04T00:15:00.000000000Z"), else null. */
function parseCmTime(text) {
  const m = typeof text === 'string' ? /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(text) : null;
  if (!m) return null;
  const t = Date.parse(`${m[1]}Z`);
  return Number.isFinite(t) ? t : null;
}

function coinMetricsUrl(assets, win, nowMs) {
  const start = isoSec(Core.toMs(win.start));
  const end = isoSec(Math.min(Core.toMs(win.end), nowMs));
  return `https://${COIN_METRICS_HOST}${COIN_METRICS_PATH}?assets=${assets.join(',')}`
    + `&metrics=ReferenceRateUSD&frequency=1m&start_time=${start}&end_time=${end}&page_size=10000&paging_from=start`;
}

/**
 * Per-asset points and baseline from Coin Metrics rows (array, or a response object with .data).
 * Points: rows on exact 15-minute marks inside [window.start, min(window.end, now)] plus the newest row
 * when it is not on a mark (live tick). Baseline: the row at the window start ("08:00 KST"), else the
 * first row within 30 minutes ("첫 관측 HH:MM KST"), else null. Returns {asset: {points, baseline}}.
 */
function coinMetricsSeries(input, opts) {
  const { window: win, nowMs } = opts;
  const rows = Array.isArray(input) ? input : (input && Array.isArray(input.data) ? input.data : []);
  const ws = Core.toMs(win.start);
  const limit = Math.min(Core.toMs(win.end), nowMs);
  const byAsset = new Map();
  for (const row of rows) {
    if (!row || typeof row.asset !== 'string') continue;
    const t = parseCmTime(row.time);
    const v = cleanPrice(row.ReferenceRateUSD);
    if (t === null || v === null || t < ws || t > limit) continue;
    if (!byAsset.has(row.asset)) byAsset.set(row.asset, new Map());
    byAsset.get(row.asset).set(t, v);
  }
  const out = {};
  for (const [asset, values] of byAsset) {
    const list = Array.from(values, ([t, v]) => ({ t, v })).sort((a, b) => a.t - b.t);
    const points = list.filter((p) => p.t % BAR_MS === 0);
    const newest = list[list.length - 1];
    if (newest.t % BAR_MS !== 0) points.push(newest);
    const first = list[0];
    let baseline = null;
    if (first.t === ws) baseline = { value: first.v, label: `${Core.kstTime(ws)} KST` };
    else if (first.t <= ws + FIRST_VALUE_MS) baseline = { value: first.v, label: `첫 관측 ${Core.kstTime(first.t)} KST` };
    out[asset] = { points, baseline };
  }
  return out;
}

// ---------------------------------------------------------------- session and index

function copySource(source) {
  return source ? { provider: source.provider, symbol: source.symbol } : undefined;
}

function sameSource(a, b) {
  return Boolean(a && b) && a.provider === b.provider && a.symbol === b.symbol;
}

function validBaseline(b) {
  return Boolean(b) && isNum(b.value) && b.value > 0 && typeof b.label === 'string';
}

/** One session series from a collection result and the same series of the previous file (same window). */
function buildSeries(def, result, prev, ws, we) {
  const head = { id: def.id, panel: def.panel, label: def.label, basis: def.basis };
  const r = result || { source: def.sources[0], error: '수집 결과 없음' };
  if (r.error) {
    const kept = prev && validBaseline(prev.baseline) && Array.isArray(prev.points)
      ? prev.points.filter((p) => {
        const t = Date.parse(p[0]);
        return t >= ws && t <= we;
      })
      : [];
    if (kept.length) {
      const out = { ...head, baseline: { value: prev.baseline.value, label: prev.baseline.label },
        source: copySource(prev.source || r.source), status: 'stale', note: r.error };
      if (typeof prev.fetchedAt === 'string') out.fetchedAt = prev.fetchedAt;
      out.points = kept.map((p) => [p[0], p[1], p[2]]);
      return out;
    }
    const keepBase = prev && validBaseline(prev.baseline) && sameSource(prev.source, r.source);
    return { ...head,
      baseline: keepBase ? { value: prev.baseline.value, label: prev.baseline.label } : { value: null, label: '' },
      source: copySource(r.source), status: 'error', note: r.error, points: [] };
  }
  const base = validBaseline(r.baseline) ? r.baseline : null;
  const points = Array.isArray(r.points) ? r.points : [];
  const out = { ...head,
    baseline: base ? { value: base.value, label: base.label } : { value: null, label: '' },
    source: copySource(r.source), status: 'ok', note: r.note || '' };
  if (isNum(r.fetchedAt)) out.fetchedAt = isoSec(r.fetchedAt);
  out.points = [];
  if (!points.length) {
    out.status = 'missing';
    out.note = joinNotes(r.note, NOTE_NO_DATA);
  } else if (!base) {
    out.status = 'missing';
    out.note = joinNotes(r.note, `기준값 없음(${Core.kstTime(ws)} KST 이후 30분 안에 관측 없음)`);
  } else {
    out.points = points.map((p) => [isoSec(p.t), p.v, Core.pctChange(p.v, base.value)]);
  }
  return out;
}

/**
 * Session object (spec 2.2) from per-series collection results.
 * results: [{id, source, fetchedAt?, points: [{t, v}], baseline, note} | {id, source, error}];
 * previous: the existing session file for the same date (used only when its window is the same).
 */
function buildSession(opts) {
  const { date, window: win, nowMs, generatedAt = nowMs, results = [], previous = null } = opts;
  const ws = Core.toMs(win.start);
  const we = Core.toMs(win.end);
  const byId = new Map(results.map((r) => [r.id, r]));
  const prevById = new Map();
  if (previous && sameWindow(previous.window, win) && Array.isArray(previous.series)) {
    for (const s of previous.series) prevById.set(s.id, s);
  }
  return {
    schemaVersion: 3,
    kind: 'session',
    date,
    timezone: 'Asia/Seoul',
    window: { start: Core.isoUtc(ws), end: Core.isoUtc(we) },
    intervalMinutes: 15,
    generatedAt: isoSec(Core.toMs(generatedAt)),
    final: Core.toMs(nowMs) >= we + FINAL_AFTER_MS,
    series: Core.SERIES.map((def) => buildSeries(def, byId.get(def.id), prevById.get(def.id), ws, we)),
    providers: JSON.parse(JSON.stringify(Core.PROVIDERS)),
  };
}

/** Index object (spec 2.1) from session objects and notes keyed by date (object or Map). */
function buildIndex(sessions, notesByDate, updatedAt) {
  const notesFor = (date) => {
    if (!notesByDate) return null;
    if (notesByDate instanceof Map) return notesByDate.get(date) || null;
    return Object.prototype.hasOwnProperty.call(notesByDate, date) ? notesByDate[date] || null : null;
  };
  const entries = (sessions || []).map((s) => {
    const notes = notesFor(s.date);
    return {
      date: s.date,
      title: notes && typeof notes.title === 'string' && notes.title.trim() ? notes.title : null,
      final: s.final === true,
      seriesWithData: (s.series || []).filter((x) => Array.isArray(x.points) && x.points.length > 0).length,
      updatedAt: s.generatedAt,
      hasNotes: Boolean(notes),
    };
  });
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { schemaVersion: 3, kind: 'index', updatedAt: isoSec(Core.toMs(updatedAt)), sessions: entries };
}

/** JSON with 2-space indentation, arrays of primitives (each point) on one line, and a final newline. */
function serializeJson(value) {
  const prim = (v) => {
    const s = JSON.stringify(v);
    return s === undefined ? 'null' : s;
  };
  const fmt = (v, indent) => {
    if (v && typeof v.toJSON === 'function') return fmt(v.toJSON(), indent);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      if (v.every((x) => x === null || typeof x !== 'object')) return `[${v.map(prim).join(', ')}]`;
      const inner = `${indent}  `;
      return `[\n${v.map((x) => inner + fmt(x, inner)).join(',\n')}\n${indent}]`;
    }
    if (v && typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function');
      if (!keys.length) return '{}';
      const inner = `${indent}  `;
      return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${fmt(v[k], inner)}`).join(',\n')}\n${indent}}`;
    }
    return prim(v);
  };
  return `${fmt(value, '')}\n`;
}

/**
 * Session date for an unattended run: the KST date of now once that day's window has started,
 * else the previous KST date (a night-time run refreshes the last session instead of opening an empty one).
 */
function defaultDate(nowMs, startHHMM) {
  const now = Core.toMs(nowMs);
  const today = Core.kstDate(now);
  if (Date.parse(Core.kstToUtcIso(today, startHHMM || '08:00')) <= now) return today;
  return Core.kstDate(now - 24 * 3600e3);
}

/**
 * Why this run should not collect ('final' | 'throttled'), or null.
 * final: the existing file is final, was generated 20+ minutes after its window end and has no
 * stale/error series; throttled: it was generated less than 10 minutes ago. --force overrides both.
 */
function shouldSkip(opts) {
  const { existing, nowMs, force = false } = opts || {};
  if (force || !existing) return null;
  const generated = Date.parse(existing.generatedAt);
  if (!Number.isFinite(generated)) return null;
  const end = Date.parse(existing.window && existing.window.end);
  const failed = (existing.series || []).some((s) => s && (s.status === 'stale' || s.status === 'error'));
  if (existing.final === true && Number.isFinite(end) && generated >= end + FINAL_AFTER_MS && !failed) return 'final';
  if (Core.toMs(nowMs) - generated < THROTTLE_MS) return 'throttled';
  return null;
}

// ---------------------------------------------------------------- requests

/** Network transport: one GET with the honest User-Agent and a 20 s timeout -> {status, text}. */
async function httpTransport(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, text: await response.text() };
}

/** Transport reading provider responses from files; a missing file answers HTTP 404. */
function fixtureTransport(dir) {
  return async (url) => {
    const u = new URL(url);
    let file = null;
    if (u.hostname === YAHOO_HOST && u.pathname.startsWith(YAHOO_CHART_PATH)) {
      const symbol = decodeURIComponent(u.pathname.slice(YAHOO_CHART_PATH.length));
      file = `${sanitizeSymbol(symbol)}.${u.searchParams.get('interval') === '1d' ? 'daily' : 'intraday'}.json`;
    } else if (u.hostname === COIN_METRICS_HOST) {
      file = 'coinmetrics.json';
    }
    if (!file) return { status: 404, text: '' };
    try {
      return { status: 200, text: fs.readFileSync(path.join(dir, file), 'utf8') };
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 404, text: '' };
      throw error;
    }
  };
}

/** One request with a single retry after 3 s on HTTP 5xx or a network error -> {status, text, failure?}. */
async function request(transport, url, sleep) {
  const attempt = async () => {
    try {
      const res = await transport(url);
      return { status: res.status, text: typeof res.text === 'string' ? res.text : '' };
    } catch (error) {
      const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { status: 0, text: '', failure: timeout ? '시간 초과' : '연결 실패' };
    }
  };
  let res = await attempt();
  if (res.status === 0 || res.status >= 500) {
    await sleep(RETRY_DELAY_MS);
    res = await attempt();
  }
  return res;
}

const failureText = (provider, res) => `${provider} ${res.status === 0 ? res.failure : `HTTP ${res.status}`}`;

/** Sequential Yahoo client: >= 500 ms between requests, and no request at all after an HTTP 429. */
function yahooClient(transport, sleep) {
  let sent = false;
  let limited = false;
  return {
    async chart(url) {
      if (limited) return { error: NOTE_RATE_LIMITED };
      if (sent) await sleep(YAHOO_GAP_MS);
      sent = true;
      const res = await request(transport, url, sleep);
      if (res.status === 429) {
        limited = true;
        return { error: NOTE_RATE_LIMITED };
      }
      if (res.status !== 200) return { error: failureText('Yahoo', res) };
      try {
        return { chart: parseYahooChart(JSON.parse(res.text)) };
      } catch (error) {
        return { error: 'Yahoo 응답 형식 오류' };
      }
    },
  };
}

/** All Coin Metrics pages (same host only, at most 5) -> {rows, fetchedAt} | {error}. */
async function fetchCoinMetrics(transport, sleep, url, clock) {
  const host = new URL(url).host;
  const rows = [];
  let next = url;
  for (let page = 0; next && page < CM_MAX_PAGES; page++) {
    const res = await request(transport, next, sleep);
    if (res.status !== 200) return { error: failureText('Coin Metrics', res) };
    let json;
    try {
      json = JSON.parse(res.text);
    } catch (error) {
      json = null;
    }
    if (!json || !Array.isArray(json.data)) return { error: 'Coin Metrics 응답 형식 오류' };
    for (const row of json.data) rows.push(row);
    next = null;
    if (typeof json.next_page_url === 'string') {
      try {
        const u = new URL(json.next_page_url);
        if (u.protocol === 'https:' && u.host === host) next = u.href;
      } catch (error) {
        next = null;
      }
    }
  }
  return { rows, fetchedAt: clock() };
}

/** Reuse a previous-close baseline already stored for this session (same source, dated label). */
function cachedPrevClose(prev, source) {
  if (!prev || prev.basis !== 'prevClose' || !validBaseline(prev.baseline)) return null;
  if (!sameSource(prev.source, source) || prev.baseline.label === LABEL_PREV_CLOSE_FALLBACK) return null;
  return { value: prev.baseline.value, label: prev.baseline.label };
}

async function fromYahoo(def, source, ctx) {
  const { yahoo, date, window: win, nowMs, prev, clock } = ctx;
  const intraday = await yahoo.chart(yahooIntradayUrl(source.symbol, win, nowMs));
  if (intraday.error) return { id: def.id, source, error: intraday.error };
  const fetchedAt = clock();
  const chart = intraday.chart;
  const points = yahooPoints(chart, { window: win, nowMs, closeKst: def.closeKst });
  let baseline;
  if (def.basis === 'prevClose') {
    baseline = cachedPrevClose(prev, source);
    if (!baseline) {
      const daily = await yahoo.chart(yahooDailyUrl(source.symbol));
      baseline = yahooBaseline(chart, { basis: 'prevClose', window: win, date, daily: daily.chart || null });
    }
    if (!baseline && points.length) return { id: def.id, source, error: '전일 종가 확인 실패' };
  } else {
    baseline = yahooBaseline(chart, { basis: 'windowStart', window: win, points });
  }
  return { id: def.id, source, fetchedAt, points, baseline, note: '' };
}

function fromCoinMetrics(def, source, cm) {
  if (!cm) return { id: def.id, source, error: 'Coin Metrics 요청 안 함' };
  if (cm.error) return { id: def.id, source, error: cm.error };
  const got = cm.series[source.symbol];
  if (!got || !got.baseline || !got.points.length) return { id: def.id, source, error: 'Coin Metrics 자료 없음' };
  return { id: def.id, source, fetchedAt: cm.fetchedAt, points: got.points, baseline: got.baseline, note: '' };
}

/** Fetch every catalog series in order (Coin Metrics first, then Yahoo sequentially) -> results. */
async function collectSeries(opts) {
  const { date, window: win, nowMs, previous, transport, sleep, clock } = opts;
  const prevById = new Map(previous && Array.isArray(previous.series) ? previous.series.map((s) => [s.id, s]) : []);
  if (nowMs < Core.toMs(win.start)) {
    return Core.SERIES.map((def) => ({ id: def.id, source: def.sources[0], points: [], baseline: null, note: '' }));
  }
  const cmAssets = [];
  for (const def of Core.SERIES) {
    for (const s of def.sources) if (s.provider === 'coinmetrics' && !cmAssets.includes(s.symbol)) cmAssets.push(s.symbol);
  }
  let cm = null;
  if (cmAssets.length) {
    const got = await fetchCoinMetrics(transport, sleep, coinMetricsUrl(cmAssets, win, nowMs), clock);
    cm = got.error
      ? { error: got.error }
      : { series: coinMetricsSeries(got.rows, { window: win, nowMs }), fetchedAt: got.fetchedAt };
  }
  const yahoo = yahooClient(transport, sleep);
  const results = [];
  for (const def of Core.SERIES) {
    const ctx = { yahoo, date, window: win, nowMs, prev: prevById.get(def.id) || null, clock };
    const reasons = [];
    let result = null;
    for (const source of def.sources) {
      let r;
      if (source.provider === 'coinmetrics') r = fromCoinMetrics(def, source, cm);
      else if (source.provider === 'yahoo') r = await fromYahoo(def, source, ctx);
      else r = { id: def.id, source, error: `${source.provider} 미지원` };
      if (!r.error) {
        result = r;
        break;
      }
      reasons.push(r.error);
    }
    if (result && reasons.length) {
      result.note = joinNotes(`${reasons.join(' · ')} · ${PROVIDER_NAMES[result.source.provider] || result.source.provider} 대체`, result.note);
    }
    results.push(result || { id: def.id, source: def.sources[0], error: reasons.join(' · ') });
  }
  return results;
}

// ---------------------------------------------------------------- files

function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Valid dated files (YYYY-MM-DD.json) of a directory; invalid ones are reported through warn and skipped. */
function readDated(dir, validate, warn) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const name of names.sort()) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    if (!m) continue;
    try {
      const obj = validate(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      if (obj.date !== m[1]) throw new Error(`date ${obj.date} does not match the file name`);
      out.push(obj);
    } catch (error) {
      warn(`warning: ignoring ${path.join(path.basename(dir), name)}: ${error.message}`);
    }
  }
  return out;
}

function readSessionFile(file, date, warn) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const session = Core.validateSession(JSON.parse(text));
    if (session.date !== date) throw new Error(`date ${session.date} does not match the file name`);
    return session;
  } catch (error) {
    warn(`warning: existing ${path.basename(file)} is unusable and will be replaced: ${error.message}`);
    return null;
  }
}

/** Rebuild index.json from the session and notes files; writes only when its content changes. */
function syncIndex(dataDir, updatedAtMs, warn) {
  const sessions = readDated(path.join(dataDir, 'sessions'), Core.validateSession, warn);
  const notes = new Map(readDated(path.join(dataDir, 'notes'), Core.validateNotes, warn).map((n) => [n.date, n]));
  const file = path.join(dataDir, 'index.json');
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    current = null;
  }
  const next = buildIndex(sessions, notes, updatedAtMs);
  if (!current && !sessions.length) return { written: false, index: null };
  if (current && typeof current === 'object'
    && JSON.stringify({ ...current, updatedAt: null }) === JSON.stringify({ ...next, updatedAt: null })) {
    return { written: false, index: current };
  }
  writeFileAtomic(file, serializeJson(next));
  return { written: true, index: next };
}

function summaryLine(s) {
  const base = s.baseline && s.baseline.value !== null ? `${s.baseline.value} (${s.baseline.label})` : '-';
  const src = s.source ? `${s.source.provider}:${s.source.symbol}` : '-';
  return `  ${s.id.padEnd(10)} ${s.status.padEnd(7)} ${String(s.points.length).padStart(3)} pts  base ${base}  ${src}`
    + `${s.note ? `  [${s.note}]` : ''}`;
}

// ---------------------------------------------------------------- run

/**
 * Collect one session and refresh the index.
 * options: {date, start, end, dataDir, now, fixtures, force, dryRun, transport, sleep, clock, log}
 * Returns {status: 'written'|'skipped'|'dry-run', reason?, date, final, session?, index?}.
 */
async function run(options = {}) {
  const o = options;
  const log = o.log || ((line) => console.log(line));
  const fixedNow = o.now == null ? null : Core.toMs(o.now);
  if (fixedNow !== null && !Number.isFinite(fixedNow)) throw new Error(`invalid now: ${o.now}`);
  const clock = o.clock || (() => (fixedNow === null ? Date.now() : fixedNow));
  const nowMs = clock();
  const dataDir = path.resolve(o.dataDir || DEFAULT_DATA_DIR);
  const sleep = o.sleep || (o.fixtures ? async () => {} : delay);
  const transport = o.transport || (o.fixtures ? fixtureTransport(path.resolve(o.fixtures)) : httpTransport);
  const refreshIndex = (ms) => (o.dryRun ? { written: false } : syncIndex(dataDir, ms, log));

  let date = o.date || null;
  if (!date) {
    date = defaultDate(nowMs, o.start);
    if (isWeekend(date)) {
      log(`${date} is a weekend in KST; nothing to collect (pass --date to collect it anyway).`);
      const { written } = refreshIndex(nowMs);
      return { status: 'skipped', reason: 'weekend', date, final: false, indexWritten: written };
    }
  }
  const win = Core.sessionWindow(date, o.start || undefined, o.end || undefined);
  const sessionFile = path.join(dataDir, 'sessions', `${date}.json`);
  const existing = readSessionFile(sessionFile, date, log);
  const skip = shouldSkip({ existing, nowMs, force: Boolean(o.force) });
  if (skip) {
    log(`${date}: ${skip === 'final' ? 'session is already final' : 'collected less than 10 minutes ago'}; skipping (use --force to collect anyway).`);
    const { written } = refreshIndex(nowMs);
    return { status: 'skipped', reason: skip, date, final: existing.final, indexWritten: written };
  }
  const previous = existing && sameWindow(existing.window, win) ? existing : null;
  log(`Collecting ${date} ${Core.kstTime(win.start)}~${Core.kstTime(win.end)} KST (${win.start} .. ${win.end}), now ${isoSec(nowMs)}${o.fixtures ? `, fixtures ${o.fixtures}` : ''}`);
  const results = await collectSeries({ date, window: win, nowMs, previous, transport, sleep, clock });
  const session = Core.validateSession(buildSession({ date, window: win, nowMs, generatedAt: clock(), results, previous }));
  for (const s of session.series) log(summaryLine(s));
  const withData = session.series.filter((s) => s.points.length).length;
  if (o.dryRun) {
    log(`Dry run: ${withData}/${session.series.length} series with data, final ${session.final}; nothing written.`);
    return { status: 'dry-run', date, final: session.final, session };
  }
  writeFileAtomic(sessionFile, serializeJson(session));
  const { index } = syncIndex(dataDir, Date.parse(session.generatedAt), log);
  const shown = path.relative(process.cwd(), sessionFile);
  log(`Wrote ${!shown || shown.startsWith('..') ? sessionFile : shown}: ${withData}/${session.series.length} series with data, final ${session.final}; index lists ${index ? index.sessions.length : 0} sessions.`);
  return { status: 'written', date, final: session.final, session, index };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { date: null, start: null, end: null, dataDir: null, now: null, fixtures: null, force: false, dryRun: false };
  const valued = { '--date': 'date', '--start': 'start', '--end': 'end', '--data-dir': 'dataDir', '--now': 'now', '--fixtures': 'fixtures' };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if ((arg === '--force' || arg === '--dry-run' || arg === '--help' || arg === '-h') && value === undefined) {
      if (arg === '--force') out.force = true;
      else if (arg === '--dry-run') out.dryRun = true;
      else out.help = true;
    } else if (Object.prototype.hasOwnProperty.call(valued, arg)) {
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new Error(`${arg} needs a value`);
      }
      out[valued[arg]] = value.trim() === '' ? null : value.trim();
    } else {
      throw new Error(`unknown option ${argv[i]}`);
    }
  }
  if (out.date !== null) Core.kstToUtcIso(out.date, '00:00'); // throws on a malformed or impossible date
  for (const key of ['start', 'end']) {
    if (out[key] !== null) Core.kstToUtcIso('2000-01-01', out[key]); // throws on a malformed time
  }
  if (out.now !== null && !Number.isFinite(Date.parse(out.now))) throw new Error(`--now: invalid time ${out.now}`);
  return out;
}

function writeGithubOutput(values) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`collect-parallel: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await run(args);
    if (process.env.GITHUB_ACTIONS === 'true' && result.session) {
      for (const s of result.session.series) {
        if (s.status === 'stale' || s.status === 'error') console.log(`::warning title=parallel ${s.id}::${s.status}: ${s.note}`);
      }
    }
    writeGithubOutput({ date: result.date, final: String(Boolean(result.final)), status: result.status });
    return 0;
  } catch (error) {
    console.error(`collect-parallel failed: ${error && error.stack ? error.stack : error}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  USER_AGENT, NOTE_NO_DATA, NOTE_RATE_LIMITED, LABEL_PREV_CLOSE_FALLBACK,
  cleanPrice, sanitizeSymbol, parseYahooChart, tradingPeriods, periodOf, yahooRange, yahooIntradayUrl, yahooDailyUrl,
  yahooPoints, yahooBaseline, dailyPrevClose, parseCmTime, coinMetricsUrl, coinMetricsSeries,
  buildSeries, buildSession, buildIndex, serializeJson, defaultDate, isWeekend, shouldSkip,
  httpTransport, fixtureTransport, request, yahooClient, fetchCoinMetrics, collectSeries, syncIndex,
  parseArgs, run, main,
};
