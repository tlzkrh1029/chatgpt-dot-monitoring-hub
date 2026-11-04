'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../parallel-core.js');
const V = require('../parallel-view.js');

const ROOT = path.join(__dirname, '..');
const DATE = '2026-11-04';
const EM_DASH = String.fromCharCode(0x2014);
const at = (hhmm) => Date.parse(C.kstToUtcIso(DATE, hhmm));
const clone = (v) => JSON.parse(JSON.stringify(v));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// Synthetic series: baseline 1000 so the value is 1000 * (1 + p / 100).
function series(id, pairs, extra) {
  const d = C.SERIES.find((s) => s.id === id);
  return Object.assign({
    id, panel: d.panel, label: d.label, basis: d.basis,
    baseline: { value: 1000, label: d.basis === 'prevClose' ? '11/3 종가' : '08:00 KST' },
    source: clone(d.sources[0]), status: 'ok', note: '', fetchedAt: '2026-11-04T07:20:00Z',
    points: pairs.map(([hhmm, p]) => [C.kstToUtcIso(DATE, hhmm), Number((1000 * (1 + p / 100)).toFixed(6)), p]),
  }, extra || {});
}

function session(overrides) {
  return Object.assign({
    schemaVersion: 3, kind: 'session', date: DATE, timezone: 'Asia/Seoul',
    window: C.sessionWindow(DATE), intervalMinutes: 15, generatedAt: '2026-11-04T07:25:00Z', final: true,
    series: [
      series('kospi', [['09:00', 2.4], ['10:00', 1.5], ['12:45', -3.9], ['15:30', 0.6]]),
      series('nikkei', [['09:00', -0.2], ['12:45', -4.5], ['15:30', -1.4]], { baseline: { value: 1000, label: '11/2 종가' } }),
      series('hsi', [], { status: 'missing', baseline: { value: null, label: '' }, note: '자료 없음(휴장 또는 개장 전)' }),
      series('btc', [['08:00', 0], ['12:15', -2.6], ['13:37', -1.0], ['16:00', 0.1]]),
      series('gold', [['08:00', 0], ['15:00', 1.72]]),
    ],
    providers: clone(C.PROVIDERS),
  }, overrides || {});
}

function notes(overrides) {
  return Object.assign({
    schemaVersion: 3, kind: 'notes', date: DATE,
    title: '테스트 **제목**', subtitle: '부제', asOf: '2026-11-04T06:00:00Z', author: 'Claude',
    headline: '한 줄 <b>요약</b> **굵게**',
    events: [
      { id: 'band', at: '2026-11-04T04:22:00Z', end: '2026-11-04T04:37:00Z', label: '상원 확정', sub: '트럼프 승복', kind: 'band',
        source: 'CBS·AP', url: 'https://example.com/band' },
      { id: 'ga', at: '2026-11-04T00:39:00Z', label: '오소프(GA)', sub: '수성', kind: 'call', source: 'CBS', url: 'https://example.com/ga',
        detail: '설명 <script>', alts: [{ source: 'DDHQ', at: '2026-11-04T00:18:00Z', url: 'https://example.com/ddhq' }, { source: '라벨만' }] },
      { id: 'night', at: '2026-11-04T09:00:00Z', label: '밤 사건', kind: 'other' },
    ],
    observations: ['관찰 **하나**'],
    sections: [{ id: 'asia', heading: '아시아 증시 세부', items: ['항목 <i>1</i>', '**굵게**'] }, { heading: '읽기', items: [] }],
    watch: ['15:30 마감'],
    story: [{ text: '아침 8시 <x>', sources: [{ label: '파이낸셜뉴스', url: 'https://www.fnnews.com/news/1' }, { label: 'Yahoo Finance 15분봉' }] }],
    verdict: '**판정** 문장',
    footnote: '미확인: 마감',
  }, overrides || {});
}

test('fixtures follow the data contract', () => {
  assert.doesNotThrow(() => C.validateSession(session()));
  assert.doesNotThrow(() => C.validateNotes(notes()));
});

