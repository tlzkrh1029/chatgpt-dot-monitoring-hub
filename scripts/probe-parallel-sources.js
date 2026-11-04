#!/usr/bin/env node
'use strict';
/* Read-only source probe for the parallel timeline (workflow `mode: probe`, or by hand).
 *
 * Checks whether this machine can reach the collector's sources, the way the collector asks them:
 * - Coin Metrics Community: one ReferenceRateUSD request for the last hour (all crypto assets of the catalog);
 * - Yahoo Finance chart API: per catalog symbol, the 15-minute bars of the last five days and the daily bars
 *   of the last month.
 * Every request carries the collector's honest User-Agent (named after GITHUB_REPOSITORY when set), requests
 * are sequential and at least 700 ms apart, nothing is retried, redirects are not followed, and the probe
 * stops at the first refusal (HTTP 429/401/403/451, a redirect or a 200 answer that is not JSON) or after two
 * requests in a row without an answer. It writes only <out>/report.json: statuses, timings and parsed
 * summaries, never raw response bodies.
 *
 * Usage: node scripts/probe-parallel-sources.js [OUT_DIR]   (default probe-out)
 */
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../parallel-core.js');
const { userAgent, coinMetricsUrl } = require('./collect-parallel.js');

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const PAUSE_MS = 700;
const TIMEOUT_MS = 20000;
const INTRADAY_DAYS = 5;
const CM_LOOKBACK_MS = 3600e3;
const MAX_SILENT = 2; // requests in a row without an answer (timeout, network error) that stop the probe
const REFUSAL_STATUSES = [401, 403, 429, 451];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Catalog symbols per provider, in catalog order without duplicates. */
function catalogSymbols(provider) {
  const out = [];
  for (const series of Core.SERIES) {
    for (const source of series.sources) {
      if (source.provider === provider && !out.includes(source.symbol)) out.push(source.symbol);
    }
  }
  return out;
}

/** Why an answer means "stop asking": 'HTTP 429', 'redirect', 'not JSON', or null. */
function refusal(status, json) {
  if (REFUSAL_STATUSES.includes(status)) return `HTTP ${status}`;
  if (status >= 300 && status < 400) return 'redirect';
  if (status === 200 && json === undefined) return 'not JSON';
  return null;
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch (_) {
    return undefined;
  }
};
const iso = (sec) => (Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null);
const clip = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : value == null ? null : String(value).slice(0, max));

/** Parsed facts of a Yahoo chart answer (never the body itself). */
function summarizeYahoo(json) {
  const chart = json && json.chart;
  if (chart && chart.error) return { error: { code: clip(chart.error.code), description: clip(chart.error.description) } };
  const result = chart && Array.isArray(chart.result) ? chart.result[0] : null;
  if (!result || typeof result !== 'object') return { shape: 'unexpected' };
  const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
  const meta = result.meta || {};
  return { bars: ts.length, first: iso(ts[0]), last: iso(ts[ts.length - 1]), tz: clip(meta.exchangeTimezoneName),
    gmtoffset: meta.gmtoffset, granularity: clip(meta.dataGranularity), chartPreviousClose: meta.chartPreviousClose,
    previousClose: meta.previousClose, regularMarketTime: iso(meta.regularMarketTime), currency: clip(meta.currency),
    instrumentType: clip(meta.instrumentType) };
}

/** Parsed facts of a Coin Metrics answer: rows and time range per asset (never the values). */
function summarizeCoinMetrics(json) {
  if (json && json.error) return { error: { type: clip(json.error.type), message: clip(json.error.message) } };
  const rows = json && Array.isArray(json.data) ? json.data : null;
  if (!rows) return { shape: 'unexpected' };
  const assets = {};
  for (const row of rows) {
    if (!row || typeof row.asset !== 'string') continue;
    const a = assets[row.asset] || (assets[row.asset] = { rows: 0, first: null, last: null });
    a.rows += 1;
    const t = clip(row.time, 40);
    if (t && (!a.first || t < a.first)) a.first = t;
    if (t && (!a.last || t > a.last)) a.last = t;
  }
  return { rows: rows.length, assets, nextPage: typeof json.next_page_url === 'string' };
}

/**
 * Run the probe -> report {generatedAt, userAgent, plan, stopped, requests:[...]}.
 * opts (tests): {fetchImpl, now: () => ms, sleep, env, log}.
 */
async function probe(opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || pause;
  const log = opts.log || ((line) => console.log(line));
  const ua = userAgent(opts.env || process.env);
  const startMs = now();
  const assets = catalogSymbols('coinmetrics');
  const symbols = catalogSymbols('yahoo');
  const plan = [];
  if (assets.length) {
    const end = Math.floor(startMs / 60000) * 60000;
    plan.push({ provider: 'coinmetrics', symbol: assets.join(','), kind: 'last-hour', summarize: summarizeCoinMetrics,
      url: coinMetricsUrl(assets, { start: Core.isoUtc(end - CM_LOOKBACK_MS), end: Core.isoUtc(end) }, end) });
  }
  const period2 = Math.floor(startMs / 1000);
  const period1 = period2 - INTRADAY_DAYS * 86400;
  for (const symbol of symbols) {
    const base = `${YAHOO_CHART}${encodeURIComponent(symbol)}`;
    plan.push({ provider: 'yahoo', symbol, kind: 'intraday', summarize: summarizeYahoo,
      url: `${base}?interval=15m&period1=${period1}&period2=${period2}&includePrePost=false` });
    plan.push({ provider: 'yahoo', symbol, kind: 'daily', summarize: summarizeYahoo, url: `${base}?interval=1d&range=1mo` });
  }
  const report = { generatedAt: Core.isoUtc(Math.floor(startMs / 1000) * 1000), userAgent: ua,
    plan: { coinmetrics: assets, yahoo: symbols, intradayDays: INTRADAY_DAYS }, stopped: null, requests: [] };
  let silent = 0;
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    if (i > 0) await sleep(PAUSE_MS);
    const started = now();
    let status = 0;
    let text = '';
    let failure = null;
    try {
      const response = await fetchImpl(item.url, {
        headers: { 'User-Agent': ua, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      failure = error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'network error';
    }
    const json = status ? parseJson(text) : undefined;
    const entry = { provider: item.provider, symbol: item.symbol, kind: item.kind, url: item.url, status, ms: now() - started };
    if (failure) entry.error = failure;
    if (json !== undefined) Object.assign(entry, item.summarize(json));
    else if (status) entry.bytes = Buffer.byteLength(text, 'utf8');
    report.requests.push(entry);
    log(JSON.stringify({ provider: entry.provider, symbol: entry.symbol, kind: entry.kind, status, ms: entry.ms,
      ...(failure ? { error: failure } : {}) }));
    const refused = refusal(status, json);
    silent = status === 0 ? silent + 1 : 0;
    if (refused || silent >= MAX_SILENT) {
      report.stopped = { provider: item.provider, symbol: item.symbol, kind: item.kind,
        reason: refused || `${MAX_SILENT} requests in a row without an answer`, remaining: plan.length - i - 1 };
      log(`Stopping: ${item.provider} ${refused ? `refused (${refused})` : 'did not answer'}; no further requests and no retries.`);
      break;
    }
  }
  return report;
}

async function main(argv = process.argv.slice(2), opts = {}) {
  const out = argv[0] || 'probe-out';
  const report = await probe(opts);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`probe-parallel-sources failed: ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  });
}

module.exports = { probe, main, catalogSymbols, summarizeYahoo, summarizeCoinMetrics, refusal,
  PAUSE_MS, INTRADAY_DAYS, REFUSAL_STATUSES };
