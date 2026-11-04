'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../parallel-core.js');
const Chart = require('../parallel-chart.js');

const DATE = '2026-11-04';
const MIN = 60000;
const iso = (hhmm) => C.kstToUtcIso(DATE, hhmm);
const at = (hhmm) => Date.parse(iso(hhmm));
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------- fixtures

// Piecewise-linear pct path sampled every 15 minutes from the first to the last anchor.
function path(anchors) {
  const knots = anchors.map(([hhmm, p]) => [at(hhmm), p]);
  const out = [];
  for (let t = knots[0][0], k = 0; t <= knots[knots.length - 1][0]; t += 15 * MIN) {
    while (k < knots.length - 2 && t > knots[k + 1][0]) k += 1;
    const [t0, p0] = knots[k];
    const [t1, p1] = knots[Math.min(k + 1, knots.length - 1)];
    const p = t1 === t0 ? p1 : p0 + ((p1 - p0) * (t - t0)) / (t1 - t0);
    out.push([t, Math.round(p * 1000) / 1000]);
  }
  return out;
}

function series(id, anchors, opts) {
  const d = C.SERIES.find((s) => s.id === id);
  const base = 1000;
  const o = opts || {};
  let pts = anchors.length ? path(anchors) : [];
  if (o.skip) pts = pts.filter(([t]) => !o.skip.some(([a, b]) => t > at(a) && t < at(b)));
  const s = {
    id, panel: d.panel, label: o.label || d.label, basis: d.basis,
    baseline: { value: base, label: d.basis === 'prevClose' ? '11/3 종가' : '08:00 KST' },
    source: clone(d.sources[0]), status: pts.length ? 'ok' : 'missing', note: '', fetchedAt: '2026-11-04T07:20:00Z',
    points: pts.map(([t, p]) => [C.isoUtc(t), Number((base * (1 + p / 100)).toFixed(6)), p]),
  };
  if (!pts.length) s.baseline.value = null;
  return s;
}

function syntheticSession() {
  return C.validateSession({
    schemaVersion: 3, kind: 'session', date: DATE, timezone: 'Asia/Seoul',
    window: C.sessionWindow(DATE), intervalMinutes: 15, generatedAt: '2026-11-04T07:25:00Z', final: true,
    series: [
      series('kospi', [['09:00', 1.0], ['12:45', -3.0], ['13:30', -1.0], ['15:30', 0.5]]),
      // Nikkei has a lunch break (11:30-12:30): a 60-minute gap drawn dashed.
      series('nikkei', [['09:00', -0.2], ['12:45', -4.4], ['15:30', -1.4]], { skip: [['11:30', '12:30']] }),
      series('hsi', [['10:30', 0.2], ['11:00', -0.2], ['15:30', 1.0], ['16:00', 1.1]]),
      series('skhynix', [['09:00', 2.0], ['12:45', -5.0], ['15:30', -1.0]]),
      series('samsung', [['09:00', 3.0], ['12:45', -4.8], ['15:30', -0.7]]),
      // BTC has a three-hour hole: no connector at all.
      series('btc', [['08:00', 0], ['12:45', -2.0], ['16:00', 0.1]], { skip: [['10:00', '13:00']] }),
      series('eth', [['08:00', 0], ['12:15', -2.6], ['16:00', 0.2]]),
      series('dxy', [['08:00', 0], ['11:00', -0.5], ['16:00', -0.4]]),
      series('gold', [['08:00', 0], ['14:30', 0.7], ['16:00', 2.4]]),
      series('usdkrw', []),
    ],
    providers: clone(C.PROVIDERS),
  });
}

function syntheticNotes() {
  return C.validateNotes({
    schemaVersion: 3, kind: 'notes', date: DATE,
    title: '테스트 세션', subtitle: '세로 점선 = 테스트 사건',
    display: { start: '08:00', end: '16:00' },
    events: [
      { id: 'ga', at: iso('09:39'), label: '오소프(GA)', sub: '수성', kind: 'call' },
      { id: 'nc', at: iso('10:30'), label: '쿠퍼(NC)', sub: '첫 플립', kind: 'call' },
      { id: 'senate', at: iso('13:22'), end: iso('13:37'), label: '상원 확정', sub: '트럼프 승복', kind: 'band' },
      { id: 'collins', at: iso('14:37'), label: '콜린스(ME)', kind: 'concession' },
    ],
  });
}

// ---------------------------------------------------------------- svg helpers

function attrsOf(s) {
  const out = {};
  for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Elements (any tag) carrying the class, with attributes, inner text and string index. */
function byClass(svg, cls) {
  const out = [];
  const re = /<([a-z]+)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(svg))) {
    const attrs = attrsOf(m[2]);
    if (!(attrs.class || '').split(' ').includes(cls)) continue;
    let text = '';
    if (!m[3]) {
      const close = `</${m[1]}>`;
      let depth = 1;
      let i = re.lastIndex;
      const inner = new RegExp(`<(/?)${m[1]}\\b[^>]*?(/?)>`, 'g');
      inner.lastIndex = i;
      let n;
      while (depth && (n = inner.exec(svg))) {
        if (n[1]) depth -= 1;
        else if (!n[2]) depth += 1;
        i = n.index;
      }
      text = unescapeXml(svg.slice(re.lastIndex, i).replace(/<[^>]*>/g, ''));
      assert.ok(svg.indexOf(close, re.lastIndex) >= 0);
    }
    out.push({ tag: m[1], attrs, text, index: m.index });
  }
  return out;
}