test('dataBases reads raw.githubusercontent.com first on github.io and only the same origin elsewhere', () => {
  assert.deepEqual(V.dataBases({ hostname: 'tlzkrh1029.github.io', pathname: '/chatgpt-dot-monitoring-hub/parallel.html' }),
    ['https://raw.githubusercontent.com/tlzkrh1029/chatgpt-dot-monitoring-hub/main/data/parallel/', 'data/parallel/']);
  assert.deepEqual(V.dataBases({ hostname: 'Owner.GitHub.io', pathname: '/repo/' }),
    ['https://raw.githubusercontent.com/owner/repo/main/data/parallel/', 'data/parallel/']);
  // A user page lives in the <owner>.github.io repository.
  assert.deepEqual(V.dataBases({ hostname: 'owner.github.io', pathname: '/parallel.html' }),
    ['https://raw.githubusercontent.com/owner/owner.github.io/main/data/parallel/', 'data/parallel/']);
  for (const loc of [{ hostname: 'localhost', pathname: '/parallel.html' }, { hostname: '127.0.0.1', pathname: '/repo/parallel.html' },
    { hostname: 'notgithub.io', pathname: '/repo/parallel.html' }, { hostname: 'github.io.evil.example', pathname: '/repo/' },
    { hostname: 'github.io', pathname: '/repo/' }, { hostname: 'a.b.github.io', pathname: '/repo/' },
    { hostname: 'owner.github.io', pathname: '/bad%2Fname/parallel.html' }, undefined]) {
    assert.deepEqual(V.dataBases(loc), ['data/parallel/'], JSON.stringify(loc));
  }
});

test('requests carry a one-minute cache bucket and ?date is validated', () => {
  const now = Date.parse('2026-11-04T11:36:59Z');
  const bucket = Math.floor(now / 60000);
  assert.equal(V.withMinute('data/parallel/index.json', now), `data/parallel/index.json?t=${bucket}`);
  assert.equal(V.withMinute('x.json?a=1', now), `x.json?a=1&t=${bucket}`);
  assert.equal(V.dateParam('?date=2026-11-04'), '2026-11-04');
  assert.equal(V.dateParam('?x=1&date=2026-11-03'), '2026-11-03');
  for (const bad of ['?date=2026-02-30', '?date=<script>', '?date=20261104', '', null]) assert.equal(V.dateParam(bad), null);
});

test('the status pill says 최종, 실시간 with the KST generation time, or 수신 실패', () => {
  const s = session();
  assert.deepEqual(V.statusInfo({ session: s }), { state: 'final', text: '최종' });
  assert.deepEqual(V.statusInfo({ session: session({ final: false, generatedAt: '2026-11-04T03:52:10Z' }) }),
    { state: 'live', text: '실시간 · 12:52 갱신' });
  assert.deepEqual(V.statusInfo({ session: s, error: '세션: HTTP 500' }), { state: 'error', text: '수신 실패 · 마지막 정상 자료' });
  assert.equal(V.statusText({ error: '목록: HTTP 404' }), '수신 실패');
  assert.equal(V.statusText({}), '불러오는 중');
});

