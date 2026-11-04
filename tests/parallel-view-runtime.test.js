'use strict';
// Page runtime of the parallel timeline (ParallelView.start): data bases and fallbacks, keep-last-good, polling and
// retries, the notes notice, date switches, the default view, focus-preserving refreshes, the chart slider and PNG
// export. A DOM-free harness: fake elements and document, routed fetch, manual timers and a controlled clock.
// Uses synthetic data only (never the committed data/parallel files).
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../parallel-core.js');
const Chart = require('../parallel-chart.js');
const V = require('../parallel-view.js');

const DATE = '2026-11-04';
const kst = (date, hhmm) => Date.parse(C.kstToUtcIso(date, hhmm));
const at = (hhmm) => kst(DATE, hhmm);
const clone = (v) => JSON.parse(JSON.stringify(v));
const isoZ = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const RAW = (branch) => `https://raw.githubusercontent.com/tlzkrh1029/chatgpt-dot-monitoring-hub/${branch}/data/parallel/`;
const SAME = 'data/parallel/';
const GHIO = { hostname: 'tlzkrh1029.github.io', pathname: '/chatgpt-dot-monitoring-hub/parallel.html' };
const LOCAL = { hostname: 'localhost', pathname: '/parallel.html' };

// ---------------------------------------------------------------- fixtures

/** Every catalog series with a point every 15 minutes from `from` to `to` (KST) on date. */
function makeSession(date, from, to, extra) {
  const series = C.SERIES.map((d, k) => {
    const points = [];
    for (let t = kst(date, from); t <= kst(date, to); t += 15 * 60000) {
      const p = Number((Math.sin((t / 3600e3) + k) * 1.5).toFixed(3));
      points.push([isoZ(t), Number((1000 * (1 + p / 100)).toFixed(6)), p]);
    }
    return {
      id: d.id, panel: d.panel, label: d.label, basis: d.basis,
      baseline: { value: 1000, label: d.basis === 'prevClose' ? '전일 종가' : '08:00 KST' },
      source: clone(d.sources[0]), status: 'ok', note: '', fetchedAt: isoZ(kst(date, to) + 60000), points,
    };
  });
  return Object.assign({
    schemaVersion: 3, kind: 'session', date, timezone: 'Asia/Seoul', window: C.sessionWindow(date), intervalMinutes: 15,
    generatedAt: isoZ(kst(date, to) + 60000), final: false, series, providers: clone(C.PROVIDERS),
  }, extra || {});
}

const finalSession = (date) => makeSession(date || DATE, '08:00', '16:00', { final: true, generatedAt: isoZ(kst(date || DATE, '16:25')) });

function makeNotes(date, extra) {
  return Object.assign({
    schemaVersion: 3, kind: 'notes', date: date || DATE, title: '테스트 제목', subtitle: '세로 점선 = 호출 시각',
    asOf: isoZ(kst(date || DATE, '15:00')), author: 'Claude', headline: '한 줄 요약',
    events: [{ id: 'a', at: isoZ(kst(date || DATE, '09:39')), label: '사건 A', kind: 'call', source: 'CBS', url: 'https://example.com/a' }],
    observations: ['관찰'], sections: [{ id: 'asia', heading: '세부', items: ['항목'] }], watch: ['볼 것'],
    story: [{ text: '이야기', sources: [{ label: '출처 1', url: 'https://example.com/1' }, { label: '출처 2', url: 'https://example.com/2' },
      { label: '출처 3', url: 'https://example.com/3' }] }],
    verdict: '판정',
  }, extra || {});
}

function makeIndex(entries) {
  return { schemaVersion: 3, kind: 'index', updatedAt: '2026-11-04T07:30:00Z', sessions: entries.map((e) => Object.assign({ title: null, final: true, seriesWithData: 19, hasNotes: true }, e)) };
}

// ---------------------------------------------------------------- fake DOM

const FOCUS_RE = /<(a href|button|summary|select|input|textarea)\b/g;

