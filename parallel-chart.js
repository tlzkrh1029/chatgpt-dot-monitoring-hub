/* Parallel timeline chart (병렬 타임라인 v3).
 * renderChart(session, notes, opts) -> {svg, layout}
 * Four stacked panels (PANELS order) share one KST time axis: panel title + legend, y gridlines at nice
 * ticks, dashed event lines and light-blue bands, series lines with end dots and collision-free right
 * labels, hour labels and the date line under the last panel. The SVG is self-contained (xmlns, explicit
 * size and viewBox, inline font stack, explicit fills, background rect) so it can be shown inline or
 * rasterized to PNG. layout gives the plot geometry so the page can map pointer x to time.
 * Depends only on ParallelCore. Deterministic: no clock reads and no randomness; every text is escaped.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./parallel-core.js'));
  else root.ParallelChart = factory(root.ParallelCore);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';
  if (!Core || typeof Core.niceTicks !== 'function') {
    throw new Error('parallel-chart.js: ParallelCore is missing (load parallel-core.js first)');
  }

  const HOUR = 3600e3;
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 4096;
  const COMPACT_BELOW = 640;
  const FONT = "'IBM Plex Sans KR','Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',system-ui,sans-serif";
  const DEFAULT_TITLE = '시장 병렬 타임라인';
  const FOOTER = '지수·종목은 전일 종가 대비, 선물·크립토·환율·금은 08:00 KST 대비 · 출처: Yahoo Finance, Coin Metrics (CC BY-NC 4.0)';
  const NO_DATA = '자료 없음';
  const MAX_EVENT_ROWS = 3;

  /** Theme tokens. Dark follows the hub palette (index.html); light follows the reference chart. */
  const THEMES = Object.freeze({
    light: Object.freeze({
      bg: '#fcfcfd', title: '#15191f', text: '#1f2329', text2: '#3f4752', muted: '#69727e', faint: '#9aa2ad',
      grid: '#eceef1', axis: '#c4cad2', zero: '#949ba6', event: '#8c95a1',
      band: '#e3edfa', bandOpacity: 1,
      markerBg: '#ffffff', markerLine: '#8c95a1', markerText: '#2f3640',
      future: '#0b1320', futureOpacity: 0.035,
    }),
    dark: Object.freeze({
      bg: '#0d1117', title: '#f2f4f7', text: '#e6eaf0', text2: '#c9d1dc', muted: '#a9b2c0', faint: '#6f7a8a',
      grid: '#1c232c', axis: '#3a4352', zero: '#69748a', event: '#768296',
      band: '#6ea0f0', bandOpacity: 0.16,
      markerBg: '#151b23', markerLine: '#768296', markerText: '#e6eaf0',
      future: '#ffffff', futureOpacity: 0.03,
    }),
  });

  // Sizes in px. Regular targets width 1200 (reference image); compact targets phones (< 640 px).
  const SIZES = Object.freeze({
    regular: Object.freeze({
      left: 64, right: 170, contentPad: 0, padTop: 18, padBottom: 16,
      titleSize: 20, titleLine: 27, subSize: 13, subLine: 19, headerGap: 18,
      eventSize: 12, eventLine: 15, eventRow: 33, stripGap: 12, eventGap: 16, eventMaxW: 220,
      markerR: 8, markerRow: 21, keyRow: 20,
      panelTitle: 16, panelSuffix: 13, legendSize: 12, legendGap: 23, legendRow: 20, legendSample: 18,
      legendItemGap: 18, plotGap: 16,
      plotH: 230, emptyH: 90, panelGap: 34,
      tickSize: 12, tickGap: 8, hourSize: 12, hourGap: 19, dateGap: 19, footSize: 12, footGap: 26, footLine: 17,
      rightSize: 12, rightPad: 12,
    }),
    compact: Object.freeze({
      left: 34, right: 16, contentPad: 10, padTop: 12, padBottom: 12,
      titleSize: 16, titleLine: 21, subSize: 12, subLine: 16, headerGap: 12,
      eventSize: 11, eventLine: 13, eventRow: 29, stripGap: 8, eventGap: 6, eventMaxW: 160,
      markerR: 8, markerRow: 21, keyRow: 18,
      panelTitle: 14, panelSuffix: 11.5, legendSize: 11.5, legendGap: 20, legendRow: 18, legendSample: 12,
      legendItemGap: 12, plotGap: 13,
      plotH: 170, emptyH: 90, panelGap: 26,
      tickSize: 10.5, tickGap: 5, hourSize: 10.5, hourGap: 16, dateGap: 16, footSize: 11, footGap: 22, footLine: 15,
      rightSize: 11, rightPad: 8,
    }),
  });

  // ---------------------------------------------------------------- text

  /** Plain text for SVG: drops characters XML cannot carry, the **bold** markers and repeated whitespace. */
  function clean(value) {
    if (value == null) return '';
    const s = String(value);
    let out = '';
    for (let i = 0; i < s.length; i += 1) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { out += s[i] + s[i + 1]; i += 1; }
        continue;
      }
      if (c >= 0xdc00 && c <= 0xdfff) continue;
      if (c === 9 || c === 10 || c === 13) { out += ' '; continue; }
      if (c < 0x20 || c === 0xfffe || c === 0xffff) continue;
      out += s[i];
    }
    return out.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\s+/g, ' ').trim();
  }

  const esc = (s) => Core.escapeHtml(s);

  // Advance width of one character in em, deliberately a little generous for Korean UI fonts.
  function charEm(ch) {
    const cp = ch.codePointAt(0);
    if ((cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) return 0.95;
    if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef)) return 1;
    if (cp >= 0x2460 && cp <= 0x24ff) return 1;
    if (cp === 0x20 || cp === 0xa0) return 0.28;
    if (cp >= 0x30 && cp <= 0x39) return 0.57;
    if (cp >= 0x41 && cp <= 0x5a) return 'MW'.indexOf(ch) >= 0 ? 0.86 : ('IJ'.indexOf(ch) >= 0 ? 0.32 : 0.67);
    if (cp >= 0x61 && cp <= 0x7a) {
      if ('ijl'.indexOf(ch) >= 0) return 0.25;
      if ('frt'.indexOf(ch) >= 0) return 0.37;
      if ('mw'.indexOf(ch) >= 0) return 0.83;
      return 0.55;
    }
    if ('.,:;!|\''.indexOf(ch) >= 0) return 0.28;
    if ('()[]{}'.indexOf(ch) >= 0) return 0.35;
    if ('/\\-"'.indexOf(ch) >= 0) return 0.4;
    if ('·•'.indexOf(ch) >= 0) return 0.32;
    if ('%@'.indexOf(ch) >= 0) return 0.88;
    if ('&'.indexOf(ch) >= 0) return 0.7;
    if ('…'.indexOf(ch) >= 0) return 0.9;
    return 0.62;
  }

  /** Estimated rendered width of text in px (no layout engine here; used for spacing and collision checks). */
  function textWidth(text, size, bold) {
    let em = 0;
    for (const ch of String(text)) em += charEm(ch);
    return em * size * (bold ? 1.06 : 1);
  }

  /** Text shortened with an ellipsis so that it fits maxW. */
  function fit(text, maxW, size, bold) {
    if (textWidth(text, size, bold) <= maxW) return text;
    const chars = Array.from(text);
    while (chars.length && textWidth(`${chars.join('').trimEnd()}…`, size, bold) > maxW) chars.pop();
    return chars.length ? `${chars.join('').trimEnd()}…` : '…';
  }

  /** Greedy word wrap into lines no wider than maxW (long words are cut by character). */
  function wrap(text, maxW, size, bold) {
    const words = text.split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    for (let word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxW) { line = candidate; continue; }
      if (line) lines.push(line);
      line = '';
      while (textWidth(word, size, bold) > maxW && Array.from(word).length > 1) {
        const chars = Array.from(word);
        let cut = chars.length - 1;
        while (cut > 1 && textWidth(chars.slice(0, cut).join(''), size, bold) > maxW) cut -= 1;
        lines.push(chars.slice(0, cut).join(''));
        word = chars.slice(cut).join('');
      }
      line = word;
    }
    if (line) lines.push(line);
    return lines;
  }

  // ---------------------------------------------------------------- numbers

  function num(x) {
    const r = Math.round(x * 10) / 10;
    return String(r === 0 ? 0 : r);
  }
  // Crisp 1px lines: snap to the pixel centre.
  const crisp = (x) => Math.round(x - 0.5) + 0.5;
  const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

  function stepDecimals(step) {
    for (let d = 0; d <= 6; d += 1) {
      if (Math.abs(step * Math.pow(10, d) - Math.round(step * Math.pow(10, d))) < 1e-9) return d;
    }
    return 6;
  }

  function isQuarterStep(step) {
    const m = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9));
    return Math.abs(m - 2.5) < 1e-6;
  }

  /** Y-axis label: '0%' at zero, integers for whole steps, otherwise the decimals the step needs. */
  function tickText(value, decimals) {
    if (value === 0) return '0%';
    return Core.formatPct(value, decimals);
  }

  /** Y domain: every point in the window plus 0, padded by 6%, widened to the nice tick extent. */
  function yScaleFor(series, plotH) {
    let lo = 0;
    let hi = 0;
    for (const s of series) {
      for (const q of s.pts) {
        if (q.p < lo) lo = q.p;
        if (q.p > hi) hi = q.p;
      }
    }
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
    const maxTicks = clamp(Math.round(plotH / 26), 4, 10);
    let t = Core.niceTicks(lo, hi, maxTicks);
    // Steps of 2.5 read oddly on a percent axis; take one more tick when that gives 1, 2 or 5.
    if (isQuarterStep(t.step)) {
      const alt = Core.niceTicks(lo, hi, maxTicks + 1);
      if (!isQuarterStep(alt.step)) t = alt;
    }
    const decimals = Number.isInteger(t.decimals) ? t.decimals : stepDecimals(t.step);
    return { ticks: t.ticks, min: t.ticks[0], max: t.ticks[t.ticks.length - 1], decimals };
  }

  // ---------------------------------------------------------------- data

  function options(opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    let width = Number(o.width);
    width = Number.isFinite(width) && width > 0 ? Math.round(width) : 1200;
    width = clamp(width, MIN_WIDTH, MAX_WIDTH);
    const now = o.now == null ? NaN : Core.toMs(o.now);
    return {
      width,
      theme: o.theme === 'dark' ? 'dark' : 'light',
      header: o.header === true,
      compact: typeof o.compact === 'boolean' ? o.compact : width < COMPACT_BELOW,
      now: Number.isFinite(now) ? now : null,
      prefix: typeof o.idPrefix === 'string' && /^[A-Za-z][\w-]{0,40}$/.test(o.idPrefix) ? o.idPrefix : 'pchart',
    };
  }

  /** Panels in PANELS order with their series (catalog order, colors by index within the panel). */
  function buildPanels(session, win, theme) {
    const rank = new Map(Core.SERIES.map((s, i) => [s.id, i]));
    const catalog = new Map(Core.SERIES.map((s) => [s.id, s]));
    const palette = Core.COLORS[theme];
    const all = (Array.isArray(session.series) ? session.series : [])
      .map((s, i) => ({ s, i }))
      .filter((x) => x.s && typeof x.s === 'object');
    return Core.PANELS.map((P) => {
      const list = all.filter((x) => x.s.panel === P.key).sort((a, b) => {
        const ra = rank.has(a.s.id) ? rank.get(a.s.id) : 1000 + a.i;
        const rb = rank.has(b.s.id) ? rank.get(b.s.id) : 1000 + b.i;
        return ra - rb;
      });
      const series = list.map((x, k) => {
        const pts = Core.seriesView(x.s, win);
        const known = catalog.get(x.s.id);
        const label = clean(x.s.label) || (known ? known.label : clean(x.s.id)) || '?';
        return { id: clean(x.s.id), label, color: palette[k % palette.length], pts, last: pts.length ? pts[pts.length - 1] : null };
      });
      return { key: P.key, title: P.label, suffix: P.suffix, series, hasData: series.some((s) => s.pts.length > 0) };
    });
  }

  function eventMarks(events, win) {
    return events.map((e, i) => {
      const at = Core.toMs(e.at);
      const endRaw = e.end == null ? NaN : Core.toMs(e.end);
      const band = Number.isFinite(endRaw) && endRaw > at;
      const a = clamp(at, win.start, win.end);
      const b = band ? clamp(endRaw, win.start, win.end) : a;
      return {
        n: i + 1, id: e.id == null ? '' : clean(e.id), band, a, b,
        aEdge: band && at >= win.start, bEdge: band && endRaw <= win.end,
        label: clean(e.label), sub: clean(e.sub),
      };
    });
  }

  // Greedy rows: each box goes to the lowest row where it overlaps nothing (gap included), shifted right
  // by at most box.nudge px when that clears the row; when every row is taken it goes where it overlaps least.
  function assignRows(boxes, maxRows, gap, maxX) {
    const rows = [];
    const free = (taken, x0, x1) => taken.every((o) => x1 + gap <= o.x0 || x0 >= o.x1 + gap);
    for (const box of boxes) {
      let row = -1;
      for (let r = 0; r < maxRows && row < 0; r += 1) {
        const taken = rows[r] || [];
        if (free(taken, box.x0, box.x1)) { row = r; break; }
        const shift = taken.reduce((m, o) => (o.x0 < box.x0 ? Math.max(m, o.x1 + gap - box.x0) : m), 0);
        if (shift > 0 && shift <= (box.nudge || 0) && box.x1 + shift <= maxX && free(taken, box.x0 + shift, box.x1 + shift)) {
          box.x0 += shift;
          box.x1 += shift;
          box.cx += shift;
          row = r;
        }
      }
      if (row < 0) {
        let best = Infinity;
        for (let r = 0; r < maxRows; r += 1) {
          const overlap = (rows[r] || []).reduce((sum, o) => sum + Math.max(0, Math.min(box.x1, o.x1) - Math.max(box.x0, o.x0) + gap), 0);
          if (overlap < best) { best = overlap; row = r; }
        }
        box.clash = true;
      }
      (rows[row] = rows[row] || []).push(box);
      box.row = row;
    }
    return boxes.reduce((m, b) => Math.max(m, b.row + 1), 0);
  }

  // ---------------------------------------------------------------- svg pieces

  function textEl(x, y, body, attrs) {
    return `<text x="${num(x)}" y="${num(y)}"${attrs}>${body}</text>`;
  }

  function hline(x0, x1, y, stroke, extra) {
    const yy = crisp(y);
    return `<line x1="${num(x0)}" y1="${yy}" x2="${num(x1)}" y2="${yy}" stroke="${stroke}" stroke-width="1"${extra || ''}/>`;
  }

  function vline(x, y0, y1, stroke, extra) {
    const xx = num(x);
    return `<line x1="${xx}" y1="${num(y0)}" x2="${xx}" y2="${num(y1)}" stroke="${stroke}" stroke-width="1"${extra || ''}/>`;
  }

  function pathD(points) {
    return points.map((q, i) => `${i ? 'L' : 'M'}${num(q.x)} ${num(q.y)}`).join('');
  }

  // ---------------------------------------------------------------- render

  /** Render session (+ optional notes) as an SVG string and return it with the plot layout. */
  function renderChart(session, notes, opts) {
    if (!session || typeof session !== 'object' || !session.window || typeof session.window !== 'object') {
      throw new TypeError('renderChart: a session with a window is required');
    }
    const o = options(opts);
    const T = THEMES[o.theme];
    const S = o.compact ? SIZES.compact : SIZES.regular;
    const W = o.width;
    const win = Core.displayWindow(session, notes || null);
    if (!(Number.isFinite(win.start) && Number.isFinite(win.end) && win.start < win.end)) {
      throw new TypeError('renderChart: the session window is invalid');
    }
    const span = win.end - win.start;
    const panels = buildPanels(session, win, o.theme);
    for (const p of panels) {
      p.plotH = p.hasData ? S.plotH : S.emptyH;
      p.scale = p.hasData ? yScaleFor(p.series, p.plotH) : null;
    }

    // Horizontal frame: the left margin grows when the widest y label needs it.
    let labelW = 0;
    for (const p of panels) {
      if (p.scale) for (const t of p.scale.ticks) labelW = Math.max(labelW, textWidth(tickText(t, p.scale.decimals), S.tickSize));
    }
    const left = Math.round(Math.max(S.left, labelW + S.tickGap + 6));
    const right = W - S.right;
    const plotW = right - left;
    const xOf = (t) => left + ((t - win.start) / span) * plotW;
    const contentX = o.compact ? S.contentPad : left;
    const contentW = W - contentX - 12;

    const sessionDate = typeof session.date === 'string' ? clean(session.date) : Core.kstDate(win.start);
    const md = /^\d{4}-(\d{2})-(\d{2})$/.exec(sessionDate);
    const rangeText = `${md ? `${+md[1]}/${+md[2]} ` : ''}${Core.kstTime(win.start)}~${Core.kstTime(win.end)} KST`;
    const titleText = `${clean(notes && notes.title) || DEFAULT_TITLE} (${rangeText})`;
    // The date-range unit wraps as one word (no-break spaces).
    const titleWrapText = `${clean(notes && notes.title) || DEFAULT_TITLE} (${rangeText.replace(/ /g, ' ')})`;
    const interval = Number.isInteger(session.intervalMinutes) && session.intervalMinutes > 0 ? session.intervalMinutes : 15;
    const subText = clean(notes && notes.subtitle) || `세로 점선 = 사건 시각 · ${interval}분봉`;

    const out = [];
    let y = S.padTop;

    // Header: title, subtitle.
    if (o.header) {
      const titleLines = wrap(titleWrapText, contentW, S.titleSize, true);
      titleLines.forEach((line, i) => {
        out.push(textEl(contentX, y + S.titleSize * 0.82 + i * S.titleLine, esc(line.replace(/ /g, ' ')),
          ` class="pc-title" font-size="${S.titleSize}" font-weight="700" fill="${T.title}"`));
      });
      y += S.titleSize * 0.82 + (titleLines.length - 1) * S.titleLine + 6;
      const subLines = wrap(subText, contentW, S.subSize, false);
      subLines.forEach((line, i) => {
        out.push(textEl(contentX, y + S.subSize + i * S.subLine, esc(line),
          ` class="pc-subtitle" font-size="${S.subSize}" fill="${T.muted}"`));
      });
      y += S.subSize + (subLines.length - 1) * S.subLine + S.headerGap;
    }

    // Event strip above the first panel: two-line labels staggered in up to 3 rows. Compact mode draws
    // numbered markers instead; so does regular mode when the labels cannot fit without overlapping,
    // and then a key under the markers lists the labels.
    const marks = eventMarks(Core.eventsInWindow(notes || null, win), win);
    if (marks.length) {
      let markers = o.compact;
      let boxes;
      let rows;
      if (!markers) {
        boxes = marks.map((m) => {
          const label = fit(m.label, S.eventMaxW, S.eventSize, false);
          const sub = fit(m.sub, S.eventMaxW, S.eventSize, false);
          const w = Math.max(textWidth(label, S.eventSize), textWidth(sub, S.eventSize));
          const half = w / 2;
          const c = clamp((xOf(m.a) + xOf(m.b)) / 2, 4 + half, W - 4 - half);
          return { m, cx: c, x0: c - half, x1: c + half, label, sub, nudge: Math.min(14, w * 0.25) };
        });
        rows = assignRows(boxes, MAX_EVENT_ROWS, S.eventGap, W - 4);
        markers = boxes.some((b) => b.clash);
      }
      if (markers) {
        boxes = marks.map((m) => {
          const cx = (xOf(m.a) + xOf(m.b)) / 2;
          return { m, cx, x0: cx - S.markerR, x1: cx + S.markerR };
        });
        rows = assignRows(boxes, MAX_EVENT_ROWS, 3, W - 4);
      }
      const rowH = markers ? S.markerRow : S.eventRow;
      const stripBottom = y + rows * rowH;
      const marker = (n, cx, cy, r) => `<circle cx="${num(cx)}" cy="${num(cy)}" r="${r}" fill="${T.markerBg}" stroke="${T.markerLine}" stroke-width="1"/>`
        + textEl(cx, cy + 3.6, String(n), ` font-size="10" font-weight="700" text-anchor="middle" fill="${T.markerText}"`);
      out.push('<g class="pc-events">');
      for (const box of boxes) {
        const rowBottom = stripBottom - box.row * rowH;
        const id = box.m.id ? ` data-event="${esc(box.m.id)}"` : '';
        if (markers) {
          out.push(`<g class="pc-marker"${id} data-n="${box.m.n}">${marker(box.m.n, box.cx, rowBottom - rowH / 2, S.markerR)}</g>`);
          continue;
        }
        const base2 = rowBottom - 6;
        const lines = box.sub ? [[box.label, base2 - S.eventLine], [box.sub, base2]] : [[box.label, base2]];
        out.push(`<g class="pc-event-label"${id}>${lines.map(([text, by]) => textEl(box.cx, by, esc(text),
          ` font-size="${S.eventSize}" text-anchor="middle" fill="${T.muted}"`)).join('')}</g>`);
      }
      y = stripBottom + S.stripGap;
      if (markers && !o.compact) {
        // Key: "(n) label sub" items wrapped across the width.
        const r = S.markerR - 1;
        let x = contentX;
        let rowTop = y;
        marks.forEach((m, i) => {
          const text = fit(m.sub ? `${m.label} ${m.sub}` : m.label, 320, S.eventSize, false);
          const w = 2 * r + 5 + textWidth(text, S.eventSize);
          if (i > 0 && x + w > W - 12) { x = contentX; rowTop += S.keyRow; }
          const id = m.id ? ` data-event="${esc(m.id)}"` : '';
          out.push(`<g class="pc-event-key"${id} data-n="${m.n}">${marker(m.n, x + r, rowTop + r, r)}`
            + `${textEl(x + 2 * r + 5, rowTop + r + S.eventSize * 0.36, esc(text), ` font-size="${S.eventSize}" fill="${T.muted}"`)}</g>`);
          x += w + S.legendItemGap;
        });
        y = rowTop + S.keyRow + S.stripGap;
      }
      out.push('</g>');
    }

    // Panels.
    const layoutPanels = [];
    // Hour ticks; windows shorter than 3 hours (custom notes.display) tick every 30 or 15 minutes.
    const tickStep = span >= 3 * HOUR ? HOUR : (span >= 1.5 * HOUR ? HOUR / 2 : HOUR / 4);
    const hourTicks = [];
    for (let t = Math.ceil(win.start / tickStep) * tickStep; t <= win.end; t += tickStep) hourTicks.push(t);
    const futureFrom = o.now !== null && o.now > win.start && o.now < win.end ? o.now : null;
    const desc = [];

    panels.forEach((p, index) => {
      const isLast = index === panels.length - 1;
      out.push(`<g class="pc-panel" data-panel="${esc(p.key)}">`);

      // Title + muted basis suffix.
      const titleY = y + S.panelTitle * 0.82;
      out.push(textEl(contentX, titleY,
        `<tspan font-size="${S.panelTitle}" font-weight="700" fill="${T.title}">${esc(p.title)}</tspan>`
        + `<tspan dx="6" font-size="${S.panelSuffix}" fill="${T.muted}">${esc(p.suffix)}</tspan>`,
        ' class="pc-panel-title"'));

      // Legend: sample line + label; compact adds the last value; series without points are muted.
      let legendY = titleY + S.legendGap;
      if (p.series.length) {
        let x = contentX;
        const maxX = W - 10;
        const items = p.series.map((s) => {
          const value = o.compact && s.last ? Core.formatPct(s.last.p) : '';
          const label = fit(s.label, contentW * 0.8, S.legendSize, false);
          const tail = s.pts.length ? '' : ` · ${NO_DATA}`;
          const w = S.legendSample + 6 + textWidth(label + tail, S.legendSize) + (value ? 4 + textWidth(value, S.legendSize, true) : 0);
          return { s, label, value, tail, w };
        });
        out.push('<g class="pc-legend">');
        items.forEach((it, i) => {
          if (i > 0 && x + it.w > maxX) { x = contentX; legendY += S.legendRow; }
          const ly = legendY - S.legendSize * 0.34;
          const faded = it.s.pts.length ? '' : ' opacity="0.4"';
          const body = it.s.pts.length
            ? `<tspan fill="${T.text2}">${esc(it.label)}</tspan>${it.value ? `<tspan dx="4" font-weight="700" fill="${T.text}">${esc(it.value)}</tspan>` : ''}`
            : `<tspan fill="${T.muted}">${esc(it.label + it.tail)}</tspan>`;
          out.push(`<g class="pc-legend-item" data-series="${esc(it.s.id)}">`
            + `<line x1="${num(x)}" y1="${num(ly)}" x2="${num(x + S.legendSample)}" y2="${num(ly)}" stroke="${it.s.color}" stroke-width="2.6" stroke-linecap="round"${faded}/>`
            + textEl(x + S.legendSample + 6, legendY, body, ` font-size="${S.legendSize}"`)
            + '</g>');
          x += it.w + S.legendItemGap;
        });
        out.push('</g>');
      }

      const top = Math.round(legendY + S.plotGap);
      const bottom = top + p.plotH;
      const sc = p.scale;
      const yOf = sc ? (v) => bottom - ((v - sc.min) / (sc.max - sc.min)) * p.plotH : null;

      // Grid, frame and y labels.
      out.push('<g class="pc-grid">');
      if (sc) {
        for (const t of sc.ticks) {
          if (t !== 0) out.push(hline(left, right, yOf(t), T.grid));
        }
        for (const t of sc.ticks) {
          out.push(textEl(left - S.tickGap, yOf(t) + S.tickSize * 0.35, esc(tickText(t, sc.decimals)),
            ` class="pc-ytick" font-size="${S.tickSize}" text-anchor="end" fill="${T.muted}"`));
        }
      }
      out.push('</g>');

      // Event bands, then the axis frame and zero line, then dashed event lines.
      out.push('<g class="pc-event-marks">');
      for (const m of marks) {
        if (!m.band) continue;
        // Snapped like the dashed edges so the fill starts and ends on them.
        const x0 = crisp(xOf(m.a));
        const x1 = crisp(xOf(m.b));
        out.push(`<rect class="pc-band" x="${num(x0)}" y="${top}" width="${num(Math.max(x1 - x0, 1))}" height="${p.plotH}" fill="${T.band}"${T.bandOpacity < 1 ? ` fill-opacity="${T.bandOpacity}"` : ''}/>`);
      }
      out.push('</g>');
      out.push(vline(crisp(left), top, bottom, T.axis, ' class="pc-axis"'));
      out.push(hline(left, right, bottom, T.axis, ' class="pc-axis"'));
      for (const t of hourTicks) out.push(vline(crisp(xOf(t)), bottom, bottom + 5, T.axis, ' class="pc-hour-tick"'));
      if (sc) out.push(hline(left, right, yOf(0), T.zero, ' class="pc-zero"'));
      out.push('<g class="pc-event-lines">');
      for (const m of marks) {
        const xs = m.band ? [m.aEdge ? m.a : null, m.bEdge ? m.b : null] : [m.a];
        for (const t of xs) {
          if (t === null) continue;
          out.push(vline(crisp(xOf(t)), top, bottom, T.event, ' class="pc-event-line" stroke-dasharray="3 3"'));
        }
      }
      out.push('</g>');
      if (futureFrom !== null) {
        const fx = crisp(xOf(futureFrom));
        out.push(`<rect class="pc-future" x="${num(fx)}" y="${top}" width="${num(right - fx)}" height="${p.plotH}" fill="${T.future}" fill-opacity="${T.futureOpacity}"/>`);
        out.push(vline(fx, top, bottom, T.faint, ' class="pc-now"'));
      }

      // Series: dashed gap connectors and solid runs; first series drawn last (on top).
      const withData = p.series.filter((s) => s.pts.length);
      if (sc) {
        out.push('<g class="pc-lines" fill="none" stroke-linejoin="round" stroke-linecap="round">');
        for (let k = withData.length - 1; k >= 0; k -= 1) {
          const s = withData[k];
          const pts = s.pts.map((q) => ({ x: xOf(q.t), y: yOf(q.p) }));
          const byT = new Map(s.pts.map((q, i) => [q, pts[i]]));
          for (const seg of Core.segments(s.pts)) {
            const xy = seg.points.map((q) => byT.get(q));
            if (seg.kind === 'gap') {
              out.push(`<path class="pc-gap" data-series="${esc(s.id)}" d="${pathD(xy)}" stroke="${s.color}" stroke-width="1.4" stroke-dasharray="4 4" opacity="0.55"/>`);
            } else if (xy.length === 1) {
              out.push(`<circle class="pc-point" data-series="${esc(s.id)}" cx="${num(xy[0].x)}" cy="${num(xy[0].y)}" r="2" fill="${s.color}" stroke="none"/>`);
            } else {
              out.push(`<path class="pc-series" data-series="${esc(s.id)}" d="${pathD(xy)}" stroke="${s.color}" stroke-width="2.2"/>`);
            }
          }
        }
        for (let k = withData.length - 1; k >= 0; k -= 1) {
          const s = withData[k];
          out.push(`<circle class="pc-end" data-series="${esc(s.id)}" cx="${num(xOf(s.last.t))}" cy="${num(yOf(s.last.p))}" r="3" fill="${s.color}" stroke="none"/>`);
        }
        out.push('</g>');
      } else {
        out.push(textEl((left + right) / 2, top + p.plotH / 2 + 5, NO_DATA,
          ` class="pc-empty" font-size="13" text-anchor="middle" fill="${T.muted}"`));
      }

      // Right labels at the last values, kept apart by layoutLabels.
      if (!o.compact && withData.length) {
        const placed = Core.layoutLabels(withData.map((s, i) => ({ key: i, y: yOf(s.last.p) })),
          { minGap: 17, top: top + 2, bottom: bottom - 2 });
        const lx = right + S.rightPad;
        out.push('<g class="pc-end-labels">');
        withData.forEach((s, i) => {
          const y0 = yOf(s.last.p);
          const y1 = placed.has(i) ? placed.get(i) : y0;
          const value = Core.formatPct(s.last.p);
          const room = W - lx - 6 - textWidth(` ${value}`, S.rightSize);
          const label = fit(s.label, Math.max(room, 24), S.rightSize, false);
          if (Math.abs(y1 - y0) > 3) {
            out.push(`<polyline class="pc-connector" points="${num(right + 2)},${num(y0)} ${num(lx - 3)},${num(y1)}" fill="none" stroke="${s.color}" stroke-width="1" opacity="0.8"/>`);
          }
          out.push(textEl(lx, y1 + S.rightSize * 0.35,
            `<tspan>${esc(label)}</tspan><tspan dx="5">${esc(value)}</tspan>`,
            ` class="pc-end-label" data-series="${esc(s.id)}" font-size="${S.rightSize}" fill="${T.text}"`));
        });
        out.push('</g>');
      }

      // Hour labels and the date line only under the last panel.
      let panelEnd = bottom;
      if (isLast) {
        const sample = textWidth('00:00', S.hourSize);
        const hourPx = (tickStep / span) * plotW;
        let every = 1;
        while (every < 12 && hourPx * every < sample + 10) every += 1;
        const hy = bottom + S.hourGap;
        out.push('<g class="pc-hours">');
        hourTicks.forEach((t, i) => {
          if (i % every) return;
          out.push(textEl(xOf(t), hy, esc(Core.kstTime(t)), ` class="pc-hour" font-size="${S.hourSize}" text-anchor="middle" fill="${T.muted}"`));
        });
        out.push('</g>');
        const dy = hy + S.dateGap;
        out.push(textEl((left + right) / 2, dy, esc(`${sessionDate} KST`),
          ` class="pc-date" font-size="${S.hourSize}" text-anchor="middle" fill="${T.muted}"`));
        panelEnd = dy;
      }
      out.push('</g>');

      layoutPanels.push({
        key: p.key, top, bottom,
        yMin: sc ? sc.min : null, yMax: sc ? sc.max : null, empty: !sc,
        series: p.series.map((s) => ({ id: s.id, color: s.color })),
      });
      desc.push(`${p.title}: ${p.series.length
        ? p.series.map((s) => `${s.label} ${s.last ? Core.formatPct(s.last.p) : NO_DATA}`).join(', ')
        : NO_DATA}`);
      y = isLast ? panelEnd : bottom + S.panelGap;
    });

    // Footer: basis and sources (header mode only; the page shows them in its caption).
    if (o.header) {
      const lines = wrap(FOOTER, contentW, S.footSize, false);
      lines.forEach((line, i) => {
        out.push(textEl(contentX, y + S.footGap + i * S.footLine, esc(line),
          ` class="pc-footer" font-size="${S.footSize}" fill="${T.muted}"`));
      });
      y += S.footGap + (lines.length - 1) * S.footLine;
    }

    const H = Math.ceil(y + S.padBottom);
    const titleId = `${o.prefix}-title`;
    const descId = `${o.prefix}-desc`;
    const descText = `${rangeText} 마지막 값. ${desc.join('. ')}.${marks.length ? ` 표시한 사건 ${marks.length}개.` : ''}`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"`
      + ` role="img" aria-labelledby="${titleId} ${descId}" font-family="${FONT}" class="parallel-chart">`
      + `<title id="${titleId}">${esc(titleText)}</title><desc id="${descId}">${esc(descText)}</desc>`
      + `<rect class="pc-bg" x="0" y="0" width="${W}" height="${H}" fill="${T.bg}"/>\n`
      + `${out.join('\n')}\n</svg>`;

    return {
      svg,
      layout: {
        width: W, height: H, left, right, start: win.start, end: win.end,
        panels: layoutPanels, compact: o.compact, theme: o.theme,
      },
    };
  }

  return { renderChart, THEMES, textWidth };
});