test('header texts and date options follow the spec format', () => {
  assert.equal(V.metaText(session(), null), '2026년 11월 4일(수) · 08:00–16:00 KST · 15분봉');
  assert.equal(V.metaText(session(), notes({ display: { start: '09:00', end: '15:00' } })), '2026년 11월 4일(수) · 09:00–15:00 KST · 15분봉');
  assert.equal(V.titleText(null), '시장 병렬 타임라인');
  assert.equal(V.titleText(notes()), '테스트 제목');
  assert.equal(V.shortDate('2026-11-08'), '11/8(일)');
  const index = { schemaVersion: 3, kind: 'index', updatedAt: '2026-11-05T01:00:00Z', sessions: [
    { date: '2026-11-05', title: null, final: false }, { date: '2026-11-04', title: '미국 <중간선거>', final: true }] };
  const html = V.dateOptionsHtml(index, '2026-11-04');
  assert.equal(html, '<option value="2026-11-05">11/5(목) · 분석 노트 없음</option>'
    + '<option value="2026-11-04" selected>11/4(수) · 미국 &lt;중간선거&gt;</option>');
  assert.match(V.dateOptionsHtml(index, '2026-11-03'), /^<option value="2026-11-03" selected>11\/3\(화\) · 목록에 없는 날짜<\/option>/);
  assert.equal(V.dateOptionsHtml(null, '2026-11-03'), '<option value="2026-11-03" selected>11/3(화)</option>');
  // Notes loaded for the selected date win over an index entry that has not caught up yet.
  assert.ok(V.dateOptionsHtml(index, '2026-11-05', '새 **노트**').startsWith('<option value="2026-11-05" selected>11/5(목) · 새 노트</option>'));
  assert.ok(V.dateOptionsHtml(index, '2026-11-04', '').includes('11/4(수) · 미국 &lt;중간선거&gt;'));
  assert.equal(V.dateOptionsHtml(null, null), '');
  assert.equal(V.pngFileName(DATE, 'light'), 'parallel-timeline-20261104.png');
  assert.equal(V.pngFileName(DATE, 'dark'), 'parallel-timeline-20261104-dark.png');
});

test('timetable shows hour rows, an emphasized low row with its time, and prices in title attributes', () => {
  const s = session();
  const html = V.timetableHtml(s, 'indices', C.displayWindow(s, null));
  assert.match(html, /^<table class="tt"><caption class="sr-only">주식지수 \(전일 종가 대비 %\) 시간표<\/caption>/);
  assert.ok(html.includes('<th scope="col" title="기준: 11/3 종가 1,000"><span class="sw c0" aria-hidden="true"></span>코스피</th>'));
  assert.ok(html.includes('<th scope="col" title="기준: 11/2 종가 1,000"><span class="sw c1" aria-hidden="true"></span>니케이225</th>'));
  assert.ok(html.includes('<th scope="col"><span class="sw c2" aria-hidden="true"></span>항셍</th>'));
  // 9 hour rows (08:00..16:00), then the low and the last row.
  assert.equal((html.match(/<tr>/g) || []).length, 1 + 9);
  assert.ok(html.includes(`<tr><th scope="row" class="t-row">09:00</th><td title="${C.formatValue(1024)}">+2.4%</td>`));
  assert.ok(html.includes(`<tr class="row-min"><th scope="row" class="t-row">최저</th><td title="12:45 KST · ${C.formatValue(961)}"><strong>−3.9%</strong><span class="at">12:45</span></td>`));
  assert.ok(html.includes('<tr class="row-last"><th scope="row" class="t-row">마지막</th><td title="15:30 KST · 1,006">+0.6%<span class="at">15:30</span></td>'));
  assert.ok(html.includes('<td class="na"><span aria-hidden="true">·</span><span class="sr-only">자료 없음</span></td>'));
  // The dollar and gold panel shows two decimals.
  assert.ok(V.timetableHtml(s, 'fx').includes('<strong>0.00%</strong>'));
  assert.ok(V.timetableHtml(s, 'fx').includes('+1.72%'));
  assert.equal(V.timetableHtml(s, 'ai'), '<p class="empty">이 패널에 표시할 계열이 없습니다.</p>');
  assert.equal(V.timetableHtml(null, 'indices'), '');
});

