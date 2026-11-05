#!/usr/bin/env node
'use strict';
/* Parallel timeline collector (병렬 타임라인 v3).
 *
 * Writes data/parallel/sessions/<KST date>.json for one KST session window (default 08:00-16:00 KST)
 * and rebuilds data/parallel/index.json. Sources: Yahoo Finance chart API (15-minute bars, plus daily
 * bars for the previous close) and Coin Metrics Community ReferenceRateUSD for crypto (CC BY-NC 4.0).
 * Plain sequential requests with an honest User-Agent, at least 500 ms apart, one retry after 3 s on
 * 5xx/network errors. Yahoo is not asked again in the same run after HTTP 429, an explicit refusal
 * (401/403/451, a redirect, a 200 answer that is not JSON) or two requests in a row without an answer;
 * a run within 30 minutes of a run that Yahoo refused outright sends Yahoo nothing, and no request starts
 * after 6 minutes. A series that fails, or whose new answer lacks points it had before, keeps the points
 * it already had for the same session; nothing is ever interpolated or invented. A run whose result
 * differs from the stored file only in fetch times writes nothing.
 *
 * Usage: node scripts/collect-parallel.js --help
 * Data contract: docs/parallel-timeline.md (schemaVersion 3).
 */
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../parallel-core.js');

const PRODUCT = 'chatgpt-dot-monitoring-hub/2.0';
const UPSTREAM_REPOSITORY = 'tlzkrh1029/chatgpt-dot-monitoring-hub';
const YAHOO_HOST = 'query1.finance.yahoo.com';
const YAHOO_CHART_PATH = '/v8/finance/chart/';
const COIN_METRICS_HOST = 'community-api.coinmetrics.io';
const COIN_METRICS_PATH = '/v4/timeseries/asset-metrics';
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data', 'parallel');

const MINUTE = 60e3;
const BAR_SEC = 900; // 15-minute grid in seconds; Yahoo bar timestamps are bar starts
const BAR_MS = BAR_SEC * 1000;
const FINAL_AFTER_MS = 20 * MINUTE; // a session is final 20 minutes after its window end
const THROTTLE_MS = 10 * MINUTE; // --throttle: minimum gap between two collections of the same session
const REPAIR_AFTER_MS = 60 * MINUTE; // a final file with stale/error series is collected again at most hourly
// Repairs stop 8 hours after the window end (24:00 KST for the default window): a series that keeps failing
// stays stale/error instead of costing requests on every heartbeat run all night; --force still repairs it.
const REPAIR_UNTIL_MS = 8 * 60 * MINUTE;
const BACKOFF_MS = 30 * MINUTE; // Yahoo is left alone this long after a run it refused outright
const RUN_DEADLINE_MS = 6 * MINUTE; // no provider request starts later than this in one run
const BACKLOG_MAX = 5; // earlier non-final sessions finalized by one unattended run
const BACKLOG_MIN_LEFT_MS = 2 * MINUTE; // ... and only while this much of the run deadline is left
const YAHOO_MAX_SILENT = 2; // Yahoo requests in a row without an answer (timeout/network) that stop Yahoo
const YAHOO_GAP_MS = 500;
const REQUEST_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 3000;
const CM_MAX_PAGES = 5;

const NOTE_NO_DATA = '자료 없음(휴장 또는 개장 전)';
const NOTE_RATE_LIMITED = 'Yahoo 요청 제한(HTTP 429)';
const NOTE_REFUSED = 'Yahoo 접근 거부'; // followed by '(HTTP 403)' or '(JSON 아닌 응답)'
const NOTE_SILENT = 'Yahoo 요청 중단(연속 응답 없음)';
const NOTE_YAHOO_DEADLINE = 'Yahoo 요청 중단(수집 6분 초과)';
const NOTE_CM_DEADLINE = 'Coin Metrics 요청 중단(수집 6분 초과)';
const NOTE_BACKOFF = 'Yahoo 요청 보류(직전 회차 거부)';
const NOTE_KEPT_EMPTY = '새 응답에 자료 없음 · 이전 자료 유지';
const NOTE_KEPT_PARTIAL = '새 응답에 일부 자료 없음 · 이전 자료 유지';
const NOTE_FILLED_START = '새 응답에 앞부분 없음 · 이전 자료로 보충';
const NOTE_NO_BASELINE = '기준값 없음';
const LABEL_PREV_CLOSE_FALLBACK = '전일 종가';
const PROVIDER_NAMES = { yahoo: 'Yahoo', coinmetrics: 'Coin Metrics' };

