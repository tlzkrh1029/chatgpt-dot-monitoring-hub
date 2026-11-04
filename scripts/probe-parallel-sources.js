#!/usr/bin/env node
'use strict';
// One-off, read-only feasibility probe for the parallel timeline sources.
// Sends plain requests with an honest User-Agent, never retries around a block,
// and stops early when the provider rate-limits. Raw bodies go to an output
// directory that is uploaded as a short-lived workflow artifact, never to Git.
const fs = require('node:fs');
const path = require('node:path');

const UA = 'chatgpt-dot-monitoring-hub/2.0 (+https://github.com/tlzkrh1029/chatgpt-dot-monitoring-hub)';
const SYMBOLS = ['^KS11', '^N225', '^TWII', '^HSI', 'NQ=F', '000660.KS', '005930.KS', '2330.TW', '9984.T', '6857.T',
  'DX-Y.NYB', 'KRW=X', 'JPY=X', 'GC=F', 'BTC-USD', 'ETH-USD', 'HYPE32196-USD', 'ZEC-USD', 'XMR-USD'];
const out = process.argv[2] || 'probe-out';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function get(url, headers) {
  const started = Date.now();
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const body = await response.text();
    return { status: response.status, ms: Date.now() - started, body };
  } catch (error) {
    return { status: 0, ms: Date.now() - started, body: '', error: error.message };
  }
}

function summarize(body) {
  try {
    const result = JSON.parse(body).chart.result[0];
    const ts = result.timestamp || [];
    const meta = result.meta;
    return { bars: ts.length, first: ts.length ? new Date(ts[0] * 1000).toISOString() : null,
      last: ts.length ? new Date(ts.at(-1) * 1000).toISOString() : null, tz: meta.exchangeTimezoneName,
      gmtoffset: meta.gmtoffset, granularity: meta.dataGranularity, chartPreviousClose: meta.chartPreviousClose,
      previousClose: meta.previousClose, regularMarketTime: meta.regularMarketTime, currency: meta.currency,
      instrumentType: meta.instrumentType, currentTradingPeriod: meta.currentTradingPeriod };
  } catch (_) { return { unparsed: body.slice(0, 120) }; }
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const report = [];
  // Header variants: honest custom UA first, then the runtime default UA. No browser impersonation.
  for (const [label, headers] of [['custom-ua', { 'User-Agent': UA, Accept: 'application/json' }], ['default-ua', { Accept: 'application/json' }]]) {
    const probe = await get('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=15m&range=1d', headers);
    report.push({ variant: label, status: probe.status, ms: probe.ms, error: probe.error });
    console.log(`variant ${label}: HTTP ${probe.status}${probe.error ? ' ' + probe.error : ''}`);
    await pause(1500);
  }
  let consecutiveLimited = 0;
  const period1 = Math.floor(Date.parse('2026-10-26T00:00:00Z') / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  for (const symbol of SYMBOLS) {
    for (const [kind, query] of [['intraday', `interval=15m&period1=${period1}&period2=${period2}&includePrePost=false`],
      ['daily', 'interval=1d&range=1mo']]) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`;
      const result = await get(url, { 'User-Agent': UA, Accept: 'application/json' });
      const file = `${symbol.replace(/[^A-Za-z0-9.-]/g, '_')}.${kind}.json`;
      if (result.status === 200) fs.writeFileSync(path.join(out, file), result.body);
      const entry = { symbol, kind, status: result.status, ms: result.ms, error: result.error,
        ...(result.status === 200 ? summarize(result.body) : { body: result.body.slice(0, 120) }) };
      report.push(entry);
      console.log(JSON.stringify(entry));
      consecutiveLimited = result.status === 429 ? consecutiveLimited + 1 : 0;
      if (consecutiveLimited >= 3) {
        console.log('Provider is rate-limiting this runner; stopping without retries.');
        fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
        return;
      }
      await pause(700);
    }
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
})();