test('notes sections escape HTML, keep **bold** and link only https URLs', () => {
  const n = notes();
  assert.equal(V.headlineHtml(n), '한 줄 &lt;b&gt;요약&lt;/b&gt; <strong>굵게</strong>');
  assert.equal(V.verdictHtml(n), '<strong>판정</strong> 문장');
  assert.equal(V.watchHtml(n), '<li>15:30 마감</li>');
  assert.equal(V.sectionsHtml(n), '<article class="card note-card" id="note-asia"><h3>아시아 증시 세부</h3>'
    + '<ul><li>항목 &lt;i&gt;1&lt;/i&gt;</li><li><strong>굵게</strong></li></ul></article>'
    + '<article class="card note-card"><h3>읽기</h3></article>');
  assert.equal(V.storyHtml(n), '<div class="para"><p>아침 8시 &lt;x&gt;</p><p class="src">출처: '
    + '<a href="https://www.fnnews.com/news/1" target="_blank" rel="noopener noreferrer">파이낸셜뉴스</a> · Yahoo Finance 15분봉</p></div>');
  const unsafe = V.storyHtml(notes({ story: [{ text: 't', sources: [{ label: 'a', url: 'javascript:alert(1)' },
    { label: 'b', url: 'http://plain.example/' }, { label: 'c', url: 'https://x.example/"onmouseover="1' }] }] }));
  assert.doesNotMatch(unsafe, /href/);
  assert.match(unsafe, /출처: a · b · c/);
  const sectionId = V.sectionsHtml(notes({ sections: [{ id: 'x" onclick="1', heading: 'h', items: ['i'] }] }));
  assert.doesNotMatch(sectionId, /onclick|id=/);
  for (const fn of [V.headlineHtml, V.verdictHtml, V.watchHtml, V.sectionsHtml, V.storyHtml]) assert.equal(fn(null), '');
});

test('observations list the analyst items first, then automatic bullets tagged 자동', () => {
  assert.equal(V.insightsHtml(notes(), [{ kind: 'bottom', text: '바닥 시각: 3/4개 <계열>' }]),
    '<li>관찰 <strong>하나</strong></li><li class="is-auto"><span class="tag">자동</span>바닥 시각: 3/4개 &lt;계열&gt;</li>');
  assert.equal(V.insightsHtml(null, []), '');
  const s = session();
  const auto = C.insights(s, null, C.displayWindow(s, null));
  assert.ok(auto.length > 0);
  assert.equal((V.insightsHtml(null, auto).match(/<span class="tag">자동<\/span>/g) || []).length, auto.length);
});

test('the event list shows KST times, band ranges, chart numbers, kinds and alternative times', () => {
  const n = notes();
  const html = V.eventsHtml(n, C.displayWindow(session(), n));
  const items = html.split('<li>').slice(1);
  assert.equal(items.length, 3);
  assert.ok(items[0].startsWith('<time datetime="2026-11-04T00:39:00Z">09:39</time>'));
  assert.ok(items[0].includes('<p class="ev-head"><span class="ev-num" title="차트 표시 번호">①</span><strong>오소프(GA)</strong>'
    + '<span class="ev-sub">수성</span><span class="badge">호출</span></p>'));
  assert.ok(items[0].includes('<p class="ev-detail">설명 &lt;script&gt;</p>'));
  assert.ok(items[0].includes('<p class="ev-src"><a href="https://example.com/ga" target="_blank" rel="noopener noreferrer">CBS</a>'
    + ' · 다른 시각: <a href="https://example.com/ddhq" target="_blank" rel="noopener noreferrer">DDHQ 09:18</a> · 라벨만</p>'));
  assert.ok(items[1].startsWith('<time datetime="2026-11-04T04:22:00Z">13:22–13:37</time>'));
  assert.ok(items[1].includes('>②</span><strong>상원 확정</strong><span class="ev-sub">트럼프 승복</span><span class="badge">구간</span>'));
  // Outside the displayed window: listed, but without a chart number.
  assert.ok(items[2].startsWith('<time datetime="2026-11-04T09:00:00Z">18:00</time>'));
  assert.doesNotMatch(items[2], /ev-num/);
  assert.equal(V.eventsHtml(null, null), '');
});