class FakeEl {
  constructor(h, id, tag) {
    this.h = h;
    this.id = id;
    this.tagName = (tag || 'div').toUpperCase();
    this._html = '';
    this.writes = 0;
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.title = '';
    this.value = '';
    this.style = {};
    this.attrs = {};
    this.listeners = {};
    this.classes = new Set();
    this.clientWidth = 1200;
    this.clientHeight = 900;
    this.offsetWidth = 200;
    this.offsetHeight = 100;
    this.parentElement = null;
    this.focusables = [];
    this.children = [];
  }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v);
    this.writes += 1;
    // Fresh focusable children for every write, in document order (like a real re-parse).
    this.focusables = [...this._html.matchAll(FOCUS_RE)].map((m, i) => new FakeFocusable(this.h, this, m[1], i));
    if (this.tagName === 'SELECT') {
      const m = /<option value="([^"]*)" selected>/.exec(this._html) || /<option value="([^"]*)"/.exec(this._html);
      this.value = m ? m[1] : '';
    }
  }
  get classList() {
    const c = this.classes;
    return { add: (x) => c.add(x), remove: (x) => c.delete(x), contains: (x) => c.has(x), toggle: (x, on) => ((on === undefined ? !c.has(x) : on) ? c.add(x) : c.delete(x)) };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() {}
  dispatch(type, props) {
    const ev = Object.assign({ type, target: this, button: 0, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; } }, props || {});
    for (const fn of this.listeners[type] || []) fn(ev);
    return ev;
  }
  querySelector() { return null; }
  querySelectorAll(sel) {
    if (sel.includes('a[href]')) return this.focusables;
    return this.children.filter((c) => c.matches(sel));
  }
  matches(sel) {
    const m = /^button\[(data-[a-z]+)\]$/.exec(sel);
    return !!m && this.tagName === 'BUTTON' && this.getAttribute(m[1]) !== null;
  }
  closest(sel) { return this.matches(sel) ? this : null; }
  contains(x) { return x === this || this.focusables.includes(x) || this.children.includes(x); }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }
  appendChild(c) { return c; }
  remove() {}
  click() { this.h.clicks.push(this); }
  focus() {
    this.h.doc.activeElement = this;
    this.dispatch('focus');
  }
}

class FakeFocusable {
  constructor(h, owner, kind, n) { Object.assign(this, { h, owner, kind, n }); }
  focus() { this.h.doc.activeElement = this; }
}

/**
 * A page harness: fake window and document, fetch routed by URL without its query (handler -> {status, body} |
 * 'hang' | 'neterror'), timers kept in a Map and fired by hand, and Date.now() set by h.clock.
 */
