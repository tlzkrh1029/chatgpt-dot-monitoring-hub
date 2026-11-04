'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../parallel-data.js');
const fixture = require('./parallel-v2-fixture.js');

function view(data) {
  let clock = Date.parse('2026-11-04T00:36:00Z');
  const elements = new Map(), timers = new Map();
  let timerId = 0;
  const document = {
    hidden: false,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', hidden: false, value: '10', dataset: {}, handlers: {},
        setAttribute() {}, addEventListener(event, handler) { this.handlers[event] = handler; }, reset() {} });
      return elements.get(id);
    },
    addEventListener() {}
  };
  const context = {
    document, Intl, Date, URL, URLSearchParams, location: { search: '' },
    setInterval(handler, milliseconds) { const id = ++timerId; timers.set(id, { handler, milliseconds }); return id; },
    clearInterval(id) { timers.delete(id); },
    ParallelData: { ...P, sourceFreshness(value, id) { return P.sourceFreshness(value, id, clock); } },
    ParallelRefresh: { createController({ onChange }) { return { async refresh() {
      const snapshot = { data, error: '', lastAttemptAt: new Date(clock).toISOString(), lastReceivedAt: new Date(clock).toISOString() };
      onChange(snapshot); return snapshot;
    } }; } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'parallel-view.js'), 'utf8'), context, { filename: 'parallel-view.js' });
  return { elements, timers, document, setClock(value) { clock = Date.parse(value); } };
}

test('live view attributes licensed data and separates latest source, plotted sample and receipt clocks', async () => {
  const raw = fixture();
  P.validateDataset(raw, { now: '2026-11-04T00:36:00Z' });
  const { elements } = view(raw);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('provider-section').hidden, false);
  const provider = elements.get('provider-details').innerHTML;
  assert.match(provider, /Data: Coin Metrics/);
  assert.match(provider, /https:\/\/creativecommons.org\/licenses\/by-nc\/4\.0\//);
  assert.match(provider, /Synthetic exact 15-minute samples and percentage calculation/);
  const table = elements.get('series-table').innerHTML;
  assert.match(table, /최신 1분 계산[^<]*09:34:00/);
  assert.match(table, /차트 표본[^<]*09:30:00/);
  assert.match(table, /원자료 수신[^<]*09:34:30/);
  assert.match(table, /\+2\.00%/);
  assert.doesNotMatch(table, /\+3\.00%/);
  assert.match(elements.get('fetch-status').textContent, /게시자료 수신.*09:36:00.*파일 작성.*09:35:00/);
  assert.match(elements.get('chart').innerHTML, /복합 기준가격 \/ 15분 표본/);
});

test('live view ages retained data without new publication and does not freshen it when JSON is re-read', async () => {
  const raw = fixture(), mounted = view(raw);
  await new Promise(resolve => setImmediate(resolve));
  const freshnessTimer = [...mounted.timers.values()].find(timer => timer.milliseconds === 60000);
  assert.ok(freshnessTimer);
  mounted.setClock('2026-11-04T00:55:00Z');
  freshnessTimer.handler();
  assert.match(mounted.elements.get('coverage-title').textContent, /원자료 지연/);
  assert.match(mounted.elements.get('series-table').innerHTML, /현재 원자료 경과 21분/);
  assert.match(mounted.elements.get('series-table').innerHTML, /\+2\.00%/);
  await mounted.elements.get('refresh').handlers.click();
  assert.match(mounted.elements.get('fetch-status').textContent, /09:55:00/);
  assert.match(mounted.elements.get('series-table').innerHTML, /최신 1분 계산[^<]*09:34:00/);
  assert.match(mounted.elements.get('coverage-title').textContent, /원자료 지연/);
});

test('legacy empty publications render without provider claims or a license block', async () => {
  const legacy = fixture();
  legacy.schemaVersion = 1; delete legacy.providers;
  legacy.series.forEach(series => { series.points = []; series.asOf = null; series.observedAt = null; series.availability = 'unsupported'; });
  const { elements } = view(legacy);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.get('provider-section').hidden, true);
  assert.equal(elements.get('provider-details').innerHTML, '');
  assert.match(elements.get('coverage-title').textContent, /자동 수집 미연결/);
});