test('the caption states the basis, baseline exceptions, sources and the generation time', () => {
  assert.equal(V.captionText(session()), '지수·종목은 전일 종가 대비, 선물·크립토·환율·금은 08:00 KST 대비'
    + ' · 11/2 종가 기준: 니케이225 · 출처: Yahoo Finance, Coin Metrics Community (CC BY-NC 4.0) · 자료 생성 16:25 KST');
  const s = session();
  s.series[0].status = 'stale';
  s.series[3].source = { provider: 'yahoo', symbol: 'BTC-USD' };
  s.series.push(series('xmr', [['08:15', 0]], { baseline: { value: 1000, label: '첫 관측 08:15 KST' } }));
  s.series[s.series.length - 1].source = { provider: 'yahoo', symbol: 'XMR-USD' };
  s.generatedAt = '2026-11-05T00:10:00Z';
  const text = V.captionText(s);
  assert.match(text, / · 첫 관측 08:15 KST 기준: XMR · /);
  assert.match(text, /출처: Yahoo Finance · /);
  assert.match(text, /최근 수집 실패로 이전 자료 표시: 코스피/);
  assert.match(text, /자료 생성 11\/5 09:10 KST$/);
});

test('the footer lists providers with the license link, the notes author and time, the footnote and the cadence', () => {
  const html = V.footerHtml(session(), notes());
  assert.ok(html.includes('<a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noopener noreferrer">CC BY-NC 4.0</a>'));
  assert.ok(html.includes('<a href="https://finance.yahoo.com/" target="_blank" rel="noopener noreferrer">Yahoo Finance</a>'));
  assert.ok(html.includes('<p>분석 노트: 작성 Claude · 15:00 KST 기준</p>'));
  assert.ok(html.includes('<p>미확인: 마감</p>'));
  assert.ok(html.includes('GitHub Actions에서 약 15분마다'));
  assert.ok(html.includes('<summary>계열별 기준과 상태</summary>'));
  assert.ok(html.includes('<tr><th scope="row">항셍</th><td></td><td>자료 없음 · 자료 없음(휴장 또는 개장 전)</td>'));
  assert.ok(html.includes('<th scope="row">니케이225</th><td>11/2 종가 <span class="mono">1,000</span></td><td>정상</td><td>Yahoo <span class="mono">^N225</span></td>'));
  assert.doesNotMatch(V.footerHtml(session(), null), /분석 노트/);
  assert.doesNotMatch(V.footerHtml(null, null), /<details/);
});

test('pointer x maps to grid times inside the window and back', () => {
  const s = session();
  const win = C.displayWindow(s, null);
  const layout = { width: 1200, height: 900, left: 64, right: 1030, start: win.start, end: win.end, panels: [] };
  assert.equal(V.timeToX(layout, win.start), 64);
  assert.equal(V.timeToX(layout, win.end), 1030);
  assert.equal(V.xToTime(layout, -50), win.start);
  assert.equal(V.xToTime(layout, 5000), win.end);
  assert.equal(V.snapTime(s, win, V.xToTime(layout, V.timeToX(layout, at('12:07')))), at('12:00'));
  assert.equal(V.snapTime(s, win, at('12:08')), at('12:15'));
  assert.equal(V.snapTime(s, win, at('07:10')), at('08:00'));
  assert.equal(V.snapTime(s, win, at('17:00')), at('16:00'));
  // A narrower display window clips the snapped time.
  assert.equal(V.snapTime(s, { start: at('09:00'), end: at('15:00') }, at('15:40')), at('15:00'));
  // `right` as the plot's right edge (the chart's convention) or as a margin gives the same bounds.
  assert.deepEqual(V.plotBounds({ width: 1200, left: 64, right: 1030 }), { x0: 64, x1: 1030 });
  assert.deepEqual(V.plotBounds({ width: 1200, left: 64, right: 170 }), { x0: 64, x1: 1030 });
  assert.equal(V.latestTime(s, win), at('16:00'));
  const live = session({ final: false });
  live.series = live.series.map((x) => Object.assign(x, { points: x.points.filter((p) => Date.parse(p[0]) <= at('13:40')) }));
  assert.equal(V.latestTime(live, win), at('13:30'));
});