function harness(opts = {}) {
  const loc = opts.location || LOCAL;
  const h = { routes: new Map(), calls: [], timers: new Map(), nextTimer: 1, history: [], clicks: [], errors: [], chartOpts: [] };
  h.clock = opts.now;
  const doc = {
    visibilityState: 'visible', readyState: 'complete', title: '', activeElement: null, listeners: {},
    getElementById(id) {
      if (!h.els.has(id)) h.els.set(id, new FakeEl(h, id, id === 'date-select' ? 'select' : 'div'));
      return h.els.get(id);
    },
    addEventListener(type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    createElementNS() { return new FakeEl(h, '', 'g'); },
    createElement(tag) {
      if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb) => cb({ type: 'image/png' }) };
      return new FakeEl(h, '', tag);
    },
  };
  h.doc = doc;
  h.els = new Map();
  doc.documentElement = new FakeEl(h, 'html', 'html');
  doc.documentElement.setAttribute('data-theme', 'dark');
  doc.body = new FakeEl(h, 'body', 'body');
  doc.activeElement = doc.body;
  // Elements the page gets with markup from parallel.html.
  const caption = doc.getElementById('chart-caption');
  caption.parentElement = new FakeEl(h, 'figcaption', 'figcaption');
  const unit = doc.getElementById('unit-seg');
  for (const [u, pressed] of [['pct', 'true'], ['price', 'false']]) {
    const b = new FakeEl(h, '', 'button');
    b.setAttribute('data-unit', u);
    b.setAttribute('aria-pressed', pressed);
    unit.children.push(b);
  }
  class FakeURL extends URL {
    static createObjectURL() { return 'blob:fake'; }
    static revokeObjectURL() {}
  }
  const href = `https://${loc.hostname}${loc.pathname}${opts.search || ''}`;
  const win = {
    document: doc, location: { hostname: loc.hostname, pathname: loc.pathname, search: opts.search || '', href },
    console: { error: (e) => h.errors.push(e) }, innerHeight: 900, URL: FakeURL, AbortController,
    ParallelChart: { renderChart: (s, n, o) => { h.chartOpts.push(o); return Chart.renderChart(s, n, o); } },
    localStorage: { getItem() { return null; }, setItem() {} },
    history: {
      replaceState(state, title, url) {
        const u = new URL(url, win.location.href);
        win.location.href = u.href;
        win.location.search = u.search;
        h.history.push(u.search);
      },
    },
    addEventListener() {},
    setTimeout(fn, ms) {
      const id = h.nextTimer++;
      h.timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { h.timers.delete(id); },
    Image: class {
      set src(v) { this._src = v; setImmediate(() => this.onload && this.onload()); }
      get src() { return this._src; }
    },
    fetch(url, init) {
      h.calls.push({ url, cache: init && init.cache, at: Date.now() });
      const route = h.routes.get(url.split('?')[0]);
      const r = typeof route === 'function' ? route() : (route || { status: 404 });
      if (r === 'neterror') return Promise.reject(new TypeError('Failed to fetch'));
      if (r === 'hang') {
        return new Promise((resolve, reject) => {
          const signal = init && init.signal;
          if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
      }
      return Promise.resolve({ ok: r.status === 200, status: r.status, json: async () => clone(r.body) });
    },
  };
  h.win = win;
  h.el = (id) => doc.getElementById(id);
  h.serve = (base, name, body, status) => h.routes.set(base + name, () => ({ status: status || 200, body }));
  h.set = (base, name, handler) => h.routes.set(base + name, handler);
  /** Timers with a delay of ms (all when ms is omitted). */
  h.timersOf = (ms) => [...h.timers.entries()].filter(([, t]) => ms === undefined || t.ms === ms);
  /** Load timers: the poll and the retries. */
  h.loadTimers = () => [...h.timers.values()].filter((t) => [30000, 120000, 300000].includes(t.ms)).map((t) => t.ms);
  h.fire = (ms) => {
    const [id, t] = h.timersOf(ms)[0] || [];
    assert.ok(t, `no ${ms} ms timer (have ${[...h.timers.values()].map((x) => x.ms).join(',')})`);
    h.timers.delete(id);
    t.fn();
  };
  h.flush = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
  h.start = async () => {
    V.start(win);
    await h.flush();
  };
  h.setVisible = async (visible) => {
    doc.visibilityState = visible ? 'visible' : 'hidden';
    for (const fn of doc.listeners.visibilitychange || []) fn({ type: 'visibilitychange' });
    await h.flush();
  };
  h.status = () => h.el('status').textContent;
  h.urls = () => h.calls.map((c) => c.url.split('?')[0]);
  return h;
}

/** Run fn with Date.now() reading h.clock (restored afterwards). */
async function withClock(h, fn) {
  const real = Date.now;
  Date.now = () => h.clock;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
}

/** Serve index, session and notes for one date from base. */
function serveDay(h, base, idx, s, n) {
  h.serve(base, 'index.json', idx);
  h.serve(base, `sessions/${s.date}.json`, s);
  if (n) h.serve(base, `notes/${s.date}.json`, n);
}

// ---------------------------------------------------------------- tests

test('on github.io the index and sessions come from the data branch, notes from main, then the same origin on 404', async () => {
  const h = harness({ location: GHIO, now: at('17:00') });
  serveDay(h, SAME, makeIndex([{ date: DATE }]), finalSession(), makeNotes());
  await withClock(h, async () => {
    await h.start();
    assert.deepEqual(h.urls(), [
      `${RAW('parallel-data')}index.json`, `${RAW('main')}index.json`, `${SAME}index.json`,
      `${RAW('parallel-data')}sessions/${DATE}.json`, `${RAW('main')}sessions/${DATE}.json`, `${SAME}sessions/${DATE}.json`,
      `${RAW('main')}notes/${DATE}.json`, `${RAW('parallel-data')}notes/${DATE}.json`, `${SAME}notes/${DATE}.json`,
    ]);
    assert.ok(h.calls.every((c) => c.cache === 'no-store' && /\?t=\d+$/.test(c.url)), 'no-store and a minute bucket on every request');
    assert.equal(h.status(), '최종');
    assert.equal(h.el('headline').innerHTML, '한 줄 요약');
    assert.deepEqual(h.loadTimers(), [], 'a final session is not polled');
  });
});

test('raw.githubusercontent.com answers first when it has the files', async () => {
  const h = harness({ location: GHIO, now: at('17:00') });
  serveDay(h, RAW('parallel-data'), makeIndex([{ date: DATE }]), finalSession(), null);
  h.serve(RAW('main'), `notes/${DATE}.json`, makeNotes());
  await withClock(h, async () => {
    await h.start();
    assert.deepEqual(h.urls(), [`${RAW('parallel-data')}index.json`, `${RAW('parallel-data')}sessions/${DATE}.json`, `${RAW('main')}notes/${DATE}.json`]);
    assert.equal(h.el('title').textContent, '테스트 제목');
  });
});

test('a failed refresh keeps the last good session, says so and retries after 30 s, 2 min and 5 min', async () => {
  const h = harness({ now: at('11:03') });
  const live = makeSession(DATE, '08:00', '11:00');
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), live, makeNotes());
  await withClock(h, async () => {
    await h.start();
    assert.equal(h.status(), '실시간 · 11:01 갱신');
    assert.equal(h.el('status').getAttribute('data-state'), 'live');
    assert.deepEqual(h.loadTimers(), [300000]);
    const chart = h.el('chart').innerHTML;
    assert.ok(chart.length > 1000 && chart.startsWith('<svg'));
    h.set(SAME, `sessions/${DATE}.json`, () => ({ status: 503 }));
    h.fire(300000);
    await h.flush();
    assert.equal(h.status(), '수신 실패 · 마지막 정상 자료');
    assert.equal(h.el('status').title, '최근 확인 실패: 세션: HTTP 503');
    assert.equal(h.el('chart').innerHTML, chart, 'the chart stays');
    assert.equal(h.el('headline').innerHTML, '한 줄 요약');
    assert.deepEqual(h.loadTimers(), [30000]);
    h.fire(30000);
    await h.flush();
    assert.deepEqual(h.loadTimers(), [120000]);
    h.fire(120000);
    await h.flush();
    assert.deepEqual(h.loadTimers(), [300000]);
    h.serve(SAME, `sessions/${DATE}.json`, live);
    h.fire(300000);
    await h.flush();
    assert.equal(h.status(), '실시간 · 11:01 갱신');
    assert.deepEqual(h.loadTimers(), [300000], 'back to the normal poll');
  });
});

