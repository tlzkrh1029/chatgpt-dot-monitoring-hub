/* Parallel timeline page (병렬 타임라인 v3).
 * Loads data/parallel/index.json, sessions/<date>.json and notes/<date>.json (on github.io the copy on
 * main at raw.githubusercontent.com first, then the same-origin Pages copy), validates them with
 * ParallelCore, draws the chart with ParallelChart and renders the analyst notes plus the automatic bullets.
 * Interaction: date select, theme toggle (saved in localStorage), crosshair and tooltip (pointer and
 * keyboard), PNG export, and polling every 5 minutes only while a non-final session is visible.
 * Never writes data. The HTML builders are pure functions exported as window.ParallelView
 * (module.exports in Node) so tests can call them without a DOM.
 */
(function (root, factory) {
  'use strict';
  const node = typeof module === 'object' && module && module.exports;
  const core = node ? require('./parallel-core.js') : root.ParallelCore;
  const api = factory(core);
  if (node) {
    module.exports = api;
    return;
  }
  root.ParallelView = api;
  const doc = root.document;
  if (!doc) return;
  const boot = () => api.start(root);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  if (!C) {
    // parallel-core.js failed to load: show one clear message instead of an empty page.
    return {
      start(win) {
        const chart = win.document.getElementById('chart');
        if (chart) chart.innerHTML = '<p class="chart-empty">페이지 스크립트를 불러오지 못했습니다. 새로고침해 주세요.</p>';
        const status = win.document.getElementById('status');
        if (status) {
          status.textContent = '수신 실패';
          status.setAttribute('data-state', 'error');
        }
      },
    };
  }

  const MINUTE = 60000;
  const POLL_MS = 5 * MINUTE;
  const TIMEOUT_MS = 15000;
  const VISIBLE_RELOAD_GAP_MS = 30000;
  const THEME_KEY = 'parallel-theme';
  const SAME_ORIGIN_BASE = 'data/parallel/';
  const PNG_WIDTH = 1400;
  const PNG_SCALE = 2;
  const NARROW_TIP_BELOW = 560;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const DEFAULT_TITLE = '시장 병렬 타임라인';
  const BASIS_TEXT = '지수·종목은 전일 종가 대비, 선물·크립토·환율·금은 08:00 KST 대비';
  const KIND_LABELS = { call: '호출', projection: '투영', statement: '발언', concession: '승복', prediction: '예측', band: '구간', other: '기타' };
  const STATUS_LABELS = { ok: '정상', stale: '이전 자료 유지', missing: '자료 없음', error: '수집 실패' };
  const PROVIDER_SHORT = { yahoo: 'Yahoo', coinmetrics: 'Coin Metrics' };
  const PANEL_SHORT = { indices: '주식지수', ai: 'AI·반도체', crypto: '크립토', fx: '달러·금' };
  const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  const RANK = new Map(C.SERIES.map((s, i) => [s.id, i]));

  const esc = C.escapeHtml;
  const inline = C.renderInline;

  // ---------------------------------------------------------------- small helpers

  function ymd(date) {
    const m = typeof date === 'string' ? DATE_RE.exec(date) : null;
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (new Date(ms).toISOString().slice(0, 10) !== date) return null;
    return { y: +m[1], m: +m[2], d: +m[3], dow: new Date(ms).getUTCDay() };
  }

  /** '11/4(수)' for '2026-11-04'. */
  function shortDate(date) {
    const p = ymd(date);
    return p ? `${p.m}/${p.d}(${WEEKDAYS[p.dow]})` : String(date == null ? '' : date);
  }

  /** '2026년 11월 4일(수)' for '2026-11-04'. */
  function longDate(date) {
    const p = ymd(date);
    return p ? `${p.y}년 ${p.m}월 ${p.d}일(${WEEKDAYS[p.dow]})` : String(date == null ? '' : date);
  }

  /** KST 'HH:MM', prefixed with 'M/D ' when the KST date is not refDate. */
  function clock(ms, refDate) {
    if (!Number.isFinite(ms)) return '';
    const day = C.kstDate(ms);
    const p = ymd(day);
    return `${refDate && day === refDate ? '' : `${p.m}/${p.d} `}${C.kstTime(ms)}`;
  }

  /** 'HH:MM KST' (or 'M/D HH:MM KST') for an ISO time, '' when it does not parse. */
  function kstStamp(iso, refDate) {
    const ms = C.toMs(iso);
    return Number.isFinite(ms) ? `${clock(ms, refDate)} KST` : '';
  }

  const isText = (v) => typeof v === 'string' && v.trim() !== '';
  const textItems = (list) => (Array.isArray(list) ? list.filter(isText) : []);
  const stripMarks = (s) => String(s).replace(/\*\*(.+?)\*\*/g, '$1');

  /** The URL when it is a plain https:// URL, else null (non-https links are shown as text only). */
  function safeUrl(url) {
    if (typeof url !== 'string' || !/^https:\/\/[^\s"'<>`]+$/i.test(url)) return null;
    try {
      return new URL(url).protocol === 'https:' ? url : null;
    } catch (error) {
      return null;
    }
  }

  /** An external link around already-escaped html, or the html alone when the URL is not safe. */
  function link(url, html) {
    const u = safeUrl(url);
    return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${html}</a>` : html;
  }

  function circled(n) {
    return n >= 1 && n <= CIRCLED.length ? CIRCLED[n - 1] : `(${n})`;
  }

  function seriesList(session) {
    return session && Array.isArray(session.series) ? session.series.filter((s) => s && typeof s === 'object') : [];
  }

  /** Series of one panel in the chart's order (catalog order, unknown ids last), so colors match the lines. */
  function panelSeries(session, key) {
    const rank = (x) => (RANK.has(x.s.id) ? RANK.get(x.s.id) : 1000 + x.i);
    return seriesList(session).map((s, i) => ({ s, i }))
      .filter((x) => x.s.panel === key)
      .sort((a, b) => rank(a) - rank(b))
      .map((x) => x.s);
  }

  /** Series id -> color slot (index within its panel, 0..4) as the chart assigns it. */
  function colorSlots(session) {
    const slots = new Map();
    for (const p of C.PANELS) panelSeries(session, p.key).forEach((s, k) => slots.set(s.id, k % 5));
    return slots;
  }

  const pctDigits = (panelKey) => (panelKey === 'fx' ? 2 : 1);
  const intervalOf = (session) => (session && Number.isInteger(session.intervalMinutes) && session.intervalMinutes > 0 ? session.intervalMinutes : 15);

  // ---------------------------------------------------------------- data location

  /**
   * Data base URLs in fetch order. On <owner>.github.io the copy on main at raw.githubusercontent.com comes
   * first (fresher than the Pages build), then the same-origin copy; elsewhere only the same-origin copy.
   * The repo is the first path segment of a project page, or '<owner>.github.io' for a user page.
   */
  function dataBases(loc) {
    const host = String((loc && loc.hostname) || '').toLowerCase();
    const suffix = '.github.io';
    if (!host.endsWith(suffix) || host.length === suffix.length) return [SAME_ORIGIN_BASE];
    const owner = host.slice(0, -suffix.length);
    const path = String((loc && loc.pathname) || '/');
    const parts = path.split('/').filter(Boolean);
    const dirs = path.endsWith('/') ? parts : parts.slice(0, -1);
    let repo = dirs.length ? dirs[0] : host;
    try {
      repo = decodeURIComponent(repo);
    } catch (error) {
      return [SAME_ORIGIN_BASE];
    }
    if (!/^[a-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo) || /^\.+$/.test(repo)) return [SAME_ORIGIN_BASE];
    return [`https://raw.githubusercontent.com/${owner}/${repo}/main/data/parallel/`, SAME_ORIGIN_BASE];
  }

  /** url + '?t=<minute bucket>' so caches are bypassed at most once a minute. */
  function withMinute(url, nowMs) {
    return `${url}${url.indexOf('?') >= 0 ? '&' : '?'}t=${Math.floor(nowMs / MINUTE)}`;
  }

  /** The ?date=YYYY-MM-DD value of a location.search string, or null. */
  function dateParam(search) {
    let value = null;
    try {
      value = new URLSearchParams(String(search || '')).get('date');
    } catch (error) {
      value = null;
    }
    return value && ymd(value) ? value : null;
  }

  // ---------------------------------------------------------------- header

  /** Status pill: {state: loading|live|final|error, text}. */
  function statusInfo(input) {
    const o = input || {};
    if (o.error) return { state: 'error', text: o.session ? '수신 실패 · 마지막 정상 자료' : '수신 실패' };
    if (!o.session) return { state: 'loading', text: '불러오는 중' };
    if (o.session.final) return { state: 'final', text: '최종' };
    const t = C.toMs(o.session.generatedAt);
    return { state: 'live', text: Number.isFinite(t) ? `실시간 · ${C.kstTime(t)} 갱신` : '실시간' };
  }

  function statusText(input) {
    return statusInfo(input).text;
  }

  function titleText(notes) {
    return notes && isText(notes.title) ? stripMarks(notes.title) : DEFAULT_TITLE;
  }

  /** '2026년 11월 4일(수) · 08:00–16:00 KST · 15분봉' (the displayed window). */
  function metaText(session, notes) {
    if (!session || !session.window) return '';
    const win = C.displayWindow(session, notes || null);
    return `${longDate(session.date)} · ${C.kstTime(win.start)}–${C.kstTime(win.end)} KST · ${intervalOf(session)}분봉`;
  }

  /**
   * <option>s for the index sessions: '11/4(수) · {title or 분석 노트 없음}'. selectedTitle (the title of the
   * notes loaded for the selected date) wins over the index, which can lag behind newly published notes.
   */
  function dateOptionsHtml(index, selected, selectedTitle) {
    const known = !!(index && Array.isArray(index.sessions));
    const list = known ? index.sessions.filter((s) => s && ymd(s.date)) : [];
    const titleOf = (s) => (s.date === selected && isText(selectedTitle) ? selectedTitle : s.title);
    const options = list.map((s) => ({ date: s.date, label: `${shortDate(s.date)} · ${isText(titleOf(s)) ? stripMarks(titleOf(s)) : '분석 노트 없음'}` }));
    if (ymd(selected) && !options.some((o) => o.date === selected)) {
      // A date from ?date= that the index does not list (or the index failed to load).
      options.unshift({ date: selected, label: known ? `${shortDate(selected)} · 목록에 없는 날짜` : shortDate(selected) });
    }
    return options.map((o) => `<option value="${esc(o.date)}"${o.date === selected ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  }

  function pngFileName(date, theme) {
    const day = ymd(date) ? date.replace(/-/g, '') : 'session';
    return `parallel-timeline-${day}${theme === 'dark' ? '-dark' : ''}.png`;
  }

  // ---------------------------------------------------------------- notes sections

  function headlineHtml(notes) {
    return notes && isText(notes.headline) ? inline(notes.headline) : '';
  }

  function verdictHtml(notes) {
    return notes && isText(notes.verdict) ? inline(notes.verdict) : '';
  }

  /** Analyst observations first, then the automatic bullets, each tagged '자동'. */
  function insightsHtml(notes, auto) {
    const items = textItems(notes && notes.observations).map((t) => `<li>${inline(t)}</li>`);
    for (const it of Array.isArray(auto) ? auto : []) {
      if (it && isText(it.text)) items.push(`<li class="is-auto"><span class="tag">자동</span>${esc(it.text)}</li>`);
    }
    return items.join('');
  }

  /** Analyst sections as cards: <article><h3>heading</h3><ul>items</ul></article>. */
  function sectionsHtml(notes) {
    const list = notes && Array.isArray(notes.sections) ? notes.sections : [];
    return list.filter((s) => s && isText(s.heading)).map((s) => {
      const items = textItems(s.items);
      const id = typeof s.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(s.id) ? ` id="note-${s.id}"` : '';
      return `<article class="card note-card"${id}><h3>${inline(s.heading)}</h3>`
        + `${items.length ? `<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>` : ''}</article>`;
    }).join('');
  }

  function watchHtml(notes) {
    return textItems(notes && notes.watch).map((t) => `<li>${inline(t)}</li>`).join('');
  }

  /** Story paragraphs, each followed by '출처: label · label' (linked when the source has an https URL). */
  function storyHtml(notes) {
    const list = notes && Array.isArray(notes.story) ? notes.story : [];
    return list.filter((p) => p && isText(p.text)).map((p) => {
      const sources = (Array.isArray(p.sources) ? p.sources : []).filter((s) => s && isText(s.label));
      const src = sources.length ? `<p class="src">출처: ${sources.map((s) => link(s.url, esc(s.label))).join(' · ')}</p>` : '';
      return `<div class="para"><p>${inline(p.text)}</p>${src}</div>`;
    }).join('');
  }

  /** Event list: KST time (band: range), chart number, label + sub, kind, source and alternative times. */
  function eventsHtml(notes, win) {
    const all = C.eventsInWindow(notes || null, null);
    const shown = win ? C.eventsInWindow(notes || null, win) : all;
    const ref = notes && ymd(notes.date) ? notes.date : null;
    return all.map((e) => {
      const at = C.toMs(e.at);
      const end = e.end == null ? NaN : C.toMs(e.end);
      const band = Number.isFinite(end) && end > at;
      const when = band ? `${clock(at, ref)}–${clock(end, ref)}` : clock(at, ref);
      const n = shown.indexOf(e);
      const num = n >= 0 ? `<span class="ev-num" title="차트 표시 번호">${circled(n + 1)}</span>` : '';
      const sub = isText(e.sub) ? `<span class="ev-sub">${inline(e.sub)}</span>` : '';
      const kind = KIND_LABELS[e.kind] ? `<span class="badge">${KIND_LABELS[e.kind]}</span>` : '';
      const detail = isText(e.detail) ? `<p class="ev-detail">${inline(e.detail)}</p>` : '';
      const src = [];
      if (isText(e.source)) src.push(link(e.url, esc(e.source)));
      else if (safeUrl(e.url)) src.push(link(e.url, '원문'));
      const alts = (Array.isArray(e.alts) ? e.alts : []).filter((a) => a && isText(a.source)).map((a) => {
        const t = C.toMs(a.at);
        return link(a.url, esc(Number.isFinite(t) ? `${a.source} ${clock(t, ref)}` : a.source));
      });
      if (alts.length) src.push(`다른 시각: ${alts.join(' · ')}`);
      return `<li><time datetime="${esc(e.at)}">${esc(when)}</time><div class="ev-body">`
        + `<p class="ev-head">${num}<strong>${inline(e.label)}</strong>${sub}${kind}</p>${detail}`
        + `${src.length ? `<p class="ev-src">${src.join(' · ')}</p>` : ''}</div></li>`;
    }).join('');
  }

  // ---------------------------------------------------------------- timetable

  function cellHtml(cell, row, digits) {
    if (!cell) return '<td class="na"><span aria-hidden="true">·</span><span class="sr-only">자료 없음</span></td>';
    const pct = esc(C.formatPct(cell.p, digits));
    const value = C.formatValue(cell.v);
    if (row.kind === 'hour') {
      const title = Number.isFinite(cell.t) && cell.t !== row.t ? `${C.kstTime(cell.t)} KST · ${value}` : value;
      return `<td title="${esc(title)}">${pct}</td>`;
    }
    const at = Number.isFinite(cell.t) ? C.kstTime(cell.t) : '';
    const title = at ? `${at} KST · ${value}` : value;
    return `<td title="${esc(title)}">${row.kind === 'min' ? `<strong>${pct}</strong>` : pct}${at ? `<span class="at">${at}</span>` : ''}</td>`;
  }

  /** Hour-by-hour table of one panel (core.hourlyTable): hour rows, then the emphasized low row and the last row. */
  function timetableHtml(session, panelKey, win) {
    if (!session) return '';
    const w = win || C.displayWindow(session, null);
    const table = C.hourlyTable(session, panelKey, w);
    if (!table.columns.length) return '<p class="empty">이 패널에 표시할 계열이 없습니다.</p>';
    const panel = C.PANELS.find((p) => p.key === panelKey);
    const slots = colorSlots(session);
    const byId = new Map(seriesList(session).map((s) => [s.id, s]));
    const digits = pctDigits(panelKey);
    const head = table.columns.map((col) => {
      const s = byId.get(col.id);
      const base = s && s.baseline && s.baseline.value != null
        ? ` title="${esc(`기준: ${s.baseline.label || ''} ${C.formatValue(s.baseline.value)}`.trim())}"` : '';
      return `<th scope="col"${base}><span class="sw c${slots.has(col.id) ? slots.get(col.id) : 0}" aria-hidden="true"></span>${esc(col.label)}</th>`;
    }).join('');
    const body = table.rows.map((row) => {
      const cls = row.kind === 'min' ? ' class="row-min"' : row.kind === 'last' ? ' class="row-last"' : '';
      return `<tr${cls}><th scope="row" class="t-row">${esc(row.label)}</th>${row.cells.map((cell) => cellHtml(cell, row, digits)).join('')}</tr>`;
    }).join('');
    const caption = panel ? `${panel.label} ${panel.suffix} 시간표` : '시간표';
    return `<table class="tt"><caption class="sr-only">${esc(caption)}</caption>`
      + `<thead><tr><th scope="col" class="t-row">시각</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  // ---------------------------------------------------------------- caption and footer

  function providerList(session) {
    const list = session && Array.isArray(session.providers) && session.providers.length ? session.providers : C.PROVIDERS;
    return list.filter((p) => p && isText(p.label));
  }

  /** Provider names actually used by series with points (all listed providers when none is referenced). */
  function providerNames(session) {
    const used = new Set(seriesList(session)
      .filter((s) => Array.isArray(s.points) && s.points.length && s.source && s.source.provider)
      .map((s) => s.source.provider));
    return providerList(session)
      .filter((p) => !used.size || used.has(p.id))
      .map((p) => `${p.label}${isText(p.license) ? ` (${p.license})` : ''}`)
      .join(', ');
  }

  /** Baselines that differ from the common one, e.g. '11/2 종가 기준: 니케이225·소프트뱅크'. */
  function baselineNotes(session) {
    const prev = new Map();
    const first = new Map();
    for (const s of seriesList(session)) {
      const b = s.baseline;
      if (!b || b.value == null || !isText(b.label)) continue;
      if (s.basis === 'prevClose') prev.set(b.label, (prev.get(b.label) || []).concat(s.label));
      else if (/^첫 관측/.test(b.label)) first.set(b.label, (first.get(b.label) || []).concat(s.label));
    }
    const out = [];
    if (prev.size > 1) {
      let common = null;
      for (const [label, names] of prev) if (common === null || names.length > prev.get(common).length) common = label;
      for (const [label, names] of prev) if (label !== common) out.push(`${label} 기준: ${names.join('·')}`);
    }
    for (const [label, names] of first) out.push(`${label} 기준: ${names.join('·')}`);
    return out;
  }

  function seriesIssues(session) {
    const stale = [];
    const failed = [];
    for (const s of seriesList(session)) {
      if (s.status === 'stale') stale.push(s.label);
      else if (s.status === 'error') failed.push(s.label);
    }
    const parts = [];
    if (stale.length) parts.push(`최근 수집 실패로 이전 자료 표시: ${stale.join('·')}`);
    if (failed.length) parts.push(`수집 실패: ${failed.join('·')}`);
    return parts.join(' · ');
  }

  /** Chart caption: basis, baseline exceptions, sources, collection problems and the generation time. */
  function captionText(session) {
    if (!session) return '';
    const parts = [BASIS_TEXT].concat(baselineNotes(session));
    const names = providerNames(session);
    if (names) parts.push(`출처: ${names}`);
    const issues = seriesIssues(session);
    if (issues) parts.push(issues);
    const generated = kstStamp(session.generatedAt, session.date);
    if (generated) parts.push(`자료 생성 ${generated}`);
    return parts.join(' · ');
  }

  function seriesTableHtml(session) {
    const rows = C.PANELS.reduce((acc, p) => acc.concat(panelSeries(session, p.key)), []).map((s) => {
      const b = s.baseline || {};
      const base = `${esc(b.label || '')}${b.value != null ? ` <span class="mono">${esc(C.formatValue(b.value))}</span>` : ''}`;
      const status = `${esc(STATUS_LABELS[s.status] || s.status || '')}${isText(s.note) ? ` · ${esc(s.note)}` : ''}`;
      const src = s.source ? `${esc(PROVIDER_SHORT[s.source.provider] || s.source.provider || '')} <span class="mono">${esc(s.source.symbol || '')}</span>` : '';
      return `<tr><th scope="row">${esc(s.label)}</th><td>${base}</td><td>${status}</td><td>${src}</td></tr>`;
    }).join('');
    if (!rows) return '';
    return '<details class="series-details"><summary>계열별 기준과 상태</summary><div class="table-wrap"><table class="st">'
      + '<thead><tr><th scope="col">계열</th><th scope="col">기준</th><th scope="col">상태</th><th scope="col">원자료</th></tr></thead>'
      + `<tbody>${rows}</tbody></table></div></details>`;
  }

  /** Footer: providers (with the license link), basis, notes author and time, footnote, collector cadence, series table. */
  function footerHtml(session, notes) {
    const providers = providerList(session).map((p) => {
      const extra = [];
      if (isText(p.note)) extra.push(esc(p.note));
      if (isText(p.license)) extra.push(link(p.licenseUrl, esc(p.license)));
      return `${link(p.url, esc(p.label))}${extra.length ? ` (${extra.join(' · ')})` : ''}`;
    });
    const lines = [
      `<p>시세 출처: ${providers.join(' · ')}</p>`,
      `<p>${esc(BASIS_TEXT)} 등락률(%)입니다. 값은 주장이 아닌 시세입니다.</p>`,
    ];
    if (notes) {
      const who = [];
      if (isText(notes.author)) who.push(`작성 ${esc(notes.author)}`);
      const asOf = kstStamp(notes.asOf, notes.date);
      if (asOf) who.push(`${esc(asOf)} 기준`);
      if (who.length) lines.push(`<p>분석 노트: ${who.join(' · ')}</p>`);
      if (isText(notes.footnote)) lines.push(`<p>${inline(notes.footnote)}</p>`);
    }
    lines.push('<p>수집기는 평일 GitHub Actions에서 약 15분마다 실행됩니다.</p>');
    if (session) lines.push(seriesTableHtml(session));
    return lines.join('');
  }

  // ---------------------------------------------------------------- crosshair geometry

  /** Plot x-range. The chart gives layout.right as the plot's right edge; a margin-sized value is read as a margin. */
  function plotBounds(layout) {
    const width = Number(layout && layout.width) || 0;
    const x0 = Number(layout && layout.left) || 0;
    const right = Number(layout && layout.right) || 0;
    const x1 = right > width / 2 ? right : width - right;
    return { x0, x1: Math.max(x0 + 1, x1) };
  }

  function timeToX(layout, t) {
    const b = plotBounds(layout);
    const span = layout.end - layout.start;
    return b.x0 + (span > 0 ? ((t - layout.start) / span) * (b.x1 - b.x0) : 0);
  }

  function xToTime(layout, x) {
    const b = plotBounds(layout);
    const f = Math.min(Math.max((x - b.x0) / (b.x1 - b.x0), 0), 1);
    return layout.start + f * (layout.end - layout.start);
  }

  /** Nearest grid time (session interval, anchored at the session window start) inside win. */
  function snapTime(session, win, t) {
    const w = win || C.displayWindow(session, null);
    const step = intervalOf(session) * MINUTE;
    const anchor = C.toMs(session.window.start);
    let s = anchor + Math.round((t - anchor) / step) * step;
    if (s < w.start) s = anchor + Math.ceil((w.start - anchor) / step) * step;
    if (s > w.end) s = anchor + Math.floor((w.end - anchor) / step) * step;
    return Math.min(Math.max(s, w.start), w.end);
  }

  /** Default keyboard cursor: the grid time at or before the newest point in the window (window end without data). */
  function latestTime(session, win) {
    const w = win || C.displayWindow(session, null);
    let last = -Infinity;
    for (const s of seriesList(session)) {
      const pts = C.seriesView(s, w);
      if (pts.length) last = Math.max(last, pts[pts.length - 1].t);
    }
    if (!Number.isFinite(last)) return snapTime(session, w, w.end);
    const step = intervalOf(session) * MINUTE;
    const anchor = C.toMs(session.window.start);
    return snapTime(session, w, anchor + Math.floor((last - anchor) / step) * step);
  }

  /** Crosshair geometry in SVG units: x, one vertical segment per panel and a dot per series with a value at t. */
  function cursorMarks(layout, session, t) {
    const x = timeToX(layout, t);
    const byId = new Map(seriesList(session).map((s) => [s.id, s]));
    const lines = [];
    const dots = [];
    for (const p of layout && Array.isArray(layout.panels) ? layout.panels : []) {
      lines.push({ y1: p.top, y2: p.bottom });
      if (p.empty || !Number.isFinite(p.yMin) || !Number.isFinite(p.yMax) || p.yMax === p.yMin) continue;
      for (const ref of Array.isArray(p.series) ? p.series : []) {
        const q = C.valueAt(byId.get(ref.id), t);
        if (!q) continue;
        const cy = p.bottom - ((q.p - p.yMin) / (p.yMax - p.yMin)) * (p.bottom - p.top);
        dots.push({ cx: timeToX(layout, q.t), cy, color: ref.color });
      }
    }
    return { x, lines, dots };
  }

  /** Tooltip body: the KST time and every series value at t (core.valueAt), grouped by panel. */
  function tooltipHtml(session, t) {
    const slots = colorSlots(session);
    const groups = C.PANELS.map((panel) => {
      const list = panelSeries(session, panel.key);
      if (!list.length) return '';
      const digits = pctDigits(panel.key);
      const rows = list.map((s) => {
        const sw = `<span class="sw c${slots.get(s.id) || 0}" aria-hidden="true"></span>`;
        const q = C.valueAt(s, t);
        if (!q) return `<li class="na">${sw}<span class="lbl">${esc(s.label)}</span><span class="pct">–</span><span class="val"></span></li>`;
        const at = q.t !== t ? ` <span class="at">${C.kstTime(q.t)}</span>` : '';
        return `<li>${sw}<span class="lbl">${esc(s.label)}${at}</span><span class="pct">${esc(C.formatPct(q.p, digits))}</span>`
          + `<span class="val">${esc(C.formatValue(q.v))}</span></li>`;
      }).join('');
      return `<div class="tip-group"><p class="tip-panel">${esc(PANEL_SHORT[panel.key] || panel.label)}</p><ul>${rows}</ul></div>`;
    }).join('');
    return `<p class="tip-time"><strong>${C.kstTime(t)}</strong> KST</p><div class="tip-grid">${groups}</div>`;
  }

  /** Plain-text version of the tooltip for the screen reader live region. */
  function readoutText(session, t) {
    const parts = C.PANELS.map((panel) => {
      const list = panelSeries(session, panel.key);
      if (!list.length) return '';
      const digits = pctDigits(panel.key);
      return `${PANEL_SHORT[panel.key] || panel.label}: ${list.map((s) => {
        const q = C.valueAt(s, t);
        return `${s.label} ${q ? C.formatPct(q.p, digits) : '자료 없음'}`;
      }).join(', ')}`;
    }).filter(Boolean);
    return `${C.kstTime(t)} KST. ${parts.join('. ')}.`;
  }

  // ---------------------------------------------------------------- PNG

  function svgSize(svg, layout) {
    const read = (name) => {
      const m = new RegExp(`<svg[^>]*\\s${name}="([0-9.]+)"`).exec(svg);
      return m ? Number(m[1]) : NaN;
    };
    const width = layout && Number.isFinite(layout.width) ? layout.width : read('width');
    const height = layout && Number.isFinite(layout.height) ? layout.height : read('height');
    return { width, height };
  }

  /** SVG string -> Image -> canvas at the given scale -> PNG Blob. */
  function rasterize(win, svg, layout, scale) {
    return new Promise((resolve, reject) => {
      const size = svgSize(svg, layout);
      if (!(size.width > 0 && size.height > 0)) {
        reject(new Error('차트 크기를 알 수 없습니다'));
        return;
      }
      const img = new win.Image();
      img.onload = () => {
        try {
          const canvas = win.document.createElement('canvas');
          canvas.width = Math.round(size.width * scale);
          canvas.height = Math.round(size.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          if (typeof canvas.toBlob === 'function') {
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG 변환 실패'))), 'image/png');
          } else {
            win.fetch(canvas.toDataURL('image/png')).then((r) => r.blob()).then(resolve, reject);
          }
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = () => reject(new Error('SVG 이미지 변환 실패'));
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
  }

  function saveBlob(win, blob, name) {
    const url = win.URL.createObjectURL(blob);
    const a = win.document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    win.document.body.appendChild(a);
    a.click();
    a.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 5000);
  }

  // ---------------------------------------------------------------- page wiring (browser only)

  function start(win) {
    const doc = win.document;
    const $ = (id) => doc.getElementById(id);
    const el = {
      title: $('title'), meta: $('meta'), select: $('date-select'), status: $('status'), theme: $('theme-toggle'),
      pngLight: $('png-light'), pngDark: $('png-dark'), note: $('tool-note'), noNotes: $('no-notes'),
      headlineSec: $('headline-sec'), headline: $('headline'), box: $('chart-box'), chart: $('chart'), tip: $('tip'),
      caption: $('chart-caption'), help: $('chart-help'), live: $('chart-live'), duo: $('duo'), obs: $('obs'), seg: $('panel-seg'),
      basis: $('table-basis'), table: $('table'), sectionsSec: $('sections-sec'), sections: $('sections'),
      watchSec: $('watch-sec'), watch: $('watch'), storySec: $('story-sec'), story: $('story'),
      verdictSec: $('verdict-sec'), verdict: $('verdict'), eventsSec: $('events-sec'), events: $('events'), foot: $('foot'),
    };
    if (!el.chart || !el.box || !el.status) return;

    const state = {
      bases: dataBases(win.location),
      index: null,
      session: null,
      notes: null,
      date: dateParam(win.location.search),
      error: '',
      seq: 0,
      lastLoad: 0,
      timer: null,
      panel: C.PANELS[0].key,
      theme: doc.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark',
      layout: null,
      width: 0,
      cursor: null,
      tipPos: null,
      hover: false,
      exporting: false,
      optionsHtml: '',
      notesChecked: new Set(),
    };
    const logError = (error) => { if (win.console) win.console.error(error); };
    const chartApi = () => (win.ParallelChart && typeof win.ParallelChart.renderChart === 'function' ? win.ParallelChart : null);
    const displayWin = () => C.displayWindow(state.session, state.notes);

    // ------------------------------------------------ loading

    async function getJson(name, now, optional) {
      let lastError = null;
      let missing = 0;
      for (const base of state.bases) {
        const ctrl = typeof win.AbortController === 'function' ? new win.AbortController() : null;
        const timer = ctrl ? win.setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
        try {
          const res = await win.fetch(withMinute(base + name, now), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
          if (res.ok) return await res.json();
          if (res.status === 404) missing += 1;
          lastError = new Error(`HTTP ${res.status}`);
        } catch (error) {
          lastError = error;
        } finally {
          if (timer) win.clearTimeout(timer);
        }
      }
      if (optional && missing === state.bases.length) return null;
      throw lastError || new Error('응답 없음');
    }

    const describe = (error) => (error && error.name === 'AbortError' ? '응답 시간 초과' : (error && error.message) || '알 수 없는 오류');

    async function load() {
      const seq = ++state.seq;
      const now = Date.now();
      state.lastLoad = now;
      const problems = [];
      let index = state.index;
      try {
        index = C.validateIndex(await getJson('index.json', now, false));
      } catch (error) {
        problems.push(`목록: ${describe(error)}`);
      }
      if (seq !== state.seq) return;
      state.index = index;
      const date = state.date || (index && index.sessions.length ? index.sessions[0].date : null);
      let session = null;
      let notes = null;
      let notesOk = true;
      let keepNotes = false;
      if (date) {
        try {
          session = C.validateSession(await getJson(`sessions/${date}.json`, now, false));
          if (session.date !== date) throw new Error(`날짜 불일치(${session.date})`);
        } catch (error) {
          session = null;
          problems.push(`세션: ${describe(error)}`);
        }
        if (seq !== state.seq) return;
        // index.hasNotes can lag behind notes published after a session is final, so the notes file is
        // requested at least once per date (404 = no notes); later refreshes skip it while the index says none.
        const entry = index ? index.sessions.find((s) => s.date === date) : null;
        if (session && entry && entry.hasNotes === false && state.notesChecked.has(date)) {
          keepNotes = true;
        } else if (session) {
          state.notesChecked.add(date);
          try {
            const raw = await getJson(`notes/${date}.json`, now, true);
            notes = raw === null ? null : C.validateNotes(raw);
            if (notes && notes.date !== date) throw new Error(`날짜 불일치(${notes.date})`);
          } catch (error) {
            notesOk = false;
            notes = null;
            problems.push(`노트: ${describe(error)}`);
          }
          if (seq !== state.seq) return;
        }
      } else if (!problems.length) {
        problems.push('아직 수집된 날짜가 없습니다');
      }
      if (session) {
        const sameDate = state.session && state.session.date === session.date;
        state.notes = notesOk && !keepNotes ? notes : (sameDate ? state.notes : null);
        if (!sameDate) state.cursor = null;
        state.session = session;
        state.date = session.date;
      } else if (state.session) {
        state.date = state.session.date; // keep showing the last good session
      }
      state.error = problems.join(' · ');
      renderAll();
      schedule();
    }

    function schedule() {
      win.clearTimeout(state.timer);
      state.timer = null;
      if (doc.visibilityState === 'hidden') return;
      if (state.session && state.session.final) return;
      state.timer = win.setTimeout(load, POLL_MS);
    }

    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'hidden') {
        win.clearTimeout(state.timer);
        state.timer = null;
        return;
      }
      if (state.session && state.session.final) return;
      if (Date.now() - state.lastLoad >= VISIBLE_RELOAD_GAP_MS) load();
      else schedule();
    });

    // ------------------------------------------------ rendering

    function renderStatus() {
      const info = statusInfo({ session: state.session, error: state.error });
      if (el.status.textContent !== info.text) el.status.textContent = info.text;
      el.status.setAttribute('data-state', info.state);
      el.status.title = state.error ? `최근 확인 실패: ${state.error}` : '';
    }

    function renderHeader() {
      const s = state.session;
      const n = state.notes;
      const title = titleText(n);
      el.title.textContent = title;
      el.meta.textContent = s ? metaText(s, n) : (state.error ? '자료를 불러오지 못했습니다.' : '자료를 불러오는 중입니다.');
      doc.title = s ? `${title} · ${shortDate(s.date)} | 병렬 타임라인` : '병렬 타임라인 | 지금 상황판';
      const options = dateOptionsHtml(state.index, s ? s.date : state.date, n && n.title)
        || (state.error ? '<option>날짜 목록 없음</option>' : '<option>날짜 불러오는 중</option>');
      if (options !== state.optionsHtml) {
        el.select.innerHTML = options;
        state.optionsHtml = options;
      }
      el.select.disabled = !state.index && !s;
      const canExport = !!(s && chartApi()) && !state.exporting;
      el.pngLight.disabled = !canExport;
      el.pngDark.disabled = !canExport;
    }

    function renderChart(force) {
      const s = state.session;
      const api = chartApi();
      if (!s || !api) {
        state.layout = null;
        state.width = 0;
        let msg = '자료를 불러오는 중입니다.';
        if (s) msg = '차트 모듈을 불러오지 못했습니다.';
        else if (state.error) msg = `자료를 불러오지 못했습니다. ${state.error}`;
        el.chart.innerHTML = `<p class="chart-empty">${esc(msg)}</p>`;
        el.tip.hidden = true;
        el.help.hidden = true;
        el.box.tabIndex = -1;
        return;
      }
      el.help.hidden = false;
      el.box.tabIndex = 0;
      const width = Math.floor(el.chart.clientWidth);
      if (!width || (!force && width === state.width && state.layout)) return;
      try {
        const out = api.renderChart(s, state.notes, { width, theme: state.theme, header: false, compact: width < 640, now: s.final ? null : Date.now() });
        el.chart.innerHTML = out.svg;
        state.layout = out.layout;
        state.width = width;
      } catch (error) {
        logError(error);
        state.layout = null;
        el.chart.innerHTML = '<p class="chart-empty">차트를 그리지 못했습니다.</p>';
      }
      drawCursor(state.tipPos);
    }

    function setSection(section, box, html) {
      box.innerHTML = html;
      section.hidden = !html;
    }

    function renderTable() {
      for (const b of el.seg.querySelectorAll('button[data-panel]')) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-panel') === state.panel));
      }
      const panel = C.PANELS.find((p) => p.key === state.panel);
      el.basis.textContent = panel ? `${panel.label} ${panel.suffix} · 칸에 올리면 가격이 나옵니다` : '';
      el.table.innerHTML = state.session ? timetableHtml(state.session, state.panel, displayWin()) : '';
    }

    function renderBody() {
      const s = state.session;
      const n = state.notes;
      el.duo.hidden = !s;
      el.noNotes.hidden = !s || !!n;
      el.caption.textContent = s ? captionText(s) : '';
      if (el.caption.parentElement) el.caption.parentElement.hidden = !s;
      if (!s) {
        for (const [section, box] of [[el.headlineSec, el.headline], [el.sectionsSec, el.sections], [el.watchSec, el.watch],
          [el.storySec, el.story], [el.verdictSec, el.verdict], [el.eventsSec, el.events]]) setSection(section, box, '');
      } else {
        const w = displayWin();
        let auto = [];
        try {
          auto = C.insights(s, n, w);
        } catch (error) {
          logError(error);
        }
        setSection(el.headlineSec, el.headline, headlineHtml(n));
        el.obs.innerHTML = insightsHtml(n, auto) || '<li class="empty">아직 표시할 항목이 없습니다.</li>';
        renderTable();
        setSection(el.sectionsSec, el.sections, sectionsHtml(n));
        setSection(el.watchSec, el.watch, watchHtml(n));
        setSection(el.storySec, el.story, storyHtml(n));
        setSection(el.verdictSec, el.verdict, verdictHtml(n));
        setSection(el.eventsSec, el.events, eventsHtml(n, w));
      }
      const open = !!(el.foot.querySelector('details') && el.foot.querySelector('details').open);
      el.foot.innerHTML = footerHtml(s, n);
      const details = el.foot.querySelector('details');
      if (details && open) details.open = true;
    }

    function renderAll() {
      renderStatus();
      renderHeader();
      try {
        renderBody();
      } catch (error) {
        logError(error);
      }
      renderChart(true);
    }

    // ------------------------------------------------ crosshair and tooltip

    function placeTip(xSvg, pos) {
      const svg = el.chart.querySelector('svg');
      if (!svg || !state.layout) return;
      const boxRect = el.box.getBoundingClientRect();
      const r = svg.getBoundingClientRect();
      const scale = r.width / state.layout.width || 1;
      const x = r.left - boxRect.left + xSvg * scale;
      const bw = el.box.clientWidth;
      const bh = el.box.clientHeight;
      const tw = el.tip.offsetWidth;
      const th = el.tip.offsetHeight;
      let left = x + 16;
      if (left + tw > bw - 4) left = x - 16 - tw;
      if (left < 4) left = Math.min(Math.max(4, x - tw / 2), Math.max(4, bw - tw - 4));
      const visTop = Math.max(0, -boxRect.top);
      const visBottom = Math.min(bh, win.innerHeight - boxRect.top);
      let top;
      if (pos && Number.isFinite(pos.y)) {
        top = pos.touch ? pos.y - th - 28 : pos.y - th / 2;
        if (pos.touch && top < visTop + 4) top = pos.y + 28;
      } else {
        top = visTop + 12;
      }
      top = Math.min(top, visBottom - th - 4);
      top = Math.max(top, visTop + 4);
      top = Math.min(Math.max(top, 0), Math.max(0, bh - th));
      el.tip.style.left = `${Math.round(left)}px`;
      el.tip.style.top = `${Math.round(top)}px`;
    }

    function drawCursor(pos) {
      const svg = el.chart.querySelector('svg');
      const old = svg && svg.querySelector('.pv-xhair');
      if (old) old.remove();
      if (state.cursor === null || !svg || !state.layout || !state.session) {
        el.tip.hidden = true;
        return;
      }
      const marks = cursorMarks(state.layout, state.session, state.cursor);
      const g = doc.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'pv-xhair');
      g.setAttribute('aria-hidden', 'true');
      g.setAttribute('pointer-events', 'none');
      for (const ln of marks.lines) {
        const line = doc.createElementNS(SVG_NS, 'line');
        line.setAttribute('x1', marks.x);
        line.setAttribute('x2', marks.x);
        line.setAttribute('y1', ln.y1);
        line.setAttribute('y2', ln.y2);
        g.appendChild(line);
      }
      for (const d of marks.dots) {
        const dot = doc.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', d.cx);
        dot.setAttribute('cy', d.cy);
        dot.setAttribute('r', '3.6');
        dot.setAttribute('fill', d.color);
        g.appendChild(dot);
      }
      svg.appendChild(g);
      el.tip.innerHTML = tooltipHtml(state.session, state.cursor);
      el.tip.classList.toggle('is-narrow', el.box.clientWidth < NARROW_TIP_BELOW);
      el.tip.hidden = false;
      placeTip(marks.x, pos);
    }

    function hideCursor() {
      state.cursor = null;
      state.tipPos = null;
      drawCursor(null);
    }

    function setCursor(t, pos) {
      state.tipPos = pos;
      if (t === state.cursor && !el.tip.hidden) {
        placeTip(timeToX(state.layout, t), pos);
        return;
      }
      state.cursor = t;
      drawCursor(pos);
    }

    function onPointer(ev) {
      const svg = el.chart.querySelector('svg');
      if (!svg || !state.layout || !state.session) return;
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      const x = ((ev.clientX - r.left) * state.layout.width) / r.width;
      const t = snapTime(state.session, displayWin(), xToTime(state.layout, x));
      setCursor(t, { y: ev.clientY - el.box.getBoundingClientRect().top, touch: ev.pointerType === 'touch' });
    }

    let announceTimer = null;
    function announce() {
      win.clearTimeout(announceTimer);
      announceTimer = win.setTimeout(() => {
        if (state.cursor !== null && state.session) el.live.textContent = readoutText(state.session, state.cursor);
      }, 250);
    }

    el.box.addEventListener('pointerenter', (ev) => { if (ev.pointerType === 'mouse') state.hover = true; });
    el.box.addEventListener('pointermove', (ev) => { if (ev.pointerType !== 'touch' || ev.buttons) onPointer(ev); });
    el.box.addEventListener('pointerdown', onPointer);
    el.box.addEventListener('pointerleave', (ev) => {
      if (ev.pointerType !== 'mouse') return;
      state.hover = false;
      if (doc.activeElement !== el.box) hideCursor();
    });
    doc.addEventListener('pointerdown', (ev) => { if (!el.box.contains(ev.target)) hideCursor(); });
    el.box.addEventListener('focus', () => {
      if (state.cursor === null && state.session && state.layout) {
        state.cursor = latestTime(state.session, displayWin());
        state.tipPos = null;
        drawCursor(null);
        announce();
      }
    });
    el.box.addEventListener('blur', () => { if (!state.hover) hideCursor(); });
    el.box.addEventListener('keydown', (ev) => {
      if (!state.session || !state.layout) return;
      const w = displayWin();
      const step = intervalOf(state.session) * MINUTE;
      const current = state.cursor === null ? latestTime(state.session, w) : state.cursor;
      let t;
      if (ev.key === 'ArrowRight') t = current + step;
      else if (ev.key === 'ArrowLeft') t = current - step;
      else if (ev.key === 'Home') t = w.start;
      else if (ev.key === 'End') t = w.end;
      else if (ev.key === 'Escape') {
        hideCursor();
        return;
      } else return;
      ev.preventDefault();
      setCursor(snapTime(state.session, w, t), null);
      announce();
    });

    // ------------------------------------------------ controls

    el.seg.innerHTML = C.PANELS.map((p) => `<button type="button" data-panel="${esc(p.key)}" aria-pressed="${p.key === state.panel}">${esc(PANEL_SHORT[p.key] || p.label)}</button>`).join('');
    el.seg.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-panel]');
      if (!b || b.getAttribute('data-panel') === state.panel) return;
      state.panel = b.getAttribute('data-panel');
      renderTable();
    });

    el.select.addEventListener('change', () => {
      const d = el.select.value;
      if (!ymd(d) || (state.session && d === state.session.date)) return;
      state.date = d;
      state.cursor = null;
      try {
        const url = new win.URL(win.location.href);
        url.searchParams.set('date', d);
        win.history.replaceState(null, '', url.toString());
      } catch (error) { /* the URL stays as it was */ }
      load();
    });

    function applyTheme() {
      doc.documentElement.setAttribute('data-theme', state.theme);
      el.theme.setAttribute('aria-pressed', String(state.theme === 'light'));
    }
    el.theme.addEventListener('click', () => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      applyTheme();
      try {
        win.localStorage.setItem(THEME_KEY, state.theme);
      } catch (error) { /* storage blocked: the choice lasts for this page only */ }
      renderChart(true);
    });
    applyTheme();

    let noteTimer = null;
    function toolNote(text) {
      win.clearTimeout(noteTimer);
      el.note.textContent = text;
      if (text) noteTimer = win.setTimeout(() => { el.note.textContent = ''; }, 6000);
    }

    async function exportPng(theme, button) {
      const s = state.session;
      const api = chartApi();
      if (!s || !api || state.exporting) return;
      state.exporting = true;
      button.setAttribute('aria-busy', 'true');
      el.pngLight.disabled = true;
      el.pngDark.disabled = true;
      try {
        const out = api.renderChart(s, state.notes, { width: PNG_WIDTH, theme, header: true, compact: false, now: s.final ? null : Date.now(), idPrefix: 'pchartpng' });
        const blob = await rasterize(win, out.svg, out.layout, PNG_SCALE);
        const name = pngFileName(s.date, theme);
        saveBlob(win, blob, name);
        toolNote(`PNG를 저장했습니다: ${name}`);
      } catch (error) {
        logError(error);
        toolNote(`PNG를 만들지 못했습니다: ${describe(error)}`);
      } finally {
        state.exporting = false;
        button.removeAttribute('aria-busy');
        renderHeader();
      }
    }
    el.pngLight.addEventListener('click', () => exportPng('light', el.pngLight));
    el.pngDark.addEventListener('click', () => exportPng('dark', el.pngDark));

    // ------------------------------------------------ resize

    let resizeTimer = null;
    const onResize = () => {
      win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(() => {
        if (state.session && Math.floor(el.chart.clientWidth) !== state.width) renderChart(false);
      }, 150);
    };
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(onResize).observe(el.chart);
    else win.addEventListener('resize', onResize);

    renderAll();
    load();
  }

  return {
    start,
    dataBases, withMinute, dateParam,
    statusInfo, statusText, titleText, metaText, dateOptionsHtml, pngFileName,
    shortDate, longDate, safeUrl,
    headlineHtml, insightsHtml, sectionsHtml, watchHtml, storyHtml, verdictHtml, eventsHtml,
    timetableHtml, captionText, baselineNotes, providerNames, footerHtml,
    panelSeries, colorSlots, plotBounds, timeToX, xToTime, snapTime, latestTime, cursorMarks,
    tooltipHtml, readoutText, svgSize,
  };
});