test('crosshair dots sit on the series values using the panel y range', () => {
  const s = session();
  const win = C.displayWindow(s, null);
  const layout = { width: 1200, left: 64, right: 1030, start: win.start, end: win.end, panels: [
    { key: 'indices', top: 100, bottom: 300, yMin: -5, yMax: 3, empty: false,
      series: [{ id: 'kospi', color: '#111111' }, { id: 'nikkei', color: '#222222' }, { id: 'hsi', color: '#333333' }] },
    { key: 'ai', top: 400, bottom: 490, yMin: null, yMax: null, empty: true, series: [] }] };
  const m = V.cursorMarks(layout, s, at('12:45'));
  assert.equal(m.x, V.timeToX(layout, at('12:45')));
  assert.deepEqual(m.lines, [{ y1: 100, y2: 300 }, { y1: 400, y2: 490 }]);
  assert.equal(m.dots.length, 2);
  assert.deepEqual(m.dots[0], { cx: m.x, cy: 300 - ((-3.9 + 5) / 8) * 200, color: '#111111' });
});

test('the tooltip lists every series at the time, with the point time when it is earlier', () => {
  const s = session();
  const html = V.tooltipHtml(s, at('13:45'));
  assert.ok(html.startsWith('<p class="tip-time"><strong>13:45</strong> KST</p><div class="tip-grid">'));
  assert.ok(html.includes('<span class="lbl">BTC <span class="at">13:37</span></span><span class="pct">−1.0%</span><span class="val">990.00</span>'));
  assert.ok(html.includes('<li class="na"><span class="sw c0" aria-hidden="true"></span><span class="lbl">코스피</span><span class="pct">–</span>'));
  for (const x of s.series) assert.ok(html.includes(`<span class="lbl">${x.label}`), x.label);
  assert.equal(V.readoutText(s, at('15:00')),
    '15:00 KST. 주식지수: 코스피 자료 없음, 니케이225 자료 없음, 항셍 자료 없음. 크립토: BTC 자료 없음. 달러·금: 금 선물 +1.72%.');
});

test('colors follow the chart order: catalog order within each panel, not file order', () => {
  const s = session();
  s.series.reverse();
  const slots = V.colorSlots(s);
  assert.deepEqual([slots.get('kospi'), slots.get('nikkei'), slots.get('hsi'), slots.get('btc'), slots.get('gold')], [0, 1, 2, 0, 0]);
  assert.deepEqual(V.panelSeries(s, 'indices').map((x) => x.id), ['kospi', 'nikkei', 'hsi']);
});

test('the stylesheet swatch colors match the core palette in both themes', () => {
  const css = read('parallel.css');
  const block = (selector) => {
    const i = css.indexOf(`${selector} {`);
    assert.ok(i >= 0, selector);
    return css.slice(i, css.indexOf('}', i));
  };
  const dark = block(':root');
  const light = block(':root[data-theme="light"]');
  C.COLORS.dark.forEach((c, i) => assert.ok(dark.includes(`--s${i}: ${c};`), `dark --s${i}`));
  C.COLORS.light.forEach((c, i) => assert.ok(light.includes(`--s${i}: ${c};`), `light --s${i}`));
  for (const token of ['--bg: #0D1117', '--panel: #151B23', '--line: #262E3A', '--text: #E6EAF0', '--muted: #A9B2C0', '--link: #9CC2FF']) {
    assert.ok(dark.includes(token), token);
  }
  // Tabs copied from index.html.
  assert.ok(css.includes('.page-tabs a { padding:7px 16px; min-height:44px; text-decoration:none; border-radius:6px; border:1px solid transparent; }'));
});