test('a notes failure is shown as a failure (not as no notes), retried even for a final session, and recovers', async () => {
  const h = harness({ now: at('17:00') });
  serveDay(h, SAME, makeIndex([{ date: DATE }]), finalSession(), null);
  h.set(SAME, `notes/${DATE}.json`, () => 'neterror');
  await withClock(h, async () => {
    await h.start();
    assert.equal(h.el('no-notes').hidden, false);
    assert.equal(h.el('no-notes').textContent, '분석 노트를 불러오지 못했습니다(네트워크 오류). 잠시 후 다시 시도합니다.');
    assert.equal(h.el('headline-sec').hidden, true);
    assert.equal(h.status(), '수신 실패 · 마지막 정상 자료');
    assert.deepEqual(h.loadTimers(), [30000], 'retried although the session is final');
    h.serve(SAME, `notes/${DATE}.json`, makeNotes());
    h.fire(30000);
    await h.flush();
    assert.equal(h.el('no-notes').hidden, true);
    assert.equal(h.el('headline-sec').hidden, false);
    assert.equal(h.el('title').textContent, '테스트 제목');
    assert.equal(h.status(), '최종');
    assert.deepEqual(h.loadTimers(), []);
  });
});

test('notes that fail validation are reported with the reason; absent notes (404) are just absent', async () => {
  const bad = makeNotes();
  bad.events[0].url = 'http://example.com/a';
  const h = harness({ now: at('17:00') });
  serveDay(h, SAME, makeIndex([{ date: DATE }]), finalSession(), bad);
  await withClock(h, async () => {
    await h.start();
    assert.match(h.el('no-notes').textContent, /^분석 노트를 불러오지 못했습니다\(notes\.events\[0\]\.url: .*https.*\)\. 잠시 후 다시 시도합니다\.$/);
    assert.deepEqual(h.loadTimers(), [30000]);
  });
  const h2 = harness({ now: at('17:00') });
  serveDay(h2, SAME, makeIndex([{ date: DATE, hasNotes: false }]), finalSession(), null);
  await withClock(h2, async () => {
    await h2.start();
    assert.equal(h2.el('no-notes').textContent, '이 날짜의 분석 노트가 없습니다.');
    assert.equal(h2.status(), '최종');
    assert.deepEqual(h2.loadTimers(), []);
  });
});

test('a failed notes request is retried even when the index says the date has no notes', async () => {
  const h = harness({ now: at('17:00') });
  serveDay(h, SAME, makeIndex([{ date: DATE, hasNotes: false }]), finalSession(), null);
  h.set(SAME, `notes/${DATE}.json`, () => 'neterror');
  const notesCalls = () => h.urls().filter((u) => u.includes('/notes/')).length;
  await withClock(h, async () => {
    await h.start();
    assert.equal(notesCalls(), 1);
    assert.match(h.el('no-notes').textContent, /^분석 노트를 불러오지 못했습니다/);
    h.fire(30000);
    await h.flush();
    assert.equal(notesCalls(), 2, 'asked again: only a 404 or a success counts as checked');
    h.set(SAME, `notes/${DATE}.json`, () => ({ status: 404 }));
    h.fire(120000);
    await h.flush();
    assert.equal(notesCalls(), 3);
    assert.equal(h.el('no-notes').textContent, '이 날짜의 분석 노트가 없습니다.');
    assert.deepEqual(h.loadTimers(), []);
  });
});

test('a notes failure on a refresh keeps the notes already shown', async () => {
  const h = harness({ now: at('11:03') });
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), makeSession(DATE, '08:00', '11:00'), makeNotes());
  await withClock(h, async () => {
    await h.start();
    h.set(SAME, `notes/${DATE}.json`, () => ({ status: 500 }));
    h.fire(300000);
    await h.flush();
    assert.equal(h.el('headline').innerHTML, '한 줄 요약');
    assert.equal(h.el('no-notes').hidden, true);
    assert.equal(h.status(), '수신 실패 · 마지막 정상 자료');
  });
});