const USAGE = `Usage: node scripts/collect-parallel.js [options]
  --date YYYY-MM-DD   KST session date (default: today's session; weekends are skipped unless set;
                      a date after today is refused). Without --date, earlier sessions that are still
                      not final after their window ended are also collected once (at most ${BACKLOG_MAX}).
  --start HH:MM       window start in KST (default 08:00, or the stored window of an existing file)
  --end HH:MM         window end in KST (default 16:00, or the stored window of an existing file)
  --replace-window    let --start/--end replace an existing file whose window differs
                      (its stored points are not carried over)
  --data-dir DIR      data directory (default data/parallel)
  --overlay-dir DIR   another data directory (the data branch): each valid sessions/*.json there that is
                      newer (generatedAt) than the copy in --data-dir, or has no copy, replaces it before
                      collecting; notes are never read from it
  --now ISO           pretend the current time is ISO (tests and backfills)
  --fixtures DIR      read provider responses from files instead of the network
                      (Yahoo <sym>.intraday.json / <sym>.daily.json, Coin Metrics coinmetrics.json)
  --throttle          skip a session collected less than 10 minutes ago (push-triggered runs)
  --force             collect even if the session is final, waits for its hourly repair, or is throttled
  --dry-run           collect and print a summary without writing files
  --rebuild-index     rebuild index.json from the sessions and notes in --data-dir and exit (no requests;
                      takes only --data-dir)`;

/** A command-line mistake: main() reports it with exit code 2. */
class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

// ---------------------------------------------------------------- small helpers

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isoSec = (ms) => Core.isoUtc(Math.floor(ms / 1000) * 1000);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const joinNotes = (...parts) => parts.filter((p) => typeof p === 'string' && p).join(' · ');
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/**
 * User-Agent naming the repository that runs the collector: GITHUB_REPOSITORY (and GITHUB_SERVER_URL)
 * when set, as in GitHub Actions, otherwise the upstream repository.
 */
function userAgent(env = process.env) {
  const e = env || {};
  const repo = typeof e.GITHUB_REPOSITORY === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(e.GITHUB_REPOSITORY)
    ? e.GITHUB_REPOSITORY : null;
  const serverText = typeof e.GITHUB_SERVER_URL === 'string' ? e.GITHUB_SERVER_URL.replace(/\/+$/, '') : '';
  const server = repo && /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(serverText) ? serverText : 'https://github.com';
  return `${PRODUCT} (+${server}/${repo || UPSTREAM_REPOSITORY})`;
}
const USER_AGENT = userAgent({}); // the upstream form, used outside GitHub Actions

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