test('parallel.html wires the hub tabs, landmarks, every id the view needs and the scripts in order', () => {
  const html = read('parallel.html');
  assert.ok(html.includes('<nav class="page-tabs" aria-label="상황판 화면"><a href="./">기존 상황판</a>'
    + '<a href="parallel.html" aria-current="page">병렬 타임라인</a><a href="election-results.html">선거 결과</a></nav>'));
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"( defer)?><\/script>/g)].map((m) => [m[1], !!m[2]]),
    [['parallel-core.js', true], ['parallel-chart.js', true], ['parallel-view.js', true]]);
  assert.match(html, /<html lang="ko" data-theme="dark">/);
  for (const tag of ['<header class="top">', '<main class="main" id="main"', '<footer class="foot" id="foot">', '<h1 id="title">']) {
    assert.ok(html.includes(tag), tag);
  }
  assert.match(html, /id="status" role="status" aria-live="polite"/);
  const ids = [...read('parallel-view.js').matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 20);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), id);
  assert.doesNotMatch(html, /fonts\.googleapis|<script src="https?:|<link[^>]+href="https?:/);
  // Headings descend one level at a time.
  const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
  assert.equal(levels[0], 1);
  levels.reduce((prev, cur) => { assert.ok(cur <= prev + 1, `h${prev} -> h${cur}`); return cur; });
});

test('no em dash in the page, stylesheet, view or generated text', () => {
  for (const file of ['parallel.html', 'parallel.css', 'parallel-view.js', 'tests/parallel-view.test.js']) {
    assert.ok(!read(file).includes(EM_DASH), file);
  }
  const s = session();
  const n = notes();
  const w = C.displayWindow(s, n);
  const out = [V.metaText(s, n), V.captionText(s), V.footerHtml(s, n), V.eventsHtml(n, w), V.tooltipHtml(s, at('12:45')),
    V.readoutText(s, at('12:45')), V.timetableHtml(s, 'indices', w), V.statusText({ session: s, error: 'x' }), V.dateOptionsHtml(null, DATE)].join('');
  assert.ok(!out.includes(EM_DASH));
});

test('the svg size comes from the layout or the root attributes', () => {
  assert.deepEqual(V.svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1650.5"></svg>', null), { width: 1400, height: 1650.5 });
  assert.deepEqual(V.svgSize('<svg/>', { width: 10, height: 20 }), { width: 10, height: 20 });
});

const NOTES_FILE = path.join(ROOT, 'data', 'parallel', 'notes', '2026-11-04.json');
test('the published 11/4 notes render with escaped text and https links only', { skip: !fs.existsSync(NOTES_FILE) }, () => {
  const n = C.validateNotes(JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')));
  const s = session({ date: n.date, window: C.sessionWindow(n.date) });
  const w = C.displayWindow(s, n);
  const html = [V.headlineHtml(n), V.insightsHtml(n, []), V.sectionsHtml(n), V.watchHtml(n), V.storyHtml(n), V.verdictHtml(n),
    V.eventsHtml(n, w), V.footerHtml(s, n)].join('');
  assert.doesNotMatch(html, /\*\*/);
  assert.doesNotMatch(html, /<script/i);
  for (const m of html.matchAll(/href="([^"]+)"/g)) assert.match(m[1], /^https:\/\//);
  assert.equal((V.eventsHtml(n, w).match(/<li>/g) || []).length, C.eventsInWindow(n, null).length);
});

const CHART_FILE = path.join(ROOT, 'parallel-chart.js');
test('the chart layout contract matches what the crosshair expects', { skip: !fs.existsSync(CHART_FILE) }, () => {
  const Chart = require(CHART_FILE);
  const s = session();
  const n = notes();
  for (const width of [390, 1200]) {
    const out = Chart.renderChart(s, n, { width, theme: 'dark' });
    const L = out.layout;
    const win = C.displayWindow(s, n);
    assert.equal(L.width, width);
    assert.equal(L.start, win.start);
    assert.equal(L.end, win.end);
    assert.equal(L.panels.length, C.PANELS.length);
    const b = V.plotBounds(L);
    assert.ok(b.x0 > 0 && b.x1 <= width && b.x1 > b.x0 + width / 3, JSON.stringify(b));
    for (const p of L.panels) assert.ok(p.bottom > p.top);
    const m = V.cursorMarks(L, s, at('12:45'));
    assert.equal(m.lines.length, C.PANELS.length);
    assert.ok(m.dots.length >= 2);
  }
});