test('polling: none for a final session or a hidden tab; a visible tab reloads after 30 s', async () => {
  const live = makeSession(DATE, '08:00', '11:00');
  const h = harness({ now: at('11:03') });
  h.doc.visibilityState = 'hidden';
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), live, makeNotes());
  await withClock(h, async () => {
    await h.start();
    assert.equal(h.status(), '실시간 · 11:01 갱신');
    assert.deepEqual(h.loadTimers(), [], 'nothing scheduled while hidden');
    const n = h.calls.length;
    h.clock += 20000;
    await h.setVisible(true);
    assert.equal(h.calls.length, n, 'no reload within 30 s of the last load');
    assert.deepEqual(h.loadTimers(), [300000]);
    await h.setVisible(false);
    assert.deepEqual(h.loadTimers(), []);
    h.clock += 30000;
    await h.setVisible(true);
    assert.ok(h.calls.length > n, 'reloaded on becoming visible');
    assert.deepEqual(h.loadTimers(), [300000]);
  });
  const h2 = harness({ now: at('17:00') });
  serveDay(h2, SAME, makeIndex([{ date: DATE }]), finalSession(), makeNotes());
  await withClock(h2, async () => {
    await h2.start();
    const n = h2.calls.length;
    await h2.setVisible(false);
    h2.clock += 60000;
    await h2.setVisible(true);
    assert.equal(h2.calls.length, n, 'a final session is not reloaded');
    assert.deepEqual(h2.loadTimers(), []);
  });
  // A final session whose last load failed is reloaded when the tab comes back (the retry timer stopped while hidden).
  const h3 = harness({ now: at('17:00') });
  serveDay(h3, SAME, makeIndex([{ date: DATE }]), finalSession(), null);
  h3.set(SAME, `notes/${DATE}.json`, () => 'neterror');
  await withClock(h3, async () => {
    await h3.start();
    assert.deepEqual(h3.loadTimers(), [30000]);
    await h3.setVisible(false);
    assert.deepEqual(h3.loadTimers(), []);
    h3.serve(SAME, `notes/${DATE}.json`, makeNotes());
    h3.clock += 60000;
    const n = h3.calls.length;
    await h3.setVisible(true);
    assert.ok(h3.calls.length > n, 'reloaded');
    assert.equal(h3.el('headline').innerHTML, '한 줄 요약');
    assert.deepEqual(h3.loadTimers(), []);
  });
});

test('a session that is not final but stopped updating says 갱신 지연 and is not polled after 24 hours', async () => {
  const s = makeSession(DATE, '08:00', '15:45');
  s.generatedAt = '2026-11-04T06:52:00Z'; // 15:52 KST
  const h = harness({ now: at('16:10') });
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), s, makeNotes());
  await withClock(h, async () => {
    await h.start();
    assert.equal(h.status(), '실시간 · 15:52 갱신');
    assert.deepEqual(h.loadTimers(), [300000]);
    h.clock = at('16:30');
    h.fire(300000);
    await h.flush();
    assert.equal(h.status(), '갱신 지연 · 11/4 15:52');
    assert.equal(h.el('status').getAttribute('data-state'), 'stale');
    assert.deepEqual(h.loadTimers(), [300000], 'still polled within 24 hours of the window end');
    h.clock = at('16:00') + 24 * 3600e3 + 60000;
    h.fire(300000);
    await h.flush();
    assert.equal(h.status(), '갱신 지연 · 11/4 15:52');
    assert.deepEqual(h.loadTimers(), [], 'polling stops');
    const n = h.calls.length;
    await h.setVisible(false);
    h.clock += 60000;
    await h.setVisible(true);
    assert.equal(h.calls.length, n);
  });
});

test('stale and failed series turn the pill into a warning with their count and names', async () => {
  const s = makeSession(DATE, '08:00', '11:00');
  const kospi = s.series.find((x) => x.id === 'kospi');
  kospi.status = 'stale';
  kospi.note = 'Yahoo 요청 제한(HTTP 429)';
  kospi.points = kospi.points.filter((p) => Date.parse(p[0]) <= at('09:45'));
  const hsi = s.series.find((x) => x.id === 'hsi');
  Object.assign(hsi, { status: 'error', note: 'Yahoo 요청 제한(HTTP 429)', points: [] });
  const h = harness({ now: at('11:03') });
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), s, makeNotes());
  await withClock(h, async () => {
    await h.start();
    assert.equal(h.status(), '실시간 · 11:01 갱신 · 일부 지연 2');
    assert.equal(h.el('status').getAttribute('data-state'), 'warn');
    assert.equal(h.el('status').title, '이전 자료 표시: 코스피(09:45까지) · 수집 실패: 항셍');
    assert.match(h.el('chart-caption').textContent, /최근 수집 실패로 이전 자료 표시: 코스피\(09:45까지\) · 수집 실패: 항셍/);
    // The automatic bullets leave the frozen series out.
    assert.doesNotMatch(h.el('obs').innerHTML.split('<li class="is-auto">').slice(1).join(''), /코스피|항셍/);
  });
});