const windowText = (win) => `${Core.kstTime(win.start)}~${Core.kstTime(win.end)}`;

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
 * bars: [{ts, open, high, low, close, volume}] sorted by ts, prices cleaned (null when absent), volume a
 * finite number or null. Throws on an unusable shape.
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
  const list = (key) => (Array.isArray(quote[key]) ? quote[key] : []);
  const [open, high, low, close, volume] = ['open', 'high', 'low', 'close', 'volume'].map(list);
  if (stamps.length && close.length !== stamps.length) throw new Error('quote.close does not match the timestamps');
  const bars = [];
  stamps.forEach((ts, i) => {
    if (!Number.isInteger(ts)) return;
    bars.push({ ts, open: cleanPrice(open[i]), high: cleanPrice(high[i]), low: cleanPrice(low[i]),
      close: cleanPrice(close[i]), volume: isNum(volume[i]) ? volume[i] : null });
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
 * 2. a bar starting at the series' lunch break (breakKst, e.g. Tokyo 11:30, Hong Kong 13:00 KST) is the
 *    morning-close print -> (ts, close), never carried into the break;
 * 3. the last bar of a day's final trading period stamped at/after the period end is the closing print
 *    -> (closeTime, close) once the session is over, where closeTime is that KST day at closeKst (else the
 *    period end) but never earlier than the bar itself: a print is only moved forward or kept in place;
 * 4. otherwise (ts, open) when the bar starts a contiguous run, then (bar end, close) where the bar end is
 *    capped by now and, for the bar holding regularMarketTime, by that time.
 * Bars without a close are skipped; on equal times the later point wins.
 */
function yahooPoints(chart, opts) {
  const { window: win, nowMs, closeKst = null, breakKst = null } = opts;
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
    if (breakKst && Core.kstTime(ts * 1000) === breakKst) {
      put(ts, close);
      return;
    }
    const next = bars[k + 1];
    const period = periodOf(chart.periods, ts);
    if (period && period.lastOfDay && ts >= period.end && (!next || periodOf(chart.periods, next.ts) !== period)) {
      const closeAt = closeKst
        ? Math.floor(Date.parse(Core.kstToUtcIso(Core.kstDate(ts * 1000), closeKst)) / 1000)
        : period.end;
      const at = Math.max(closeAt, ts);
      if (nowSec >= at) {
        put(at, close);
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

/** A flat zero-volume daily bar (open = high = low = close, volume 0): Yahoo's exchange-holiday placeholder. */
function isPlaceholderBar(bar) {
  return bar.volume === 0 && bar.open !== null && bar.open === bar.high && bar.high === bar.low && bar.low === bar.close;
}

/**
 * Previous close from a daily chart: the last non-null close whose exchange-local date is before `date`,
 * skipping holiday placeholder bars (which would otherwise name a day without trading).
 */
function dailyPrevClose(daily, date) {
  let best = null;
  for (const bar of daily.bars) {
    if (bar.close === null || isPlaceholderBar(bar)) continue;
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
 * bar starting at the window start ("08:00 KST 시가"), else the first point inside the window, however late
 * ("첫 관측 HH:MM KST": Monday FX opens at 09:00 KST, DXY under US daylight time at 08:45 KST).
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
  const we = Core.toMs(win.end);
  const startSec = Math.floor(ws / 1000);
  const hhmm = Core.kstTime(ws);
  const before = chart.bars.find((b) => b.ts === startSec - BAR_SEC && b.close !== null);
  if (before) return { value: before.close, label: `${hhmm} KST` };
  const at = chart.bars.find((b) => b.ts === startSec && b.open !== null);
  if (at) return { value: at.open, label: `${hhmm} KST 시가` };
  const first = points.find((p) => p.t >= ws && p.t <= we);
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
 * first row inside the window ("첫 관측 HH:MM KST"). Returns {asset: {points, baseline}}.
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
    const baseline = first.t === ws
      ? { value: first.v, label: `${Core.kstTime(ws)} KST` }
      : { value: first.v, label: `첫 관측 ${Core.kstTime(first.t)} KST` };
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

const isFirstObservation = (label) => typeof label === 'string' && label.startsWith('첫 관측');

/** In-window points of a previous series that has a usable baseline, else []. */
function previousPoints(prev, ws, we) {
  if (!prev || !validBaseline(prev.baseline) || !Array.isArray(prev.points)) return [];
  return prev.points.filter((p) => {
    const t = Array.isArray(p) ? Date.parse(p[0]) : NaN;
    return t >= ws && t <= we;
  });
}

/** The previous series' points, baseline, source and fetch time, marked stale with `note`. */
function keptSeries(head, prev, kept, source, note) {
  const out = { ...head, baseline: { value: prev.baseline.value, label: prev.baseline.label },
    source: copySource(prev.source || source), status: 'stale', note };
  if (typeof prev.fetchedAt === 'string') out.fetchedAt = prev.fetchedAt;
  out.points = kept.map((p) => [p[0], p[1], p[2]]);
  return out;
}

/**
 * One session series from a collection result and the same series of the previous file (same window).
 * - The provider failed (or gave points without a baseline): the previous points are kept as 'stale',
 *   else 'error' (a cached previous close of the same source survives).
 * - The new answer has no points: the previous points are kept as 'stale' when there are any, otherwise
 *   the series is 'missing' (holiday, not open yet).
 * - Same source: previous points outside the new answer's time span are merged in (new values win at
 *   every time the new answer covers) and every pct is recomputed against the chosen baseline; points
 *   kept after the new answer's last point make the series 'stale' so a later run retries it.
 * - Another source (fallback) that ends earlier than the previous points: the previous series is kept.
 */
function buildSeries(def, result, prev, ws, we) {
  const head = { id: def.id, panel: def.panel, label: def.label, basis: def.basis };
  const r = result || { source: def.sources[0], error: '수집 결과 없음' };
  const kept = previousPoints(prev, ws, we);
  const fresh = !r.error && Array.isArray(r.points) ? r.points : [];
  const base = !r.error && validBaseline(r.baseline) ? r.baseline : null;
  const failure = r.error || (fresh.length && !base ? joinNotes(r.note, NOTE_NO_BASELINE) : null);
  if (failure) {
    if (kept.length) return keptSeries(head, prev, kept, r.source, failure);
    const keepBase = prev && validBaseline(prev.baseline) && sameSource(prev.source, r.source);
    return { ...head,
      baseline: keepBase ? { value: prev.baseline.value, label: prev.baseline.label } : { value: null, label: '' },
      source: copySource(r.source), status: 'error', note: failure, points: [] };
  }
  if (!fresh.length) {
    if (kept.length) return keptSeries(head, prev, kept, r.source, joinNotes(r.note, NOTE_KEPT_EMPTY));
    const out = { ...head,
      baseline: base ? { value: base.value, label: base.label } : { value: null, label: '' },
      source: copySource(r.source), status: 'missing', note: joinNotes(r.note, NOTE_NO_DATA) };
    if (isNum(r.fetchedAt)) out.fetchedAt = isoSec(r.fetchedAt);
    out.points = [];
    return out;
  }
  let points = fresh.map((p) => ({ t: p.t, v: p.v }));
  let baseline = base;
  let status = 'ok';
  let note = r.note || '';
  if (kept.length) {
    const first = points[0].t;
    const last = points[points.length - 1].t;
    if (!sameSource(prev.source, r.source)) {
      if (last < Date.parse(kept[kept.length - 1][0])) {
        return keptSeries(head, prev, kept, r.source, joinNotes(r.note, NOTE_KEPT_PARTIAL));
      }
    } else {
      const asPoint = (p) => ({ t: Date.parse(p[0]), v: p[1] });
      const before = kept.filter((p) => Date.parse(p[0]) < first).map(asPoint);
      const after = kept.filter((p) => Date.parse(p[0]) > last).map(asPoint);
      if (before.length || after.length) {
        points = [...before, ...points, ...after];
        // A first observation from an answer that lost its start is later than the stored baseline.
        if (before.length && def.basis === 'windowStart' && isFirstObservation(base.label)) baseline = prev.baseline;
        status = after.length ? 'stale' : 'ok';
        note = joinNotes(r.note, after.length ? NOTE_KEPT_PARTIAL : NOTE_FILLED_START);
      }
    }
  }
  const out = { ...head, baseline: { value: baseline.value, label: baseline.label },
    source: copySource(r.source), status, note };
  if (isNum(r.fetchedAt)) out.fetchedAt = isoSec(r.fetchedAt);
  out.points = points.map((p) => [isoSec(p.t), p.v, Core.pctChange(p.v, baseline.value)]);
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

/** JSON text with object keys sorted, for content comparison. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  const s = JSON.stringify(value);
  return s === undefined ? 'null' : s;
}

/** True when two session objects differ at most in generatedAt and the series' fetchedAt. */
function sameSessionContent(a, b) {
  const strip = (s) => ({ ...s, generatedAt: null,
    series: Array.isArray(s.series) ? s.series.map((x) => (x && typeof x === 'object' ? { ...x, fetchedAt: null } : x)) : s.series });
  return Boolean(a && b) && canonicalJson(strip(a)) === canonicalJson(strip(b));
}

/** Index object (spec 2.1) from session objects and notes keyed by date (object or Map). */
function buildIndex(sessions, notesByDate, updatedAt) {
  const notesFor = (date) => {
    if (!notesByDate) return null;
    if (notesByDate instanceof Map) return notesByDate.get(date) || null;
    return hasOwn(notesByDate, date) ? notesByDate[date] || null : null;
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
 * Why this run should not collect the existing file ('final' | 'repair-wait' | 'repair-closed' | 'throttled'), or null.
 * final: the file is final (generated 20+ minutes after its window end) and has no stale/error series;
 * repair-wait: a final file with a stale/error series that is less than 60 minutes old (it is collected
 *   again once older; a result that differs only in fetch times writes nothing);
 * repair-closed: a final file with a stale/error series more than 8 hours after its window end (it keeps
 *   its honest stale/error statuses instead of being requested again on every later trigger);
 * throttled (only with throttle: true, i.e. push-triggered runs): generated less than 10 minutes ago.
 * --force overrides all four.
 */
function shouldSkip(opts) {
  const { existing, nowMs, force = false, throttle = false } = opts || {};
  if (force || !existing) return null;
  const generated = Date.parse(existing.generatedAt);
  if (!Number.isFinite(generated)) return null;
  const now = Core.toMs(nowMs);
  const end = Date.parse(existing.window && existing.window.end);
  const failed = (existing.series || []).some((s) => s && (s.status === 'stale' || s.status === 'error'));
  if (existing.final === true && Number.isFinite(end) && generated >= end + FINAL_AFTER_MS) {
    if (!failed) return 'final';
    if (now > end + REPAIR_UNTIL_MS) return 'repair-closed';
    if (now - generated < REPAIR_AFTER_MS) return 'repair-wait';
  }
  if (throttle && now - generated < THROTTLE_MS) return 'throttled';
  return null;
}

const SKIP_TEXT = {
  final: 'session is already final',
  'repair-wait': 'final session with failed series was collected less than 60 minutes ago',
  'repair-closed': 'final session keeps its failed series: repairs stop 8 hours after the window end (use --force)',
  throttled: 'collected less than 10 minutes ago',
};

/** A Yahoo-sourced series note that records HTTP 429 or an explicit refusal. */
function isRefusalNote(note) {
  return typeof note === 'string' && (note.includes(NOTE_RATE_LIMITED) || note.includes(`${NOTE_REFUSED}(`));
}

/**
 * Cross-run backoff: true when the existing file was generated less than 30 minutes ago and every
 * Yahoo-sourced series in it carries the HTTP 429 / refusal note (Yahoo refused that run outright).
 */
function yahooBackoff(existing, nowMs) {
  if (!existing || !Array.isArray(existing.series)) return false;
  const age = Core.toMs(nowMs) - Date.parse(existing.generatedAt);
  if (!(age >= 0 && age < BACKOFF_MS)) return false;
  const yahoo = existing.series.filter((s) => s && s.source && s.source.provider === 'yahoo');
  return yahoo.length > 0 && yahoo.every((s) => isRefusalNote(s.note));
}

// ---------------------------------------------------------------- requests

/** Network transport: one GET with the honest User-Agent, no redirects followed, 20 s timeout -> {status, text}. */
async function httpTransport(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': userAgent(process.env), Accept: 'application/json' },
    redirect: 'manual',
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

/** HTTP statuses that mean Yahoo refuses this client (a redirect is a consent or bot-check page). */
const isRefusalStatus = (status) => status === 401 || status === 403 || status === 451 || (status >= 300 && status < 400);

/** Run time budget: `deadline` on the `timer` clock (real elapsed time, independent of --now). */
function makeBudget(timer = Date.now, ms = RUN_DEADLINE_MS) {
  const deadline = timer() + ms;
  return { timer, deadline, left: () => deadline - timer(), expired: () => timer() >= deadline };
}

/**
 * Sequential Yahoo client: >= 500 ms between requests. It stops for the rest of the run (every later
 * call answers with the reason, without a request) after HTTP 429, an explicit refusal (401/403/451,
 * 3xx, a 200 answer that is not JSON), two requests in a row without an answer, or the run deadline.
 * opts.backoff: start stopped (the previous run was refused less than 30 minutes ago).
 * `stopped` is the reason text once stopped, else null.
 */
function yahooClient(transport, sleep, opts = {}) {
  const budget = opts.budget || null;
  let stopped = opts.backoff ? NOTE_BACKOFF : null;
  let sent = false;
  let silent = 0;
  const stop = (note) => {
    stopped = note;
    return { error: note };
  };
  return {
    get stopped() {
      return stopped;
    },
    async chart(url) {
      if (stopped) return { error: stopped };
      if (budget && budget.expired()) return stop(NOTE_YAHOO_DEADLINE);
      if (sent) await sleep(YAHOO_GAP_MS);
      sent = true;
      const res = await request(transport, url, sleep);
      if (res.status === 0) {
        silent += 1;
        if (silent >= YAHOO_MAX_SILENT) stopped = NOTE_SILENT;
        return { error: failureText('Yahoo', res) };
      }
      silent = 0;
      if (res.status === 429) return stop(NOTE_RATE_LIMITED);
      if (isRefusalStatus(res.status)) return stop(`${NOTE_REFUSED}(HTTP ${res.status})`);
      if (res.status !== 200) return { error: failureText('Yahoo', res) };
      let json;
      try {
        json = JSON.parse(res.text);
      } catch (error) {
        return stop(`${NOTE_REFUSED}(JSON 아닌 응답)`);
      }
      try {
        return { chart: parseYahooChart(json) };
      } catch (error) {
        return { error: 'Yahoo 응답 형식 오류' };
      }
    },
  };
}

/** All Coin Metrics pages (https, same host only, at most 5) -> {rows, fetchedAt} | {error}. */
async function fetchCoinMetrics(transport, sleep, url, clock, budget = null) {
  const host = new URL(url).host;
  const rows = [];
  let next = url;
  for (let page = 0; next && page < CM_MAX_PAGES; page++) {
    if (budget && budget.expired()) return { error: NOTE_CM_DEADLINE };
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
  const points = yahooPoints(chart, { window: win, nowMs, closeKst: def.closeKst || null, breakKst: def.breakKst || null });
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

/**
 * Fetch every catalog series in order (Coin Metrics first, then Yahoo sequentially) -> results.
 * opts.yahoo: a yahooClient shared by the run (else a new one); opts.budget: the run deadline.
 */
async function collectSeries(opts) {
  const { date, window: win, nowMs, previous, transport, sleep, clock, budget = null } = opts;
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
    const got = await fetchCoinMetrics(transport, sleep, coinMetricsUrl(cmAssets, win, nowMs), clock, budget);
    cm = got.error
      ? { error: got.error }
      : { series: coinMetricsSeries(got.rows, { window: win, nowMs }), fetchedAt: got.fetchedAt };
  }
  const yahoo = opts.yahoo || yahooClient(transport, sleep, { budget });
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

const sessionPath = (dataDir, date) => path.join(dataDir, 'sessions', `${date}.json`);

function listDated(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Valid dated files (YYYY-MM-DD.json) of a directory; invalid ones are reported through warn and skipped. */
function readDated(dir, validate, warn) {
  const out = [];
  for (const name of listDated(dir)) {
    try {
      const obj = validate(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
      if (obj.date !== name.slice(0, 10)) throw new Error(`date ${obj.date} does not match the file name`);
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

/**
 * Rebuild index.json from the session and notes files; writes only when its content (apart from
 * updatedAt) changes. updatedAtMs null: the newest session generatedAt (deterministic rebuilds).
 */
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
  let stamp = updatedAtMs;
  if (stamp == null) {
    const times = sessions.map((s) => Date.parse(s.generatedAt)).filter(Number.isFinite);
    stamp = times.length ? Math.max(...times) : Date.now();
  }
  const next = buildIndex(sessions, notes, stamp);
  if (!current && !sessions.length) return { written: false, index: null };
  if (current && typeof current === 'object'
    && JSON.stringify({ ...current, updatedAt: null }) === JSON.stringify({ ...next, updatedAt: null })) {
    return { written: false, index: current };
  }
  writeFileAtomic(file, serializeJson(next));
  return { written: true, index: next };
}

/**
 * --overlay-dir: every valid <overlay>/sessions/YYYY-MM-DD.json whose generatedAt is newer than the copy
 * in dataDir (or that has no valid copy there) replaces it, byte for byte, before anything is collected,
 * so the run, the backlog and the rebuilt index all see the newest copy. Notes are never read from the
 * overlay. In a dry run nothing is copied; the chosen sessions are returned in `pending` instead.
 */
function applyOverlay({ dataDir, overlayDir, dryRun, log }) {
  const pending = new Map();
  const copied = [];
  if (!overlayDir) return { pending, copied };
  const dir = path.join(path.resolve(overlayDir), 'sessions');
  for (const name of listDated(dir)) {
    const date = name.slice(0, 10);
    let text;
    let session;
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
      session = Core.validateSession(JSON.parse(text));
      if (session.date !== date) throw new Error(`date ${session.date} does not match the file name`);
    } catch (error) {
      log(`warning: ignoring overlay sessions/${name}: ${error.message}`);
      continue;
    }
    const local = readSessionFile(sessionPath(dataDir, date), date, () => {});
    if (local && !(Date.parse(session.generatedAt) > Date.parse(local.generatedAt))) continue;
    if (dryRun) {
      pending.set(date, session);
    } else {
      writeFileAtomic(sessionPath(dataDir, date), text);
      copied.push(date);
    }
  }
  if (copied.length) log(`Overlay: newer session files taken for ${copied.join(', ')}.`);
  if (pending.size) log(`Overlay (dry run): newer session files would be taken for ${[...pending.keys()].join(', ')}.`);
  return { pending, copied };
}

function summaryLine(s) {
  const base = s.baseline && s.baseline.value !== null ? `${s.baseline.value} (${s.baseline.label})` : '-';
  const src = s.source ? `${s.source.provider}:${s.source.symbol}` : '-';
  return `  ${s.id.padEnd(10)} ${s.status.padEnd(7)} ${String(s.points.length).padStart(3)} pts  base ${base}  ${src}`
    + `${s.note ? `  [${s.note}]` : ''}`;
}

// ---------------------------------------------------------------- run

/**
 * Collect one session (ctx: the run context) -> {status: 'written'|'unchanged'|'skipped'|'dry-run',
 * reason?, date, final, session?}. opts: {start, end, explicit, replaceWindow, force, throttle, backlog}.
 * A backlog session is not written when Yahoo stopped during its collection (it is retried later).
 */
async function collectSession(ctx, date, opts) {
  const { log, nowMs, clock, dataDir, dryRun, budget } = ctx;
  const existing = ctx.readExisting(date);
  let win;
  if (opts.explicit || !existing) {
    try {
      win = Core.sessionWindow(date, opts.start || undefined, opts.end || undefined);
    } catch (error) {
      throw new UsageError(error.message);
    }
  } else {
    win = { start: Core.isoUtc(Date.parse(existing.window.start)), end: Core.isoUtc(Date.parse(existing.window.end)) };
  }
  if (existing && !sameWindow(existing.window, win) && !opts.replaceWindow) {
    throw new UsageError(`${date}: the stored session covers ${windowText(existing.window)} KST, not ${windowText(win)} KST; `
      + 'pass --replace-window to replace it (its stored points are not carried over)');
  }
  if (nowMs < Date.parse(win.start)) {
    log(`${date}: the window starts at ${Core.kstTime(win.start)} KST and has not started yet; nothing written.`);
    return { status: 'skipped', reason: 'not-started', date, final: false };
  }
  const skip = shouldSkip({ existing, nowMs, force: opts.force, throttle: opts.throttle });
  if (skip) {
    log(`${date}: ${SKIP_TEXT[skip]}; skipping (use --force to collect anyway).`);
    return { status: 'skipped', reason: skip, date, final: existing.final };
  }
  const previous = existing && sameWindow(existing.window, win) ? existing : null;
  if (!ctx.yahoo) {
    const backoff = yahooBackoff(previous, nowMs);
    if (backoff) log(`Yahoo refused the run at ${Core.kstTime(previous.generatedAt)} KST; no Yahoo request until 30 minutes have passed.`);
    ctx.yahoo = yahooClient(ctx.transport, ctx.sleep, { budget, backoff });
  }
  const stoppedBefore = ctx.yahoo.stopped;
  log(`Collecting ${date} ${windowText(win)} KST (${win.start} .. ${win.end}), now ${isoSec(nowMs)}${ctx.fixtures ? `, fixtures ${ctx.fixtures}` : ''}`);
  const results = await collectSeries({ date, window: win, nowMs, previous, transport: ctx.transport, sleep: ctx.sleep,
    clock, budget, yahoo: ctx.yahoo });
  const session = Core.validateSession(buildSession({ date, window: win, nowMs, generatedAt: clock(), results, previous }));
  for (const s of session.series) log(summaryLine(s));
  const withData = session.series.filter((s) => s.points.length).length;
  if (dryRun) {
    log(`Dry run: ${withData}/${session.series.length} series with data, final ${session.final}; nothing written.`);
    return { status: 'dry-run', date, final: session.final, session };
  }
  if (opts.backlog && !stoppedBefore && ctx.yahoo.stopped) {
    log(`${date}: not written, Yahoo stopped during the collection (${ctx.yahoo.stopped}); a later run finalizes it.`);
    return { status: 'skipped', reason: 'provider-stopped', date, final: existing ? existing.final : false };
  }
  if (existing && sameSessionContent(existing, session)) {
    log(`${date}: nothing changed since ${existing.generatedAt} apart from fetch times; nothing written.`);
    return { status: 'unchanged', date, final: existing.final, session };
  }
  const file = sessionPath(dataDir, date);
  writeFileAtomic(file, serializeJson(session));
  const shown = path.relative(process.cwd(), file);
  log(`Wrote ${!shown || shown.startsWith('..') ? file : shown}: ${withData}/${session.series.length} series with data, final ${session.final}.`);
  return { status: 'written', date, final: session.final, session };
}

/** Sessions of the data directory (plus dry-run overlay copies), each validated. */
function knownSessions(ctx) {
  const byDate = new Map(readDated(path.join(ctx.dataDir, 'sessions'), Core.validateSession, () => {}).map((s) => [s.date, s]));
  for (const [date, s] of ctx.pending) byDate.set(date, s);
  return [...byDate.values()];
}

/**
 * security-2: an unattended run also collects, once, the newest (at most 5) earlier sessions that are
 * still not final although their window ended 20+ minutes ago, so a missed post-close run cannot leave
 * a session "live" forever. Postponed while Yahoo is stopped or the run deadline is near.
 */
async function finalizeBacklog(ctx, mainDate) {
  const { nowMs, log, budget } = ctx;
  const due = knownSessions(ctx)
    .filter((s) => s.date !== mainDate && s.final !== true && Date.parse(s.window.end) + FINAL_AFTER_MS <= nowMs)
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, BACKLOG_MAX);
  const out = [];
  for (const s of due) {
    if (ctx.yahoo && ctx.yahoo.stopped) {
      log(`${s.date}: not final yet; finalizing it waits for a later run (${ctx.yahoo.stopped}).`);
      break;
    }
    if (budget.left() < BACKLOG_MIN_LEFT_MS) {
      log(`${s.date}: not final yet; finalizing it waits for a later run (run time budget).`);
      break;
    }
    log(`${s.date}: earlier session is not final although its window ended; collecting it once more.`);
    out.push(await collectSession(ctx, s.date, { explicit: false, force: false, throttle: ctx.throttle, backlog: true }));
  }
  return out;
}

/** --rebuild-index: index.json from the sessions and notes of dataDir (updatedAt = newest generatedAt). */
function rebuildIndex(dataDir, log) {
  const { written, index } = syncIndex(dataDir, null, log);
  const count = index ? index.sessions.length : 0;
  log(written ? `Rebuilt ${path.join(dataDir, 'index.json')}: ${count} sessions.`
    : `index.json already lists the ${count} session files; nothing written.`);
  return { status: written ? 'index-written' : 'index-unchanged', index, indexWritten: written };
}

/**
 * Collect the session of --date (default: the current session) and refresh the index. Without --date,
 * earlier non-final sessions are finalized as well (see finalizeBacklog).
 * options: {date, start, end, dataDir, overlayDir, now, fixtures, force, throttle, replaceWindow, dryRun,
 *   rebuildIndex, transport, sleep, clock, timer, log}
 * Returns {status: 'written'|'unchanged'|'skipped'|'dry-run', reason?, date, final, session?, backlog: [...],
 *   overlay: [dates copied], index, indexWritten}.
 */
async function run(options = {}) {
  const o = options;
  const log = o.log || ((line) => console.log(line));
  const dataDir = path.resolve(o.dataDir || DEFAULT_DATA_DIR);
  if (o.rebuildIndex) return rebuildIndex(dataDir, log);
  const fixedNow = o.now == null ? null : Core.toMs(o.now);
  if (fixedNow !== null && !Number.isFinite(fixedNow)) throw new Error(`invalid now: ${o.now}`);
  const clock = o.clock || (() => (fixedNow === null ? Date.now() : fixedNow));
  const nowMs = clock();
  const today = Core.kstDate(nowMs);
  if (o.date && o.date > today) {
    throw new UsageError(`--date ${o.date} is later than today (${today} KST); a session is collected only once its window has started`);
  }
  const dryRun = Boolean(o.dryRun);
  const overlay = applyOverlay({ dataDir, overlayDir: o.overlayDir, dryRun, log });
  const ctx = {
    log, nowMs, clock, dataDir, dryRun,
    fixtures: o.fixtures || null,
    throttle: Boolean(o.throttle),
    sleep: o.sleep || (o.fixtures ? async () => {} : delay),
    transport: o.transport || (o.fixtures ? fixtureTransport(path.resolve(o.fixtures)) : httpTransport),
    budget: makeBudget(o.timer || Date.now, RUN_DEADLINE_MS),
    pending: overlay.pending,
    yahoo: null,
    readExisting: (date) => (overlay.pending.has(date) ? overlay.pending.get(date)
      : readSessionFile(sessionPath(dataDir, date), date, log)),
  };

  let main = null;
  let date = o.date || null;
  if (!date) {
    date = defaultDate(nowMs, o.start);
    if (isWeekend(date)) {
      log(`${date} is a weekend in KST; nothing to collect for it (pass --date to collect it anyway).`);
      main = { status: 'skipped', reason: 'weekend', date, final: false };
    }
  }
  if (!main) {
    main = await collectSession(ctx, date, { start: o.start, end: o.end, explicit: o.start != null || o.end != null,
      replaceWindow: Boolean(o.replaceWindow), force: Boolean(o.force), throttle: ctx.throttle });
  }
  const backlog = o.date ? [] : await finalizeBacklog(ctx, date);
  let index = { written: false, index: null };
  if (!dryRun) {
    const written = [main, ...backlog].filter((r) => r.status === 'written');
    const stamp = written.length ? Math.max(...written.map((r) => Date.parse(r.session.generatedAt))) : nowMs;
    index = syncIndex(dataDir, stamp, log);
    if (index.written) log(`Index lists ${index.index.sessions.length} sessions.`);
  }
  return { ...main, backlog, overlay: overlay.copied, index: index.index, indexWritten: index.written };
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { date: null, start: null, end: null, dataDir: null, overlayDir: null, now: null, fixtures: null,
    force: false, dryRun: false, throttle: false, replaceWindow: false, rebuildIndex: false };
  const flags = { '--force': 'force', '--dry-run': 'dryRun', '--throttle': 'throttle', '--replace-window': 'replaceWindow',
    '--rebuild-index': 'rebuildIndex' };
  const valued = { '--date': 'date', '--start': 'start', '--end': 'end', '--data-dir': 'dataDir', '--overlay-dir': 'overlayDir',
    '--now': 'now', '--fixtures': 'fixtures' };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if ((arg === '--help' || arg === '-h') && value === undefined) {
      out.help = true;
    } else if (hasOwn(flags, arg) && value === undefined) {
      out[flags[arg]] = true;
    } else if (hasOwn(valued, arg)) {
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
  if (out.rebuildIndex) {
    const others = ['date', 'start', 'end', 'overlayDir', 'now', 'fixtures'].filter((k) => out[k] !== null)
      .concat(['force', 'dryRun', 'throttle', 'replaceWindow'].filter((k) => out[k]));
    if (others.length) throw new Error('--rebuild-index takes only --data-dir');
  }
  if (out.replaceWindow && out.start === null && out.end === null) throw new Error('--replace-window needs --start or --end');
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
    if (args.rebuildIndex) return 0;
    const all = [result, ...(result.backlog || [])];
    if (process.env.GITHUB_ACTIONS === 'true') {
      for (const r of all) {
        if (!r.session) continue;
        const title = r === result ? '' : ` ${r.date}`;
        for (const s of r.session.series) {
          if (s.status === 'stale' || s.status === 'error') console.log(`::warning title=parallel ${s.id}${title}::${s.status}: ${s.note}`);
        }
      }
    }
    writeGithubOutput({ date: result.date, final: String(Boolean(result.final)), status: result.status,
      written: all.filter((r) => r.status === 'written').map((r) => r.date).join(' ') });
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`collect-parallel: ${error.message}`);
      return 2;
    }
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
  USER_AGENT, NOTE_NO_DATA, NOTE_RATE_LIMITED, NOTE_REFUSED, NOTE_SILENT, NOTE_YAHOO_DEADLINE, NOTE_CM_DEADLINE,
  NOTE_BACKOFF, NOTE_KEPT_EMPTY, NOTE_KEPT_PARTIAL, NOTE_FILLED_START, NOTE_NO_BASELINE, LABEL_PREV_CLOSE_FALLBACK,
  THROTTLE_MS, REPAIR_AFTER_MS, BACKOFF_MS, RUN_DEADLINE_MS, BACKLOG_MAX, UsageError,
  userAgent, cleanPrice, sanitizeSymbol, parseYahooChart, tradingPeriods, periodOf, yahooRange, yahooIntradayUrl,
  yahooDailyUrl, yahooPoints, yahooBaseline, isPlaceholderBar, dailyPrevClose, parseCmTime, coinMetricsUrl,
  coinMetricsSeries, buildSeries, buildSession, sameSessionContent, buildIndex, serializeJson, defaultDate, isWeekend,
  shouldSkip, yahooBackoff, httpTransport, fixtureTransport, request, makeBudget, yahooClient, fetchCoinMetrics,
  collectSeries, syncIndex, applyOverlay, parseArgs, run, main,
};