/** Slice of the SVG for each panel group, keyed by panel key. */
function panelSlices(svg) {
  const starts = [...svg.matchAll(/<g class="pc-panel" data-panel="([^"]+)">/g)];
  const out = {};
  starts.forEach((m, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].index : svg.length;
    out[m[1]] = svg.slice(m.index, end);
  });
  return out;
}

/** Minimal XML well-formedness check: balanced tags, quoted attributes, escaped text. */
function assertWellFormed(svg) {
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(svg))) {
    if (m[6]) assert.fail(`stray '<' at ${m.index}: ${svg.slice(m.index, m.index + 40)}`);
    if (m[5] !== undefined) {
      assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(m[5]), `raw '&' in text: ${m[5].slice(0, 60)}`);
      assert.ok(!m[5].includes('>'), `raw '>' in text: ${m[5].slice(0, 60)}`);
      continue;
    }
    for (const v of m[3].matchAll(/="([^"]*)"/g)) {
      assert.ok(!/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(v[1]), `raw '&' in attribute: ${v[1]}`);
    }
    if (m[1]) assert.equal(stack.pop(), m[2], `mismatched </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]);
  }
  assert.deepEqual(stack, [], 'unclosed elements');
}

const coords = (d) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
const xOf = (layout, t) => layout.left + ((t - layout.start) / (layout.end - layout.start)) * (layout.right - layout.left);
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 0.11 : eps);

// ---------------------------------------------------------------- tests

test('renders a self-contained SVG whose size matches the layout', () => {
  const { svg, layout } = Chart.renderChart(syntheticSession(), syntheticNotes(), { width: 1200 });
  assertWellFormed(svg);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /);
  const root = attrsOf(svg.slice(0, svg.indexOf('>')));
  assert.equal(root.width, String(layout.width));
  assert.equal(root.height, String(layout.height));
  assert.equal(root.viewBox, `0 0 ${layout.width} ${layout.height}`);
  assert.equal(root.role, 'img');
  assert.match(root['font-family'], /^'IBM Plex Sans KR','Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',system-ui,sans-serif$/);
  for (const id of root['aria-labelledby'].split(' ')) assert.match(svg, new RegExp(`<(title|desc) id="${id}">[^<]+</\\1>`));
  const bg = byClass(svg, 'pc-bg')[0];
  assert.deepEqual([bg.attrs.width, bg.attrs.height, bg.attrs.fill], [String(layout.width), String(layout.height), Chart.THEMES.light.bg]);
  assert.equal(layout.width, 1200);
  assert.equal(layout.compact, false);
});

test('is deterministic, reads no clock or randomness and leaves its inputs untouched', () => {
  const session = syntheticSession();
  const notes = syntheticNotes();
  const before = [clone(session), clone(notes)];
  const realNow = Date.now;
  const realRandom = Math.random;
  Date.now = () => { throw new Error('Date.now called'); };
  Math.random = () => { throw new Error('Math.random called'); };
  try {
    for (const opts of [{ width: 1200 }, { width: 1400, header: true }, { width: 390, theme: 'dark' }]) {
      const a = Chart.renderChart(session, notes, opts);
      const b = Chart.renderChart(clone(session), clone(notes), clone(opts));
      assert.equal(a.svg, b.svg);
      assert.deepEqual(a.layout, b.layout);
    }
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
  }
  assert.deepEqual([session, notes], before);
});

test('escapes every text it draws and drops characters XML cannot carry', () => {
  const session = syntheticSession();
  session.series[0].label = '<script>alert("x")</script> & \'q\'';
  session.series[3].label = 'A&B <i>';
  const notes = syntheticNotes();
  notes.title = '<b>제목</b> & "따옴표"\u0007';
  notes.subtitle = '**굵게** <u>밑줄</u>';
  notes.events[0].label = '<img src=x onerror=alert(1)>';
  notes.events[0].sub = '"quoted" & \'single\'';
  for (const opts of [{ width: 1200, header: true }, { width: 390, header: true }, { width: 1200, theme: 'dark' }]) {
    const { svg } = Chart.renderChart(session, notes, opts);
    assertWellFormed(svg);
    for (const raw of ['<script', '<img', '<b>', '<i>', '<u>', '\u0007']) assert.ok(!svg.includes(raw), `${raw} leaked`);
    assert.ok(svg.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;'));
    assert.ok(svg.includes('A&amp;B &lt;i&gt;'));
  }
  const { svg } = Chart.renderChart(session, notes, { width: 1200, header: true });
  assert.ok(byClass(svg, 'pc-title')[0].text.startsWith('<b>제목</b> & "따옴표" (11/4 08:00'));
  assert.equal(byClass(svg, 'pc-subtitle')[0].text, '굵게 <u>밑줄</u>');
  const label = byClass(svg, 'pc-event-label').find((g) => g.attrs['data-event'] === 'ga');
  assert.equal(label.text, '<img src=x onerror=alert(1)>"quoted" & \'single\'');
});

test('layout numbers are consistent: panels ordered, plot inside the width, window matches the notes', () => {
  const session = syntheticSession();
  const notes = syntheticNotes();
  for (const opts of [{ width: 1200 }, { width: 1400, header: true }, { width: 760, theme: 'dark' }, { width: 390 }, { width: 280 }]) {
    const { layout } = Chart.renderChart(session, notes, opts);
    assert.equal(layout.width, opts.width);
    assert.ok(layout.left > 0 && layout.left < layout.right && layout.right < layout.width, JSON.stringify(layout));
    assert.equal(layout.right, layout.width - (opts.width < 640 ? 16 : 170));
    assert.ok(layout.left >= (opts.width < 640 ? 34 : 64));
    const win = C.displayWindow(session, notes);
    assert.deepEqual([layout.start, layout.end], [win.start, win.end]);
    assert.deepEqual(layout.panels.map((p) => p.key), C.PANELS.map((p) => p.key));
    let previous = 0;
    for (const p of layout.panels) {
      assert.ok(p.top > previous && p.bottom > p.top, `${p.key} ${p.top}-${p.bottom}`);
      previous = p.bottom;
    }
    assert.ok(previous < layout.height);
    for (const k of ['width', 'height', 'left', 'right', 'start', 'end']) assert.equal(typeof layout[k], 'number');
  }
  const narrow = Chart.renderChart(session, notes, { width: 5 }).layout;
  assert.equal(narrow.width, 280);
  assert.equal(Chart.renderChart(session, notes, {}).layout.width, 1200);
});

test('series lines, gap connectors and end dots stay inside their own plot', () => {
  for (const opts of [{ width: 1200 }, { width: 390 }]) {
    const { svg, layout } = Chart.renderChart(syntheticSession(), syntheticNotes(), opts);
    const slices = panelSlices(svg);
    for (const p of layout.panels) {
      const part = slices[p.key];
      const xy = [];
      for (const el of [...byClass(part, 'pc-series'), ...byClass(part, 'pc-gap')]) xy.push(...coords(el.attrs.d));
      for (const el of [...byClass(part, 'pc-end'), ...byClass(part, 'pc-point')]) xy.push([Number(el.attrs.cx), Number(el.attrs.cy)]);
      if (!p.empty) assert.ok(xy.length > 0, p.key);
      for (const [x, y] of xy) {
        assert.ok(x >= layout.left - 0.1 && x <= layout.right + 0.1, `${p.key} x=${x}`);
        assert.ok(y >= p.top - 0.1 && y <= p.bottom + 0.1, `${p.key} y=${y} not in ${p.top}-${p.bottom}`);
      }
    }
  }
});

test('y ticks are nice steps that cover the data, with 0% and true minus signs', () => {
  const session = syntheticSession();
  const { svg, layout } = Chart.renderChart(session, null, { width: 1200 });
  const slices = panelSlices(svg);
  const parse = (s) => (s === '0%' ? 0 : Number(s.replace('−', '-').replace('%', '')));
  for (const p of layout.panels.filter((q) => !q.empty)) {
    const labels = byClass(slices[p.key], 'pc-ytick').map((el) => el.text);
    assert.ok(labels.includes('0%'), `${p.key}: ${labels}`);
    assert.ok(!labels.some((s) => s.includes('-')), 'ASCII hyphen used as minus');
    const values = labels.map(parse);
    const step = values[1] - values[0];
    values.forEach((v, i) => assert.ok(near(v, values[0] + i * step, 1e-9), `${p.key} uneven ticks ${labels}`));
    const mantissa = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
    assert.ok([1, 2, 5].some((m) => near(mantissa, m, 1e-9)), `${p.key} step ${step}`);
    if (step >= 1) assert.ok(labels.every((s) => !s.includes('.')), `${p.key} integer labels: ${labels}`);
    assert.deepEqual([p.yMin, p.yMax], [values[0], values[values.length - 1]]);
    const pcts = session.series.filter((s) => s.panel === p.key).flatMap((s) => s.points.map((q) => q[2]));
    assert.ok(Math.min(...pcts) > p.yMin && Math.max(...pcts) < p.yMax, `${p.key} data outside [${p.yMin}, ${p.yMax}]`);
    // Gridlines at every tick but zero, plus a darker zero line.
    const grid = slices[p.key].match(/<line [^>]*stroke="#eceef1"/g) || [];
    assert.equal(grid.length, values.length - 1);
    assert.equal(byClass(slices[p.key], 'pc-zero').length, 1);
  }
  const fx = byClass(slices.fx, 'pc-ytick').map((el) => el.text);
  assert.ok(fx.some((s) => /^[+−]\d\.\d%$/.test(s)), `fx uses one decimal for sub-1 steps: ${fx}`);
});

test('a panel without any data gets a short plot with a centred "자료 없음"', () => {
  const session = syntheticSession();
  for (const s of session.series) {
    if (s.panel === 'fx') { s.points = []; s.status = 'missing'; s.baseline.value = null; }
  }
  C.validateSession(session);
  for (const opts of [{ width: 1200 }, { width: 390 }]) {
    const { svg, layout } = Chart.renderChart(session, syntheticNotes(), opts);
    assertWellFormed(svg);
    const fx = layout.panels.find((p) => p.key === 'fx');
    assert.equal(fx.bottom - fx.top, 90);
    assert.equal(fx.empty, true);
    assert.equal(fx.yMin, null);
    for (const p of layout.panels.filter((q) => q.key !== 'fx')) assert.equal(p.bottom - p.top, opts.width < 640 ? 170 : 230);
    const part = panelSlices(svg).fx;
    const empty = byClass(part, 'pc-empty');
    assert.equal(empty.length, 1);
    assert.equal(empty[0].text, '자료 없음');
    assert.equal(empty[0].attrs['text-anchor'], 'middle');
    assert.ok(near(Number(empty[0].attrs.x), (layout.left + layout.right) / 2, 0.1));
    assert.equal(byClass(part, 'pc-series').length, 0);
    assert.equal(byClass(part, 'pc-ytick').length, 0);
    const legend = byClass(part, 'pc-legend-item').map((el) => el.text);
    assert.deepEqual(legend, ['달러지수 · 자료 없음', '달러/원 · 자료 없음', '금 선물 · 자료 없음']);
    // Event lines and the hour axis still run through the empty panel.
    assert.ok(byClass(part, 'pc-event-line').length > 0);
    assert.ok(byClass(part, 'pc-hour').length > 0);
  }
});

test('a series without points is muted in the legend and gets no right label', () => {
  const { svg } = Chart.renderChart(syntheticSession(), null, { width: 1200 });
  const fx = panelSlices(svg).fx;
  const legend = byClass(fx, 'pc-legend-item');
  assert.deepEqual(legend.map((el) => el.text), ['달러지수', '달러/원 · 자료 없음', '금 선물']);
  assert.deepEqual(byClass(fx, 'pc-end-label').map((el) => el.attrs['data-series']), ['dxy', 'gold']);
  assert.match(legend[1].attrs.class, /pc-legend-item/);
  assert.match(fx.slice(legend[1].index), /^<g class="pc-legend-item" data-series="usdkrw"><line [^>]*opacity="0.4"/);
});

test('events: dashed lines in every panel, the band as a filled rect, two-line labels above the first panel', () => {
  for (const theme of ['light', 'dark']) {
    const notes = syntheticNotes();
    const { svg, layout } = Chart.renderChart(syntheticSession(), notes, { width: 1200, theme });
    const slices = panelSlices(svg);
    const firstPanel = svg.indexOf('<g class="pc-panel"');
    const T = Chart.THEMES[theme];
    for (const p of layout.panels) {
      const lines = byClass(slices[p.key], 'pc-event-line');
      // 3 point events + the band's two dashed edges.
      assert.equal(lines.length, 5, p.key);
      for (const l of lines) {
        assert.equal(l.attrs['stroke-dasharray'], '3 3');
        assert.deepEqual([Number(l.attrs.y1), Number(l.attrs.y2)], [p.top, p.bottom]);
      }
      const xs = lines.map((l) => Number(l.attrs.x1)).sort((a, b) => a - b);
      const expected = ['09:39', '10:30', '13:22', '13:37', '14:37'].map((h) => xOf(layout, at(h)));
      // Lines snap to the pixel centre (within half a pixel of the exact time).
      xs.forEach((x, i) => assert.ok(near(x, expected[i], 0.51), `${p.key} line ${x} vs ${expected[i]}`));
      const bands = byClass(slices[p.key], 'pc-band');
      assert.equal(bands.length, 1);
      const b = bands[0].attrs;
      assert.equal(b.fill, T.band);
      assert.equal(b['fill-opacity'], theme === 'dark' ? '0.16' : undefined);
      assert.ok(near(Number(b.x), xOf(layout, at('13:22')), 0.51));
      assert.ok(near(Number(b.width), xOf(layout, at('13:37')) - xOf(layout, at('13:22')), 1));
      assert.ok(lines.some((l) => l.attrs.x1 === b.x), 'band fill starts on its dashed edge');
      assert.deepEqual([Number(b.y), Number(b.height)], [p.top, p.bottom - p.top]);
    }
    assert.equal(T.band, theme === 'dark' ? '#6ea0f0' : '#e3edfa');
    const labels = byClass(svg, 'pc-event-label');
    assert.deepEqual(labels.map((g) => g.attrs['data-event']), ['ga', 'nc', 'senate', 'collins']);
    for (const g of labels) assert.ok(g.index < firstPanel, 'event labels sit above the first panel');
    const texts = [...svg.slice(labels[0].index, firstPanel).matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="12" text-anchor="middle" fill="([^"]+)">([^<]*)<\/text>/g)];
    assert.deepEqual(texts.map((m) => m[4]), ['오소프(GA)', '수성', '쿠퍼(NC)', '첫 플립', '상원 확정', '트럼프 승복', '콜린스(ME)']);
    for (const m of texts) assert.equal(m[3], T.muted);
    // Each label is centred on its line (band: on the band); two lines per label, sub below the label.
    const centre = (i) => Number(texts[i][1]);
    assert.ok(near(centre(0), xOf(layout, at('09:39')), 0.2));
    assert.ok(near(centre(4), (xOf(layout, at('13:22')) + xOf(layout, at('13:37'))) / 2, 0.2));
    assert.ok(Number(texts[1][2]) - Number(texts[0][2]) > 12);
  }
});

test('crowded event labels are staggered into at most three rows without overlapping', () => {
  const notes = syntheticNotes();
  // Three long labels 5 minutes apart need three rows; a fourth far to the right goes back to row 0.
  notes.events = ['12:00', '12:05', '12:10', '14:30'].map((h, i) => ({
    id: `e${i}`, at: iso(h), label: `상당히 긴 사건 이름 ${i}`, sub: '보조 설명', kind: 'other' }));
  const { svg, layout } = Chart.renderChart(syntheticSession(), notes, { width: 1200 });
  assertWellFormed(svg);
  assert.equal(byClass(svg, 'pc-marker').length, 0);
  const boxes = byClass(svg, 'pc-event-label').map((g) => {
    const t = [...svg.slice(g.index, svg.indexOf('</g>', g.index)).matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)<\/text>/g)];
    const w = Math.max(...t.map((m) => Chart.textWidth(m[3], 12)));
    return { x: Number(t[0][1]), y: Number(t[t.length - 1][2]), w };
  });
  assert.equal(boxes.length, 4);
  const rows = [...new Set(boxes.map((b) => b.y))].sort((a, b) => b - a);
  assert.equal(rows.length, 3, `rows: ${rows}`);
  assert.ok(rows[0] < layout.panels[0].top);
  assert.deepEqual(boxes.map((b) => rows.indexOf(b.y)), [0, 1, 2, 0]);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (boxes[i].y !== boxes[j].y) continue;
      assert.ok(Math.abs(boxes[i].x - boxes[j].x) >= (boxes[i].w + boxes[j].w) / 2 + 16, 'overlap in a row');
    }
  }
  // Each label stays centred on its line (no nudge was needed here).
  boxes.forEach((b, i) => assert.ok(near(b.x, xOf(layout, Date.parse(notes.events[i].at)), 0.11)));
  // The same events fit in one row when they are far apart.
  notes.events.forEach((e, i) => { e.at = iso(['08:30', '10:00', '11:30', '13:00'][i]); });
  const spread = Chart.renderChart(syntheticSession(), notes, { width: 1200 }).svg;
  const y2 = [...spread.matchAll(/<g class="pc-event-label"[^>]*><text x="[\d.]+" y="([\d.]+)"/g)].map((m) => m[1]);
  assert.equal(y2.length, 4);
  assert.equal(new Set(y2).size, 1);
});

test('labels that cannot fit in three rows switch the strip to numbered markers with a key', () => {
  const notes = syntheticNotes();
  notes.events = Array.from({ length: 12 }, (_, i) => ({
    id: `x${i}`, at: C.isoUtc(at('11:00') + i * 9 * MIN), label: `사건${i}(AB)`, sub: '설명', kind: 'other' }));
  const session = syntheticSession();
  for (const width of [1200, 1400]) {
    const { svg, layout } = Chart.renderChart(session, notes, { width, header: true });
    assertWellFormed(svg);
    assert.equal(byClass(svg, 'pc-event-label').length, 0);
    const markers = byClass(svg, 'pc-marker');
    assert.deepEqual(markers.map((m) => m.text), notes.events.map((_, i) => String(i + 1)));
    const key = byClass(svg, 'pc-event-key');
    assert.deepEqual(key.map((k) => k.attrs['data-event']), notes.events.map((e) => e.id));
    assert.deepEqual(key.map((k) => k.text), notes.events.map((e, i) => `${i + 1}${e.label} ${e.sub}`));
    // Key items never overlap: same baseline => increasing x with room for the text.
    const items = [...svg.matchAll(/<g class="pc-event-key"[^>]*><circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)]
      .map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    for (let i = 1; i < items.length; i += 1) {
      if (items[i].y !== items[i - 1].y) { assert.ok(items[i].y > items[i - 1].y); continue; }
      const w = 2 * 7 + 5 + Chart.textWidth(key[i - 1].text.slice(String(i).length), 12);
      assert.ok(items[i].x - items[i - 1].x >= w, `key items ${i - 1}/${i} overlap`);
    }
    const lastKey = svg.lastIndexOf('<g class="pc-event-key"');
    assert.ok(lastKey < svg.indexOf('<g class="pc-panel"'));
    assert.ok(Math.max(...items.map((it) => it.y)) + 8 < layout.panels[0].top);
  }
  // The 11/4-sized set of events still gets text labels.
  assert.ok(byClass(Chart.renderChart(session, syntheticNotes(), { width: 1200 }).svg, 'pc-event-label').length === 4);
});

test('compact mode numbers the events with circle markers and moves last values into the legend', () => {
  const session = syntheticSession();
  const notes = syntheticNotes();
  const { svg, layout } = Chart.renderChart(session, notes, { width: 390 });
  assertWellFormed(svg);
  assert.equal(layout.compact, true);
  assert.equal(layout.right, 390 - 16);
  const markers = byClass(svg, 'pc-marker');
  const order = C.eventsInWindow(notes, C.displayWindow(session, notes)).map((e) => e.id);
  assert.deepEqual(markers.map((m) => m.attrs['data-event']), order);
  assert.deepEqual(markers.map((m) => m.text), order.map((_, i) => String(i + 1)));
  assert.deepEqual(markers.map((m) => m.attrs['data-n']), order.map((_, i) => String(i + 1)));
  const circles = [...svg.matchAll(/<g class="pc-marker"[^>]*><circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
  assert.ok(near(circles[0], xOf(layout, at('09:39'))));
  assert.ok(near(circles[2], (xOf(layout, at('13:22')) + xOf(layout, at('13:37'))) / 2));
  assert.equal(byClass(svg, 'pc-event-label').length, 0);
  for (const text of ['오소프(GA)', '상원 확정']) assert.ok(!svg.includes(text), `${text} drawn in compact mode`);
  assert.equal(byClass(svg, 'pc-end-label').length, 0);
  const legend = byClass(panelSlices(svg).indices, 'pc-legend-item').map((el) => el.text);
  assert.deepEqual(legend, ['코스피+0.5%', '니케이225−1.4%', '항셍+1.1%']);
  // Compact can be forced either way.
  assert.equal(Chart.renderChart(session, notes, { width: 1200, compact: true }).layout.compact, true);
  const wide = Chart.renderChart(session, notes, { width: 600, compact: false });
  assert.equal(wide.layout.compact, false);
  assert.ok(byClass(wide.svg, 'pc-event-label').length > 0);
});

test('right labels show label and last value, kept at least 17px apart with connectors', () => {
  const session = syntheticSession();
  // Five indices that all end within 0.2% of each other.
  session.series = session.series.filter((s) => s.panel !== 'indices').concat(
    ['kospi', 'nikkei', 'taiex', 'hsi', 'nq'].map((id, i) => series(id, [['09:00', 0], ['12:00', -1], ['15:30', 1 + i * 0.05]])));
  C.validateSession(session);
  const { svg, layout } = Chart.renderChart(session, null, { width: 1200 });
  const part = panelSlices(svg).indices;
  const labels = byClass(part, 'pc-end-label');
  assert.deepEqual(labels.map((el) => el.text), ['코스피+1.0%', '니케이225+1.1%', '대만 가권+1.1%', '항셍+1.2%', '나스닥100 선물+1.2%']);
  assert.match(part, /<tspan>코스피<\/tspan><tspan dx="5">\+1\.0%<\/tspan>/);
  const ys = labels.map((el) => Number(el.attrs.y)).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i += 1) assert.ok(ys[i] - ys[i - 1] >= 16.85, `labels ${ys}`);
  const p = layout.panels[0];
  for (const y of ys) assert.ok(y > p.top && y < p.bottom + 12);
  assert.ok(byClass(part, 'pc-connector').length >= 2);
  for (const el of labels) {
    assert.equal(Number(el.attrs.x), layout.right + 12);
    assert.equal(el.attrs.fill, Chart.THEMES.light.text);
  }
});

test('gaps up to 125 minutes are dashed connectors; longer holes break the line', () => {
  const { svg } = Chart.renderChart(syntheticSession(), null, { width: 1200 });
  const slices = panelSlices(svg);
  const gaps = byClass(slices.indices, 'pc-gap');
  assert.deepEqual(gaps.map((g) => g.attrs['data-series']), ['nikkei']);
  assert.deepEqual([gaps[0].attrs['stroke-dasharray'], gaps[0].attrs['stroke-width'], gaps[0].attrs.opacity], ['4 4', '1.4', '0.55']);
  assert.equal(coords(gaps[0].attrs.d).length, 2);
  const nikkei = byClass(slices.indices, 'pc-series').filter((el) => el.attrs['data-series'] === 'nikkei');
  assert.equal(nikkei.length, 2);
  assert.equal(nikkei[0].attrs['stroke-width'], '2.2');
  assert.match(slices.indices, /<g class="pc-lines" fill="none" stroke-linejoin="round" stroke-linecap="round">/);
  const btc = byClass(slices.crypto, 'pc-series').filter((el) => el.attrs['data-series'] === 'btc');
  assert.equal(btc.length, 2);
  assert.equal(byClass(slices.crypto, 'pc-gap').length, 0);
  // One end dot (r=3) per series with data, at its last point.
  const ends = byClass(svg, 'pc-end');
  assert.equal(ends.length, 9);
  for (const e of ends) assert.equal(e.attrs.r, '3');
});

test('hour labels and the date line appear only under the last panel', () => {
  const { svg, layout } = Chart.renderChart(syntheticSession(), syntheticNotes(), { width: 1200 });
  const lastPanel = svg.lastIndexOf('<g class="pc-panel"');
  const hours = byClass(svg, 'pc-hour');
  assert.deepEqual(hours.map((h) => h.text), ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
  for (const h of hours) {
    assert.ok(h.index > lastPanel);
    assert.ok(Number(h.attrs.y) > layout.panels[3].bottom);
  }
  assert.ok(near(Number(hours[0].attrs.x), layout.left) && near(Number(hours[8].attrs.x), layout.right));
  const date = byClass(svg, 'pc-date');
  assert.equal(date.length, 1);
  assert.equal(date[0].text, '2026-11-04 KST');
  assert.ok(Number(date[0].attrs.y) > Number(hours[0].attrs.y));
  // Ticks under every panel.
  for (const part of Object.values(panelSlices(svg))) assert.equal(byClass(part, 'pc-hour-tick').length, 9);
  // Compact thins the labels when they would collide.
  const narrow = byClass(Chart.renderChart(syntheticSession(), null, { width: 280 }).svg, 'pc-hour').map((h) => h.text);
  assert.deepEqual(narrow, ['08:00', '10:00', '12:00', '14:00', '16:00']);
});

test('header=true adds title, subtitle and the basis/sources footer; header=false leaves them out', () => {
  const session = syntheticSession();
  const withNotes = Chart.renderChart(session, syntheticNotes(), { width: 1400, header: true }).svg;
  assert.equal(byClass(withNotes, 'pc-title').map((t) => t.text).join(' '), '테스트 세션 (11/4 08:00~16:00 KST)');
  assert.equal(byClass(withNotes, 'pc-subtitle')[0].text, '세로 점선 = 테스트 사건');
  assert.equal(byClass(withNotes, 'pc-footer').map((t) => t.text).join(' '),
    '지수·종목은 전일 종가 대비, 선물·크립토·환율·금은 08:00 KST 대비 · 출처: Yahoo Finance, Coin Metrics (CC BY-NC 4.0)');
  const bare = Chart.renderChart(session, null, { width: 1200, header: true }).svg;
  assert.equal(byClass(bare, 'pc-title')[0].text, '시장 병렬 타임라인 (11/4 08:00~16:00 KST)');
  assert.equal(byClass(bare, 'pc-subtitle')[0].text, '세로 점선 = 사건 시각 · 15분봉');
  assert.equal(byClass(bare, 'pc-event-label').length, 0);
  const off = Chart.renderChart(session, syntheticNotes(), { width: 1200 }).svg;
  for (const cls of ['pc-title', 'pc-subtitle', 'pc-footer']) assert.equal(byClass(off, cls).length, 0, cls);
  assert.match(off, /<title id="pchart-title">테스트 세션 \(11\/4 08:00~16:00 KST\)<\/title>/);
  // A long title wraps in compact mode and keeps the date range together.
  const longNotes = Object.assign(syntheticNotes(), { title: '미국 중간선거 개표 × 아시아 증시 × 크립토' });
  const wrapped = byClass(Chart.renderChart(session, longNotes, { width: 390, header: true }).svg, 'pc-title').map((t) => t.text);
  assert.ok(wrapped.length >= 2);
  assert.ok(wrapped.some((line) => line.includes('(11/4 08:00~16:00 KST)')), wrapped.join(' | '));
  for (const line of wrapped) assert.ok(Chart.textWidth(line, 16, true) <= 390 - 10 - 12 + 0.01, line);
  for (const el of byClass(Chart.renderChart(session, longNotes, { width: 390, header: true }).svg, 'pc-footer')) {
    assert.ok(Chart.textWidth(el.text, 11) <= 390 - 10 - 12 + 0.01, el.text);
  }
});

test('themes: dark uses the hub background and the dark palette by index within each panel', () => {
  const { svg, layout } = Chart.renderChart(syntheticSession(), syntheticNotes(), { width: 1200, theme: 'dark' });
  assert.equal(layout.theme, 'dark');
  assert.equal(byClass(svg, 'pc-bg')[0].attrs.fill, '#0d1117');
  const ind = layout.panels.find((p) => p.key === 'indices');
  assert.deepEqual(ind.series, [
    { id: 'kospi', color: C.COLORS.dark[0] }, { id: 'nikkei', color: C.COLORS.dark[1] }, { id: 'hsi', color: C.COLORS.dark[2] }]);
  const kospi = byClass(svg, 'pc-series').find((el) => el.attrs['data-series'] === 'kospi');
  assert.equal(kospi.attrs.stroke, C.COLORS.dark[0]);
  const light = Chart.renderChart(syntheticSession(), syntheticNotes(), { width: 1200, theme: 'nope' });
  assert.equal(light.layout.theme, 'light');
  assert.equal(byClass(light.svg, 'pc-bg')[0].attrs.fill, Chart.THEMES.light.bg);
});

test('series follow the catalog order inside a panel even when the file lists them differently', () => {
  const session = syntheticSession();
  session.series.reverse();
  const { layout } = Chart.renderChart(session, null, { width: 1200 });
  assert.deepEqual(layout.panels[0].series.map((s) => s.id), ['kospi', 'nikkei', 'hsi']);
  assert.deepEqual(layout.panels[0].series.map((s) => s.color), C.COLORS.light.slice(0, 3));
});

test('notes.display narrows the time axis and points outside it are not drawn', () => {
  const notes = syntheticNotes();
  notes.display = { start: '09:00', end: '15:00' };
  const { svg, layout } = Chart.renderChart(syntheticSession(), notes, { width: 1200 });
  assert.deepEqual([layout.start, layout.end], [at('09:00'), at('15:00')]);
  const hours = byClass(svg, 'pc-hour').map((h) => h.text);
  assert.deepEqual([hours[0], hours[hours.length - 1]], ['09:00', '15:00']);
  for (const el of byClass(svg, 'pc-series')) {
    for (const [x] of coords(el.attrs.d)) assert.ok(x >= layout.left - 0.1 && x <= layout.right + 0.1);
  }
  // A window shorter than three hours ticks every 15 or 30 minutes.
  notes.display = { start: '10:00', end: '11:00' };
  const short = byClass(Chart.renderChart(syntheticSession(), notes, { width: 1200 }).svg, 'pc-hour').map((h) => h.text);
  assert.deepEqual(short, ['10:00', '10:15', '10:30', '10:45', '11:00']);
  notes.display = { start: '10:00', end: '12:00' };
  const two = byClass(Chart.renderChart(syntheticSession(), notes, { width: 1200 }).svg, 'pc-hour').map((h) => h.text);
  assert.deepEqual(two, ['10:00', '10:30', '11:00', '11:30', '12:00']);
});

test('opts.now shades the not-yet part of a live window; nothing when outside the window', () => {
  const session = syntheticSession();
  const { svg, layout } = Chart.renderChart(session, null, { width: 1200, now: iso('12:40') });
  const future = byClass(svg, 'pc-future');
  assert.equal(future.length, 4);
  assert.ok(near(Number(future[0].attrs.x), xOf(layout, at('12:40')), 0.51));
  assert.ok(near(Number(future[0].attrs.x) + Number(future[0].attrs.width), layout.right, 0.2));
  assert.equal(byClass(svg, 'pc-now').length, 4);
  assert.deepEqual(Chart.renderChart(session, null, { width: 1200, now: at('12:40') }).svg, svg);
  for (const now of [null, at('17:00'), 'not a time']) {
    assert.equal(byClass(Chart.renderChart(session, null, { width: 1200, now }).svg, 'pc-future').length, 0);
  }
});

test('title and desc give an accessible summary of the last values', () => {
  const { svg } = Chart.renderChart(syntheticSession(), syntheticNotes(), { width: 1200, idPrefix: 'chart-a' });
  assert.match(svg, /aria-labelledby="chart-a-title chart-a-desc"/);
  const desc = /<desc id="chart-a-desc">([^<]*)<\/desc>/.exec(svg)[1];
  assert.match(desc, /주식지수: 코스피 \+0\.5%, 니케이225 −1\.4%, 항셍 \+1\.1%/);
  assert.match(desc, /달러·금: 달러지수 −0\.4%, 달러\/원 자료 없음, 금 선물 \+2\.4%/);
  assert.match(desc, /표시한 사건 4개/);
  const bad = Chart.renderChart(syntheticSession(), null, { width: 1200, idPrefix: '"><x' }).svg;
  assert.match(bad, /aria-labelledby="pchart-title pchart-desc"/);
});

test('rejects a session without a usable window and tolerates odd series', () => {
  assert.throws(() => Chart.renderChart(null, null, {}), TypeError);
  assert.throws(() => Chart.renderChart({ series: [] }, null, {}), TypeError);
  const odd = syntheticSession();
  odd.series.push(null, { id: 'mystery', panel: 'nowhere', label: '?', points: [] });
  odd.series.push({ id: 'extra', panel: 'fx', label: '추가 계열', points: [[iso('09:00'), 1, 0.5]] });
  const { svg, layout } = Chart.renderChart(odd, null, { width: 1200 });
  assertWellFormed(svg);
  assert.deepEqual(layout.panels.find((p) => p.key === 'fx').series.map((s) => s.id), ['dxy', 'usdkrw', 'gold', 'extra']);
  assert.ok(!svg.includes('mystery'));
});