test('a failed date switch puts the picker and the URL back, says why and can be retried', async () => {
  for (const search of ['', '?date=2026-11-04']) {
    const h = harness({ now: at('17:00'), search });
    serveDay(h, SAME, makeIndex([{ date: DATE }, { date: '2026-11-03', hasNotes: false }]), finalSession(), makeNotes());
    await withClock(h, async () => {
      await h.start();
      const select = h.el('date-select');
      assert.equal(select.value, DATE);
      select.value = '2026-11-03';
      select.dispatch('change');
      assert.equal(h.win.location.search, '?date=2026-11-03', 'the URL follows the choice while it loads');
      await h.flush();
      assert.equal(select.value, DATE, 'the picker shows the date still on screen');
      assert.equal(h.win.location.search, search, 'the URL is back');
      assert.equal(h.el('tool-note').textContent, '11/3(화) 자료를 불러오지 못했습니다: HTTP 404');
      assert.equal(h.status(), '최종', 'the shown session is fine');
      assert.equal(h.el('title').textContent, '테스트 제목');
      assert.deepEqual(h.loadTimers(), []);
      // Choosing it again is a change event again, so the reader can retry.
      h.serve(SAME, 'sessions/2026-11-03.json', finalSession('2026-11-03'));
      select.value = '2026-11-03';
      select.dispatch('change');
      await h.flush();
      assert.equal(select.value, '2026-11-03');
      assert.equal(h.win.location.search, '?date=2026-11-03');
      assert.equal(h.el('no-notes').textContent, '이 날짜의 분석 노트가 없습니다.');
    });
  }
});

test('a refresh with the same content rewrites nothing, so keyboard focus stays; changed content keeps its place', async () => {
  const notes = makeNotes();
  const h = harness({ now: at('11:03') });
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), makeSession(DATE, '08:00', '11:00'), notes);
  await withClock(h, async () => {
    await h.start();
    const ids = ['headline', 'obs', 'table', 'sections', 'watch', 'story', 'verdict', 'events', 'foot', 'pending'];
    const writes = () => ids.map((id) => h.el(id).writes);
    const before = writes();
    const link = h.el('story').focusables[1];
    assert.ok(link, 'a story source link');
    link.focus();
    h.fire(300000);
    await h.flush();
    assert.deepEqual(writes(), before, 'no container was rewritten');
    assert.equal(h.doc.activeElement, link, 'focus stays on the link');
    // New story text: the story is rewritten and focus moves to the link at the same place.
    h.serve(SAME, `notes/${DATE}.json`, makeNotes(DATE, { story: [Object.assign(clone(notes.story[0]), { text: '고친 이야기' })] }));
    h.fire(300000);
    await h.flush();
    assert.equal(h.el('story').writes, before[ids.indexOf('story')] + 1);
    assert.notEqual(h.doc.activeElement, link);
    assert.equal(h.doc.activeElement, h.el('story').focusables[1], 'the second link of the new story');
  });
});

test('a hanging raw host costs 5 s once, then goes last for 10 minutes; the last base waits 15 s', async () => {
  const h = harness({ location: GHIO, now: at('11:03') });
  for (const b of [RAW('parallel-data'), RAW('main')]) {
    for (const f of ['index.json', `sessions/${DATE}.json`, `notes/${DATE}.json`]) h.set(b, f, () => 'hang');
  }
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), makeSession(DATE, '08:00', '11:00'), makeNotes());
  await withClock(h, async () => {
    V.start(h.win);
    await h.flush();
    assert.deepEqual(h.timersOf(5000).length, 1, 'the first base has 5 s');
    assert.equal(h.timersOf(15000).length, 0);
    h.fire(5000);
    await h.flush();
    assert.equal(h.status(), '실시간 · 11:01 갱신');
    assert.deepEqual(h.urls(), [`${RAW('parallel-data')}index.json`, `${SAME}index.json`, `${SAME}sessions/${DATE}.json`, `${SAME}notes/${DATE}.json`],
      'after one timeout the same-origin copy goes first for every file');
    // 5 minutes later the raw host is still tried last.
    h.calls.length = 0;
    h.clock += 5 * 60000;
    h.fire(300000);
    await h.flush();
    assert.deepEqual(h.urls(), [`${SAME}index.json`, `${SAME}sessions/${DATE}.json`, `${SAME}notes/${DATE}.json`]);
    // After 10 minutes it is first again.
    h.calls.length = 0;
    h.clock += 5 * 60000 + 1000;
    h.fire(300000);
    await h.flush();
    assert.equal(h.urls()[0], `${RAW('parallel-data')}index.json`);
    h.fire(5000);
    await h.flush();
  });
  // Every base hangs: 5 s, 5 s, then 15 s for the last one.
  const h2 = harness({ location: GHIO, now: at('11:03') });
  for (const b of [RAW('parallel-data'), RAW('main'), SAME]) h2.set(b, 'index.json', () => 'hang');
  await withClock(h2, async () => {
    V.start(h2.win);
    await h2.flush();
    const waits = [];
    for (let i = 0; i < 3; i++) {
      const [, t] = h2.timersOf().find(([, x]) => x.ms === 5000 || x.ms === 15000);
      waits.push(t.ms);
      h2.fire(t.ms);
      await h2.flush();
    }
    assert.deepEqual(waits, [5000, 5000, 15000]);
    assert.equal(h2.status(), '수신 실패');
    assert.equal(h2.el('status').title, '최근 확인 실패: 목록: 응답 시간 초과');
  });
});

