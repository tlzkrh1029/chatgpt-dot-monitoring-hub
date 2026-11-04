/* Election results tab view. Reads data/election-results.json only and never writes.
 * Keeps the last valid data in memory when a later request fails.
 */
(function () {
  'use strict';
  const C = window.ElectionResults;
  const DATA_URL = 'data/election-results.json';
  const POLL_MS = 60 * 1000;
  const TIMEOUT_MS = 15 * 1000;
  const STALE_MS = 90 * 60 * 1000;
  const state = { data: null, office: 'senate', sel: null, error: '', loading: false, checkedAt: null };

  const PARTY = {
    D: { name: '민주', full: '민주당', solid: 'var(--d)', text: 'var(--d-text)', tint: 'var(--d-tint)', hold: 'var(--d-hold)' },
    R: { name: '공화', full: '공화당', solid: 'var(--r)', text: 'var(--r-text)', tint: 'var(--r-tint)', hold: 'var(--r-hold)' },
    I: { name: '무소속', full: '무소속', solid: 'var(--i)', text: 'var(--i-text)', tint: 'var(--i-tint)', hold: 'var(--i-tint)' },
    O: { name: '기타', full: '기타 정당', solid: 'var(--i)', text: 'var(--i-text)', tint: 'var(--i-tint)', hold: 'var(--i-tint)' },
    tie: { name: '동률', full: '동률', solid: 'var(--tie)', text: 'var(--text-2)', tint: '#232B36', hold: '#232B36' }
  };
  const OFFICE_LABEL = { senate: '상원', governor: '주지사' };
  const SENATE_LAYOUT = { radii: [110, 130, 150, 170, 190], counts: [15, 17, 20, 23, 25], dot: 15, ring: 2 };
  const HOUSE_LAYOUT = { radii: [80, 92.2, 104.4, 116.7, 128.9, 141.1, 153.3, 165.6, 177.8, 190], counts: [26, 30, 34, 38, 42, 45, 49, 53, 57, 61], dot: 8, ring: 1.5 };

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtInt = new Intl.NumberFormat('ko-KR');
  const fmtKst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function kst(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    const p = {};
    for (const part of fmtKst.formatToParts(d)) p[part.type] = part.value;
    return `${p.month}/${p.day} ${p.hour}:${p.minute} KST`;
  }
  const party = (p) => PARTY[p] || PARTY.tie;
  const ring = (color, width) => `inset 0 0 0 ${width}px ${color}`;

  function hemi(layout, cats) {
    const W = 400, H = 222, cx = 200, cy = 212, pts = [];
    layout.radii.forEach((r, i) => {
      const n = layout.counts[i];
      for (let j = 0; j < n; j++) {
        const th = Math.PI - j * Math.PI / (n - 1);
        pts.push({ th, x: cx + r * Math.cos(th), y: cy - r * Math.sin(th) });
      }
    });
    pts.sort((a, b) => b.th - a.th);
    const used = cats.reduce((s, c) => s + c.n, 0);
    const all = used < pts.length ? cats.concat({ n: pts.length - used, bg: 'transparent', sh: ring('#4A5566', layout.ring) }) : cats;
    const w = (layout.dot / W * 100).toFixed(2) + '%';
    let idx = 0, html = '';
    for (const c of all) {
      for (let k = 0; k < c.n && idx < pts.length; k++) {
        const p = pts[idx++];
        html += `<span style="left:${(p.x / W * 100).toFixed(2)}%;top:${(p.y / H * 100).toFixed(2)}%;width:${w};background:${c.bg};box-shadow:${c.sh || 'none'}"></span>`;
      }
    }
    return html + '<span class="tick"></span>';
  }

  function nums(items) {
    return `<div class="nums">${items.map((it, i) => `<div class="num${i === 1 ? ' mid' : i === 2 ? ' end' : ''}"><span class="lab">${esc(it.lab)}</span><span class="val" style="color:${it.color}">${esc(it.val)}</span></div>`).join('')}</div>`;
  }

  function controlLine(ctl, need, tieBreaker) {
    if (ctl) {
      const p = party(ctl.party);
      return `<p class="control">다수당: <strong style="color:${p.text}">${esc(p.full)}</strong> · ${esc(ctl.by)} 판단${ctl.at ? ` ${esc(kst(ctl.at))}` : ''}</p>`;
    }
    let line = `<p class="control">다수당까지 민주는 <strong style="color:${PARTY.D.text}">${need.D}석</strong>, 공화는 <strong style="color:${PARTY.R.text}">${need.R}석</strong>이 더 필요합니다.</p>`;
    if (tieBreaker && PARTY[tieBreaker]) line += `<p class="fine">50 대 50이면 부통령(${esc(PARTY[tieBreaker].name)})이 표결하므로 ${esc(PARTY[tieBreaker].full)}은 절반 의석으로도 다수당이 됩니다.</p>`;
    return line;
  }

  function senateCard(d) {
    const s = d.chambers.senate;
    const sum = C.senateSummary(d);
    const t = sum.tally;
    const caucus = s.independentsCaucus;
    const holdD = s.notUp.D + (caucus === 'D' ? s.notUp.I : 0);
    const holdR = s.notUp.R + (caucus === 'R' ? s.notUp.I : 0);
    const holdO = s.notUp.O + (caucus ? 0 : s.notUp.I);
    const notUp = s.notUp.D + s.notUp.R + s.notUp.I + s.notUp.O;
    const cats = [
      { n: holdD, bg: PARTY.D.hold },
      { n: t.called.D, bg: PARTY.D.solid },
      { n: t.leading.D, bg: 'transparent', sh: ring(PARTY.D.solid, 2) },
      { n: holdO + t.called.I + t.called.O, bg: PARTY.I.solid },
      { n: t.leading.I + t.leading.O + t.leading.tie + t.leading.none + t.unknown, bg: 'transparent', sh: ring('var(--tie)', 2) },
      { n: t.leading.R, bg: 'transparent', sh: ring(PARTY.R.solid, 2) },
      { n: t.called.R, bg: PARTY.R.solid },
      { n: holdR, bg: PARTY.R.hold }
    ];
    const dLab = caucus === 'D' && s.notUp.I ? `민주 · 무소속 ${s.notUp.I} 포함` : '민주';
    const rLab = caucus === 'R' && s.notUp.I ? `공화 · 무소속 ${s.notUp.I} 포함` : '공화';
    const aria = `상원 의석 반원도: 민주 ${sum.seats.D}석, 공화 ${sum.seats.R}석, 미판정 ${sum.seats.uncalled}석${sum.seats.other ? `, 기타 ${sum.seats.other}석` : ''}`;
    const fine = [];
    if (caucus && s.notUp.I) fine.push(`${PARTY[caucus].name} 의석에는 ${PARTY[caucus].full}과 함께하는 무소속 ${s.notUp.I}석을 포함합니다.`);
    fine.push(`이번에 선거가 없는 ${notUp}석과 이번 판정을 합친 수입니다.`);
    if (sum.seats.other) fine.push(`기타 ${sum.seats.other}석은 양당 어느 쪽에도 넣지 않았습니다.`);
    return `<div class="card-head"><h3>상원</h3><p>${s.seats}석 중 ${C.SENATE_STATES.length}석 선거 · 과반 ${s.majority}석</p></div>
      <div class="hemi" role="img" aria-label="${esc(aria)}">${hemi(SENATE_LAYOUT, cats)}</div>
      ${nums([{ lab: dLab, val: sum.seats.D, color: PARTY.D.text }, { lab: '미판정', val: sum.seats.uncalled, color: 'var(--text)' }, { lab: rLab, val: sum.seats.R, color: PARTY.R.text }])}
      ${controlLine(s.control, sum.need, s.tieBreaker)}
      <p class="fine">${esc(fine.join(' '))}</p>
      <div class="legend"><span><i class="sw" style="background:var(--d)"></i><i class="sw" style="background:var(--r)"></i>판정</span><span><i class="sw ring-d"></i><i class="sw ring-r"></i>앞섬 · 미판정</span><span><i class="sw ring-t"></i>동률 · 확인 중</span><span><i class="sw" style="background:var(--d-hold)"></i><i class="sw" style="background:var(--r-hold)"></i>이번 선거 없음</span><span><i class="sw line"></i>과반선</span></div>`;
  }

  function houseCard(d) {
    const h = d.chambers.house;
    const sum = C.houseSummary(d);
    const cats = [
      { n: h.totals.D, bg: PARTY.D.solid },
      { n: h.totals.I + h.totals.O, bg: PARTY.I.solid },
      { n: h.totals.uncalled, bg: 'transparent', sh: ring('var(--tie)', 1.5) },
      { n: h.totals.R, bg: PARTY.R.solid }
    ];
    const aria = `하원 의석 반원도: 민주 ${sum.seats.D}석, 공화 ${sum.seats.R}석, 미판정 ${sum.seats.uncalled}석${sum.seats.other ? `, 기타 ${sum.seats.other}석` : ''}`;
    const fine = [`의석 수는 ${d.provider} 판단 합계이며, 하원은 선거구별 결과 대신 의석 합계만 표시합니다.`];
    if (h.flips) fine.push(`정당이 바뀐 의석은 민주 ${h.flips.D}석, 공화 ${h.flips.R}석입니다.`);
    return `<div class="card-head"><h3>하원</h3><p>${h.seats}석 전체 선거 · 과반 ${h.majority}석</p></div>
      <div class="hemi" role="img" aria-label="${esc(aria)}">${hemi(HOUSE_LAYOUT, cats)}</div>
      ${nums([{ lab: '민주', val: sum.seats.D, color: PARTY.D.text }, { lab: '미판정', val: sum.seats.uncalled, color: 'var(--text)' }, { lab: '공화', val: sum.seats.R, color: PARTY.R.text }])}
      ${controlLine(h.control, sum.need, null)}
      <p class="fine">${esc(fine.join(' '))}</p>
      <div class="legend"><span><i class="sw" style="background:var(--d)"></i><i class="sw" style="background:var(--r)"></i>판정</span><span><i class="sw ring-t"></i>미판정</span><span><i class="sw line"></i>과반선</span></div>`;
  }

  function margin(r) {
    const cs = r.candidates.slice().sort((a, b) => ((b.votes ?? -1) - (a.votes ?? -1)) || ((b.pct ?? -1) - (a.pct ?? -1)));
    const [a, b] = cs;
    if (!a || !b) return null;
    const votes = a.votes !== null && b.votes !== null ? Math.abs(a.votes - b.votes) : null;
    let pp = null, basis = '';
    if (a.pct !== null && b.pct !== null) { pp = Math.abs(a.pct - b.pct); basis = '득표율 차이'; }
    else if (votes !== null && a.votes + b.votes > 0) { pp = votes / (a.votes + b.votes) * 100; basis = '두 후보 표 기준'; }
    return { votes, pp, basis };
  }
  function marginText(m) {
    if (!m) return '미확인';
    const parts = [];
    if (m.votes !== null) parts.push(`${fmtInt.format(m.votes)}표`);
    if (m.pp !== null) parts.push(`${m.pp.toFixed(1)}%p`);
    return parts.join(' · ') || '미확인';
  }
  function leaderOf(r) { return r.leader === null ? null : r.leader; }

  function tileFor(code, r, sel, office) {
    const name = C.STATE_NAMES[code] || code;
    const t = { bg: '#10141A', bd: '1px solid #222A35', fg: 'var(--muted-2)', sub: '', subFg: 'var(--muted-2)', bar: null, label: `${name}, ${OFFICE_LABEL[office]} 선거 없음` };
    if (r) {
      if (r.status === 'called') {
        const p = party(r.winner.party);
        Object.assign(t, { bg: p.solid, bd: '1px solid transparent', fg: '#FFFFFF', sub: `${p.name} 판정`, subFg: '#FFFFFF', label: `${name}, ${p.name} 판정, ${r.winner.name}` });
      } else if (r.status === 'unknown') {
        Object.assign(t, { bg: '#141A22', bd: '1.5px dotted #6B7686', fg: 'var(--text-2)', sub: '확인 중', subFg: 'var(--muted)', label: `${name}, 판정 확인 중` });
      } else {
        const lead = leaderOf(r);
        const p = party(lead || 'tie');
        const m = margin(r);
        const sub = r.status === 'runoff' ? '결선' : lead === null ? '미판정' : lead === 'tie' ? '동률' : `${p.name} +${m && m.pp !== null ? m.pp.toFixed(1) : '?'}`;
        Object.assign(t, { bg: p.tint, bd: `1.5px dashed ${p.solid}`, fg: 'var(--text-strong)', sub, subFg: p.text, bar: r.reported, label: `${name}, ${r.status === 'runoff' ? '결선' : '미판정'}${lead && lead !== 'tie' ? `, ${p.name} 앞섬` : ''}${m ? `, 격차 ${marginText(m)}` : ''}${r.reported !== null ? `, 개표 ${r.reported}%` : ''}` });
      }
    }
    const on = code === sel;
    const pos = C.TILE_POSITIONS[code];
    return `<button type="button" class="tile" data-sel="${code}" aria-pressed="${on}" aria-label="${esc(t.label)}" style="grid-column:${pos[0] + 1};grid-row:${pos[1] + 1};background:${t.bg};border:${t.bd};color:${t.fg}"><span class="code">${code}</span><span class="tsub" style="color:${t.subFg}">${esc(t.sub)}</span>${t.bar !== null && t.bar !== undefined ? `<span class="bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, t.bar))}%"></i></span>` : ''}</button>`;
  }

  function detailHtml(d, office, sel) {
    const races = d.races[office];
    const r = races[sel];
    const name = C.STATE_NAMES[sel] || sel;
    const label = OFFICE_LABEL[office];
    const rows = [];
    let officeLine = r ? `${label}${r.special ? ' 보궐' : ''} 선거` : `${label} 선거 없음`;
    let note = '';
    if (!r) note = `이 주는 이번에 ${label} 선거가 없습니다.`;
    else if (r.status === 'called') {
      const p = party(r.winner.party);
      rows.push(['상태', `${p.name} 판정`, p.text], ['당선', r.winner.name, 'var(--text-strong)'], ['판정 주체', r.calledBy, 'var(--text-strong)']);
      if (r.calledAt) rows.push(['판정 시각', kst(r.calledAt), 'var(--text-strong)']);
      note = r.note || '판정은 언론의 당선 판단이며 공식 인증과 다릅니다.';
    } else if (r.status === 'unknown') {
      rows.push(['상태', '판정 확인 중', 'var(--text-strong)']);
      note = r.note || '이 경합의 개별 판정을 아직 확인하지 못했습니다.';
    } else {
      const lead = leaderOf(r);
      const m = margin(r);
      rows.push(['상태', r.status === 'runoff' ? '결선' : '미판정', 'var(--text-strong)']);
      if (lead) rows.push(['앞선 쪽', party(lead).name, party(lead).text]);
      rows.push(['격차', marginText(m), 'var(--text-strong)']);
      for (const c of r.candidates) {
        const v = [c.votes !== null ? `${fmtInt.format(c.votes)}표` : '', c.pct !== null ? `${c.pct}%` : ''].filter(Boolean).join(' · ') || '집계 미확인';
        rows.push([`${c.name} (${party(c.party).name})`, v, party(c.party).text]);
      }
      if (r.reported !== null) rows.push(['개표율', `${r.reported}%`, 'var(--text-strong)']);
      note = [r.note, '앞서 있어도 판정 전에는 승자로 표시하지 않습니다.'].filter(Boolean).join(' ');
    }
    if (r) for (const c of r.otherCalls) rows.push([`${c.by} 판단`, `${c.name} (${party(c.party).name})`, party(c.party).text]);
    return `<p class="lab">선택한 주</p><h3>${esc(sel)} · ${esc(name)}</h3><p class="office">${esc(officeLine)}</p>
      <dl>${rows.map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd style="color:${c}">${esc(v)}</dd></div>`).join('')}</dl>
      <p class="note">${esc(note)}</p>`;
  }

  function openRaces(races) {
    return Object.keys(races).filter((k) => races[k].status === 'uncalled' || races[k].status === 'runoff').map((k) => {
      const r = races[k];
      const m = margin(r);
      const lead = leaderOf(r);
      const sign = lead === 'D' ? -1 : lead === 'R' ? 1 : 0;
      const x = m && m.pp !== null ? Math.max(6, Math.min(94, 50 + sign * m.pp * 42 / 8)) : 50;
      return { code: k, r, m, lead, x };
    });
  }

  function plotHtml(items, sel) {
    if (!items.length) return '<span class="axis"></span><span class="mid"></span><p class="empty">남은 미판정 경합이 없습니다.</p>';
    const AX = 120, HALF = 22, lanes = [72, 168, 24, 216], last = [-99, -99, -99, -99];
    let html = '<span class="axis"></span><span class="mid"></span>';
    for (const x of [8, 29, 50, 71, 92]) html += `<span class="mark" style="left:${x}%"></span>`;
    for (const it of items.slice().sort((a, b) => a.x - b.x)) {
      let lane = lanes.findIndex((_, i) => it.x - last[i] >= 9);
      if (lane < 0) lane = last.indexOf(Math.min(...last));
      last[lane] = it.x;
      const ly = lanes[lane], above = ly < AX;
      const p = party(it.lead || 'tie');
      const on = it.code === sel;
      const top = above ? ly + HALF : AX + 8;
      const h = above ? (AX - 8) - (ly + HALF) : (ly - HALF) - (AX + 8);
      const l1 = it.lead && it.lead !== 'tie' ? `${p.name} +${it.m && it.m.pp !== null ? it.m.pp.toFixed(1) : '?'}` : it.lead === 'tie' ? '동률' : '격차 미확인';
      const l2 = it.r.reported !== null ? `개표 ${it.r.reported}%` : it.m && it.m.votes !== null ? `${fmtInt.format(it.m.votes)}표 차` : '';
      html += `<span class="lead" style="left:${it.x}%;top:${top}px;height:${h}px"></span>`;
      html += `<span class="dot" style="left:${it.x}%;border-color:${p.solid};background:${on ? p.solid : 'var(--panel)'}"></span>`;
      html += `<button type="button" class="lbl" data-sel="${it.code}" aria-pressed="${on}" style="left:${it.x}%;top:${ly - HALF}px" aria-label="${esc(`${C.STATE_NAMES[it.code]}, ${l1}${l2 ? `, ${l2}` : ''}`)}"><span class="l1">${it.code} <span style="color:${p.text}">${esc(l1)}</span></span>${l2 ? `<span class="l2">${esc(l2)}</span>` : ''}</button>`;
    }
    return html;
  }

  function rowsHtml(items, sel) {
    if (!items.length) return '<p class="none">남은 미판정 경합이 없습니다.</p>';
    const sorted = items.slice().sort((a, b) => ((a.m && a.m.pp !== null) ? a.m.pp : 999) - ((b.m && b.m.pp !== null) ? b.m.pp : 999));
    return '<div class="head" aria-hidden="true"><span>주</span><span>앞선 쪽</span><span class="r">격차</span><span>개표율</span></div>' + sorted.map((it) => {
      const p = party(it.lead || 'tie');
      const lead = it.lead === null ? '미확인' : p.name;
      const rep = it.r.reported;
      return `<button type="button" data-sel="${it.code}" aria-pressed="${it.code === sel}"><span class="st"><b>${it.code}</b> <span>${esc(C.STATE_NAMES[it.code])}${it.r.special ? ' · 보궐' : ''}</span></span><span style="color:${p.text};font-weight:600">${esc(lead)}</span><span class="r">${esc(marginText(it.m))}</span><span class="rep">${rep !== null ? `<i aria-hidden="true"><b style="width:${rep}%"></b></i><span>${rep}%</span>` : '<span>미확인</span>'}</span></button>`;
    }).join('');
  }

  function defaultSel(races) {
    const open = openRaces(races).sort((a, b) => ((a.m && a.m.pp !== null) ? a.m.pp : 999) - ((b.m && b.m.pp !== null) ? b.m.pp : 999));
    if (open.length) return open[0].code;
    return Object.keys(races)[0] || 'GA';
  }

  function render() {
    const d = state.data;
    const status = $('fetch-status');
    if (!d) {
      status.textContent = state.error ? `게시 자료를 읽지 못했습니다: ${state.error}` : '게시 자료를 불러오는 중입니다.';
      status.dataset.error = state.error ? 'true' : 'false';
      return;
    }
    const active = document.activeElement;
    const focusKey = active && active.dataset && active.dataset.sel ? { box: active.closest('[id]') && active.closest('[id]').id, sel: active.dataset.sel } : null;

    const races = d.races[state.office];
    if (!state.sel) state.sel = defaultSel(races);
    const stale = Date.now() - Date.parse(d.observedAt) > STALE_MS;
    const checked = state.checkedAt ? kst(state.checkedAt) : '';
    status.dataset.error = state.error || stale ? 'true' : 'false';
    status.textContent = state.error
      ? `최신 게시 자료를 읽지 못해 마지막 정상 자료를 표시합니다 (${state.error}).`
      : `게시 자료 확인 ${checked} · 60초마다 다시 확인합니다.${stale ? ' 판정 확인 시각이 90분 넘게 지났습니다.' : ''}`;

    $('top-chips').innerHTML = [
      d.checkStatus !== 'ok' ? `<span class="chip warn">${d.checkStatus === 'partial' ? '일부 확인' : '원문 확인 실패'}</span>` : '',
      `<span class="chip">판정 확인 <strong class="mono">${esc(kst(d.observedAt))}</strong></span>`,
      `<span class="chip">판정 기준 <strong>${esc(d.provider)}</strong></span>`
    ].join('');
    const notice = $('notice');
    notice.textContent = d.note;
    notice.hidden = !d.note;
    const asof = `${d.provider} 기준 · 판정 확인 ${kst(d.observedAt)}`;
    $('asof-map').textContent = asof;
    $('asof-close').textContent = asof;

    $('card-senate').innerHTML = senateCard(d);
    $('card-house').innerHTML = houseCard(d);

    document.querySelectorAll('[data-office]').forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute('data-office') === state.office)));
    const t = C.tally(races);
    const label = OFFICE_LABEL[state.office];
    const pills = [
      `<span class="pill">${label} 선거 <b>${Object.keys(races).length}</b>곳</span>`,
      `<span class="pill" style="color:${PARTY.D.text}">민주 판정 <b>${t.called.D}</b></span>`,
      `<span class="pill" style="color:${PARTY.R.text}">공화 판정 <b>${t.called.R}</b></span>`,
      t.called.I + t.called.O ? `<span class="pill" style="color:${PARTY.I.text}">기타 판정 <b>${t.called.I + t.called.O}</b></span>` : '',
      `<span class="pill">미판정 <b>${t.uncalled}</b></span>`,
      t.unknown ? `<span class="pill">확인 중 <b>${t.unknown}</b></span>` : ''
    ];
    const g = d.chambers.governor;
    if (state.office === 'governor' && g.totals) pills.push(`<span class="pill wide">${esc(d.provider)} 합계(현직 포함) 민주 <b>${g.totals.D}</b> · 공화 <b>${g.totals.R}</b> · 미판정 <b>${g.totals.uncalled}</b></span>`);
    $('map-pills').innerHTML = pills.join('');
    const codes = Object.keys(C.TILE_POSITIONS).sort((a, b) => C.TILE_POSITIONS[a][1] - C.TILE_POSITIONS[b][1] || C.TILE_POSITIONS[a][0] - C.TILE_POSITIONS[b][0]);
    $('tiles').innerHTML = codes.map((code) => tileFor(code, races[code], state.sel, state.office)).join('');
    $('detail').innerHTML = detailHtml(d, state.office, state.sel);

    const items = openRaces(races);
    $('close-sub').textContent = `${label} 미판정 ${items.length}곳 · 가운데 점선에 가까울수록 접전입니다`;
    $('plot').innerHTML = plotHtml(items, state.sel);
    $('rows').innerHTML = rowsHtml(items, state.sel);

    const notUp = Object.values(d.chambers.senate.notUp).reduce((a, b) => a + b, 0);
    $('foot').innerHTML = `<p>판정은 언론사의 당선 판단이며 공식 인증과 다릅니다. ${esc(d.provider)} 판단을 우선하고, 다른 언론의 판단은 경합마다 판정 주체를 표기합니다. 앞선 후보는 승자로 칠하지 않습니다.</p>
      <p>개표율은 제공자가 추정한 전체 예상 투표수 대비 집계 비율입니다. 격차의 %p는 득표율 차이이며, 득표율이 없으면 두 후보의 표만으로 계산합니다.</p>
      <p>상원 의석 수에는 이번에 선거가 없는 ${notUp}석을 포함합니다. 게시 ${esc(kst(d.publishedAt))} · 판정 확인 ${esc(kst(d.observedAt))}.</p>
      <details><summary>출처 ${d.sources.length}개</summary><ul>${d.sources.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u.replace(/^https:\/\//, ''))}</a></li>`).join('')}</ul></details>`;

    if (focusKey && focusKey.box) {
      const box = $(focusKey.box);
      const el = box && box.querySelector(`[data-sel="${focusKey.sel}"]`);
      if (el) el.focus({ preventScroll: true });
    }
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetch(`${DATA_URL}?ts=${Date.now()}`, { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = C.validateDataset(await res.json());
      state.error = '';
      state.checkedAt = new Date().toISOString();
    } catch (e) {
      state.error = e && e.name === 'AbortError' ? '응답 시간 초과' : (e && e.message) || '알 수 없는 오류';
    } finally {
      if (timer) clearTimeout(timer);
      state.loading = false;
      render();
    }
  }

  document.addEventListener('click', (ev) => {
    const office = ev.target.closest('[data-office]');
    if (office) {
      const next = office.getAttribute('data-office');
      if (next !== state.office) {
        state.office = next;
        if (state.data && !state.data.races[next][state.sel]) state.sel = defaultSel(state.data.races[next]);
        render();
      }
      return;
    }
    const pick = ev.target.closest('[data-sel]');
    if (pick) {
      state.sel = pick.getAttribute('data-sel');
      render();
    }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  load();
  setInterval(load, POLL_MS);
})();