test('notes missing on the reachable copy count as absent only when the other host was already down', async () => {
  // The raw host was down before (index timed out): same-origin 404 + raw failing again = no notes.
  const h = harness({ location: GHIO, now: at('17:00') });
  h.set(RAW('parallel-data'), 'index.json', () => 'neterror');
  for (const f of [`sessions/${DATE}.json`, `notes/${DATE}.json`]) {
    h.set(RAW('parallel-data'), f, () => 'neterror');
    h.set(RAW('main'), f, () => 'neterror');
  }
  serveDay(h, SAME, makeIndex([{ date: DATE }]), finalSession(), null);
  await withClock(h, async () => {
    await h.start();
    assert.equal(h.el('no-notes').textContent, '이 날짜의 분석 노트가 없습니다.');
    assert.equal(h.status(), '최종');
  });
  // The raw host answered the index and the session, then failed for the notes: that is a failure, not absence.
  const h2 = harness({ location: GHIO, now: at('17:00') });
  serveDay(h2, RAW('parallel-data'), makeIndex([{ date: DATE }]), finalSession(), null);
  h2.set(RAW('main'), `notes/${DATE}.json`, () => 'neterror');
  h2.set(RAW('parallel-data'), `notes/${DATE}.json`, () => 'neterror');
  await withClock(h2, async () => {
    await h2.start();
    assert.equal(h2.el('no-notes').textContent, '분석 노트를 불러오지 못했습니다(네트워크 오류). 잠시 후 다시 시도합니다.');
    assert.deepEqual(h2.loadTimers(), [30000]);
  });
});

test('mornings: the default view shows the newest final session while today has little data, with a link to today', async () => {
  const today = '2026-11-05';
  const morning = kst(today, '08:22');
  const thin = makeSession(today, '08:00', '08:15');
  thin.series = thin.series.filter((x) => x.panel === 'crypto' || x.id === 'nq');
  const run = async (entry, todaySession, search) => {
    const h = harness({ now: morning, search });
    h.serve(SAME, 'index.json', makeIndex([Object.assign({ date: today, final: false, hasNotes: false }, entry), { date: DATE }]));
    h.serve(SAME, `sessions/${today}.json`, todaySession);
    h.serve(SAME, `sessions/${DATE}.json`, finalSession());
    h.serve(SAME, `notes/${DATE}.json`, makeNotes());
    await withClock(h, () => h.start());
    return h;
  };
  // The index already says today is thin: today's file is not even requested.
  let h = await run({ seriesWithData: 6 }, thin);
  assert.deepEqual(h.urls(), [`${SAME}index.json`, `${SAME}sessions/${DATE}.json`, `${SAME}notes/${DATE}.json`]);
  assert.equal(h.status(), '최종');
  assert.equal(h.el('date-select').value, DATE);
  assert.equal(h.el('pending').hidden, false);
  assert.equal(h.el('pending').innerHTML, '오늘(11/5) 세션 수집 중 · <a href="?date=2026-11-05" data-date="2026-11-05">보기</a>');
  assert.equal(h.win.location.search, '', 'the URL keeps no date');
  // Following the link loads today in place.
  const a = new FakeEl(h, '', 'a');
  a.setAttribute('data-date', today);
  a.closest = (sel) => (sel === 'a[data-date]' ? a : null);
  await withClock(h, async () => {
    const ev = h.el('pending').dispatch('click', { target: a });
    assert.equal(ev.defaultPrevented, true);
    await h.flush();
  });
  assert.equal(h.el('date-select').value, today);
  assert.equal(h.el('pending').hidden, true);
  assert.equal(h.win.location.search, `?date=${today}`);
  assert.equal(h.status(), '실시간 · 08:16 갱신');
  // Enough series by the index, but under 30 minutes of data: today's file is read, then the final one shown.
  const short = makeSession(today, '08:00', '08:15');
  h = await run({ seriesWithData: 19 }, short);
  assert.deepEqual(h.urls().slice(0, 3), [`${SAME}index.json`, `${SAME}sessions/${today}.json`, `${SAME}sessions/${DATE}.json`]);
  assert.equal(h.el('date-select').value, DATE);
  assert.equal(h.el('pending').hidden, false);
  // Enough data: today is the default.
  h = await run({ seriesWithData: 19 }, makeSession(today, '08:00', '09:00'));
  assert.equal(h.el('date-select').value, today);
  assert.equal(h.el('pending').hidden, true);
  // A date in the URL is always shown as asked.
  h = await run({ seriesWithData: 6 }, thin, `?date=${today}`);
  assert.equal(h.el('date-select').value, today);
  assert.equal(h.el('pending').hidden, true);
});

test('the chart slider carries ARIA values that follow the arrow keys, and the live region reads the values', async () => {
  const h = harness({ now: at('17:00') });
  serveDay(h, SAME, makeIndex([{ date: DATE }]), finalSession(), makeNotes());
  await withClock(h, async () => {
    await h.start();
    const slider = h.el('chart-slider');
    const aria = () => ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].map((k) => slider.getAttribute(k));
    assert.equal(slider.hidden, false);
    assert.equal(slider.tabIndex, 0);
    assert.deepEqual(aria(), ['0', '480', '480', '16:00 KST']);
    slider.focus();
    const keys = [['ArrowLeft', '465', '15:45 KST'], ['ArrowDown', '450', '15:30 KST'], ['ArrowUp', '465', '15:45 KST'],
      ['ArrowRight', '480', '16:00 KST'], ['Home', '0', '08:00 KST'], ['End', '480', '16:00 KST']];
    for (const [key, now, text] of keys) {
      const ev = slider.dispatch('keydown', { key });
      assert.equal(ev.defaultPrevented, true, key);
      assert.deepEqual(aria().slice(2), [now, text], key);
    }
    h.fire(250);
    assert.match(h.el('chart-live').textContent, /^16:00 KST\. 주식지수: 코스피 /);
    assert.equal(slider.dispatch('keydown', { key: 'a' }).defaultPrevented, false);
  });
  // No session: the slider is not reachable.
  const h2 = harness({ now: at('17:00') });
  await withClock(h2, async () => {
    await h2.start();
    assert.equal(h2.el('chart-slider').hidden, true);
    assert.equal(h2.el('chart-slider').tabIndex, -1);
  });
});

test('the subtitle line explains the dashed lines; the 가격 toggle switches the timetable to values', async () => {
  const h = harness({ now: at('11:03') });
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), makeSession(DATE, '08:00', '11:00'), makeNotes());
  await withClock(h, async () => {
    await h.start();
    assert.equal(h.el('subtitle').hidden, false);
    assert.equal(h.el('subtitle').textContent, '세로 점선 = 호출 시각');
    assert.equal(h.el('table-basis').textContent, '주식지수 (전일 종가 대비 %) · 11:00까지');
    assert.doesNotMatch(h.el('table').innerHTML, />12:00</, 'no rows for hours not reached yet');
    const [pct, price] = h.el('unit-seg').children;
    h.el('unit-seg').dispatch('click', { target: price });
    assert.equal(h.el('table-basis').textContent, '주식지수 값(지수 포인트) · 11:00까지');
    assert.equal(price.getAttribute('aria-pressed'), 'true');
    assert.equal(pct.getAttribute('aria-pressed'), 'false');
    assert.match(h.el('table').innerHTML, /<td title="[+−]?\d+\.\d%">\d,\d{3}/);
  });
});

test('PNG export passes the page caption as the footer and names a live export with its collection time', async () => {
  const h = harness({ now: at('11:03') });
  const live = makeSession(DATE, '08:00', '11:00');
  const notes = makeNotes();
  serveDay(h, SAME, makeIndex([{ date: DATE, final: false }]), live, notes);
  await withClock(h, async () => {
    await h.start();
    h.chartOpts.length = 0;
    h.el('png-light').dispatch('click');
    await h.flush();
    const o = h.chartOpts.find((x) => x.header === true);
    assert.ok(o, 'header render');
    assert.equal(o.footer, V.pngFooter(live, notes));
    assert.match(o.footer, /^Claude · 지수·종목은 .* · 자료 생성 11:01 KST$/);
    assert.equal(o.width, 1400);
    assert.equal(o.now, at('11:03'));
    const a = h.clicks.find((x) => x.tagName === 'A');
    assert.equal(a.download, 'parallel-timeline-20261104-1101.png');
    assert.equal(h.el('tool-note').textContent, 'PNG를 저장했습니다: parallel-timeline-20261104-1101.png');
  });
});
