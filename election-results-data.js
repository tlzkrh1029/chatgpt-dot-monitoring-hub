/* Election results tab contract (data/election-results.json).
 * Independent from the five category contracts and the parallel contract.
 * Only the election monitoring task writes this file; the page only reads it.
 * A race is "called" only when a named outlet made a call. Leading is not winning.
 */
(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports
    ? require('./public-data.js') : root.MonitorData);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ElectionResults = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (publicContract) {
  'use strict';
  const MINUTE = 60000;
  const CLOCK_SKEW_MS = 5 * MINUTE;
  const PARTIES = Object.freeze(['D', 'R', 'I', 'O']);
  const LEADERS = Object.freeze(['D', 'R', 'I', 'O', 'tie']);
  const STATUSES = Object.freeze(['called', 'uncalled', 'runoff', 'unknown']);
  const CHECK_STATUSES = Object.freeze(['ok', 'partial', 'error']);
  const SENATE_STATES = Object.freeze(['AL', 'AK', 'AR', 'CO', 'DE', 'FL', 'GA', 'ID', 'IL', 'IA', 'KS', 'KY', 'LA', 'ME', 'MA', 'MI', 'MN', 'MS', 'MT', 'NE', 'NH', 'NJ', 'NM', 'NC', 'OH', 'OK', 'OR', 'RI', 'SC', 'SD', 'TN', 'TX', 'VA', 'WV', 'WY']);
  const GOVERNOR_STATES = Object.freeze(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'FL', 'GA', 'HI', 'ID', 'IL', 'IA', 'KS', 'ME', 'MD', 'MA', 'MI', 'MN', 'NE', 'NV', 'NH', 'NM', 'NY', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'VT', 'WI', 'WY']);
  const STATE_NAMES = Object.freeze({
    AL: '앨라배마', AK: '알래스카', AZ: '애리조나', AR: '아칸소', CA: '캘리포니아', CO: '콜로라도', CT: '코네티컷', DE: '델라웨어', FL: '플로리다', GA: '조지아',
    HI: '하와이', ID: '아이다호', IL: '일리노이', IN: '인디애나', IA: '아이오와', KS: '캔자스', KY: '켄터키', LA: '루이지애나', ME: '메인', MD: '메릴랜드',
    MA: '매사추세츠', MI: '미시간', MN: '미네소타', MS: '미시시피', MO: '미주리', MT: '몬태나', NE: '네브래스카', NV: '네바다', NH: '뉴햄프셔', NJ: '뉴저지',
    NM: '뉴멕시코', NY: '뉴욕', NC: '노스캐롤라이나', ND: '노스다코타', OH: '오하이오', OK: '오클라호마', OR: '오리건', PA: '펜실베이니아', RI: '로드아일랜드', SC: '사우스캐롤라이나',
    SD: '사우스다코타', TN: '테네시', TX: '텍사스', UT: '유타', VT: '버몬트', VA: '버지니아', WA: '워싱턴', WV: '웨스트버지니아', WI: '위스콘신', WY: '와이오밍'
  });
  // Equal-size tile grid (column, row), 11 x 8. Area does not encode anything.
  const TILE_POSITIONS = Object.freeze({
    AK: [0, 0], ME: [10, 0], WI: [5, 1], VT: [9, 1], NH: [10, 1], WA: [0, 2], ID: [1, 2], MT: [2, 2], ND: [3, 2], MN: [4, 2], IL: [5, 2], MI: [6, 2], NY: [8, 2], MA: [9, 2],
    OR: [0, 3], NV: [1, 3], WY: [2, 3], SD: [3, 3], IA: [4, 3], IN: [5, 3], OH: [6, 3], PA: [7, 3], NJ: [8, 3], CT: [9, 3], RI: [10, 3],
    CA: [0, 4], UT: [1, 4], CO: [2, 4], NE: [3, 4], MO: [4, 4], KY: [5, 4], WV: [6, 4], VA: [7, 4], MD: [8, 4], DE: [9, 4],
    AZ: [1, 5], NM: [2, 5], KS: [3, 5], AR: [4, 5], TN: [5, 5], NC: [6, 5], SC: [7, 5], OK: [3, 6], LA: [4, 6], MS: [5, 6], AL: [6, 6], GA: [7, 6],
    HI: [0, 7], TX: [3, 7], FL: [8, 7]
  });

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function fail(path, reason) { throw new Error(`${path}: ${reason}`); }
  function object(v, path, fields) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(path, 'expected a plain object');
    for (const k of Object.keys(v)) if (!fields.includes(k)) fail(path, `unrecognized field ${k}`);
    for (const k of fields) if (!own(v, k)) fail(`${path}.${k}`, 'required field missing');
  }
  function text(v, path, max, allowEmpty = false) {
    if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim())) fail(path, 'expected bounded plain text');
    if (/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:[a-z0-9-]+\.)?notion\.(?:so|site|com)\b)/i.test(v) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(v)) fail(path, 'links or contact details are not allowed in prose');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail(path, 'control characters are not allowed');
    if (/(?:\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+)/i.test(v)) fail(path, 'possible credentials are not allowed');
    return v;
  }
  function list(v, path, max) {
    if (!Array.isArray(v) || v.length > max) fail(path, 'expected a bounded array');
  }
  function count(v, path, max) {
    if (!Number.isInteger(v) || v < 0 || v > max) fail(path, 'expected a non-negative integer');
    return v;
  }
  function percent(v, path) {
    if (v === null) return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) fail(path, 'expected a percentage from 0 to 100 or null');
    return v;
  }
  function party(v, path, allowed = PARTIES) {
    if (!allowed.includes(v)) fail(path, `expected one of ${allowed.join(', ')}`);
    return v;
  }
  function nowValue(now) {
    const n = now === undefined ? Date.now() : Number(new Date(now));
    if (!Number.isFinite(n)) fail('now', 'invalid clock');
    return n;
  }
  function date(v, path, now) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v)) fail(path, 'expected an ISO UTC timestamp');
    const n = Date.parse(v);
    if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 19) !== v.slice(0, 19)) fail(path, 'invalid timestamp');
    if (n > now + CLOCK_SKEW_MS) fail(path, 'timestamp is in the future');
    return n;
  }
  function partyCounts(v, path, max) {
    object(v, path, PARTIES);
    let sum = 0;
    for (const p of PARTIES) sum += count(v[p], `${path}.${p}`, max);
    return sum;
  }
  function control(v, path, now, published) {
    if (v === null) return;
    object(v, path, ['party', 'by', 'at']);
    party(v.party, `${path}.party`);
    text(v.by, `${path}.by`, 40);
    if (v.at !== null && date(v.at, `${path}.at`, now) > published) fail(`${path}.at`, 'call is newer than publication');
  }
  function totals(v, path, seats) {
    object(v, path, PARTIES.concat('uncalled'));
    let sum = count(v.uncalled, `${path}.uncalled`, seats);
    for (const p of PARTIES) sum += count(v[p], `${path}.${p}`, seats);
    if (sum !== seats) fail(path, `party seats and uncalled seats must add up to ${seats}`);
  }
  function race(r, path, now, published) {
    object(r, path, ['status', 'special', 'winner', 'calledBy', 'calledAt', 'leader', 'candidates', 'reported', 'otherCalls', 'note']);
    if (!STATUSES.includes(r.status)) fail(`${path}.status`, 'unknown status');
    if (typeof r.special !== 'boolean') fail(`${path}.special`, 'expected true or false');
    if (r.status === 'called') {
      object(r.winner, `${path}.winner`, ['name', 'party']);
      text(r.winner.name, `${path}.winner.name`, 80);
      party(r.winner.party, `${path}.winner.party`);
      text(r.calledBy, `${path}.calledBy`, 40);
      if (r.leader !== null) fail(`${path}.leader`, 'a called race has a winner, not a leader');
    } else {
      if (r.winner !== null) fail(`${path}.winner`, 'only a called race may have a winner');
      if (r.calledBy !== null || r.calledAt !== null) fail(`${path}.calledBy`, 'only a called race may carry a call');
      if (r.leader !== null) {
        if (r.status === 'unknown') fail(`${path}.leader`, 'an unverified race has no leader');
        party(r.leader, `${path}.leader`, LEADERS);
      }
    }
    if (r.calledAt !== null && date(r.calledAt, `${path}.calledAt`, now) > published) fail(`${path}.calledAt`, 'call is newer than publication');
    list(r.candidates, `${path}.candidates`, 4);
    r.candidates.forEach((c, i) => {
      const cp = `${path}.candidates[${i}]`;
      object(c, cp, ['name', 'party', 'votes', 'pct']);
      text(c.name, `${cp}.name`, 80);
      party(c.party, `${cp}.party`);
      if (c.votes !== null) count(c.votes, `${cp}.votes`, 100000000);
      percent(c.pct, `${cp}.pct`);
    });
    percent(r.reported, `${path}.reported`);
    list(r.otherCalls, `${path}.otherCalls`, 3);
    r.otherCalls.forEach((c, i) => {
      const cp = `${path}.otherCalls[${i}]`;
      object(c, cp, ['by', 'party', 'name']);
      text(c.by, `${cp}.by`, 40);
      party(c.party, `${cp}.party`);
      text(c.name, `${cp}.name`, 80);
    });
    text(r.note, `${path}.note`, 300, true);
  }
  function raceSet(v, path, states, now, published) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(path, 'expected an object keyed by state');
    for (const k of Object.keys(v)) if (!states.includes(k)) fail(path, `unexpected state ${k}`);
    for (const k of states) {
      if (!own(v, k)) fail(`${path}.${k}`, 'required state missing');
      race(v[k], `${path}.${k}`, now, published);
    }
  }

  function validateDataset(raw, options = {}) {
    const now = nowValue(options.now);
    object(raw, 'results', ['schemaVersion', 'kind', 'provider', 'publishedAt', 'observedAt', 'checkStatus', 'note', 'chambers', 'races', 'sources']);
    if (raw.schemaVersion !== 1) fail('results.schemaVersion', 'unsupported schema version');
    if (raw.kind !== 'election-results') fail('results.kind', 'expected election-results');
    text(raw.provider, 'results.provider', 40);
    const published = date(raw.publishedAt, 'results.publishedAt', now);
    const observed = date(raw.observedAt, 'results.observedAt', now);
    if (observed > published) fail('results.observedAt', 'observation is newer than publication');
    if (!CHECK_STATUSES.includes(raw.checkStatus)) fail('results.checkStatus', 'expected ok, partial or error');
    text(raw.note, 'results.note', 1000, raw.checkStatus === 'ok');

    object(raw.chambers, 'results.chambers', ['senate', 'house', 'governor']);
    const s = raw.chambers.senate;
    object(s, 'results.chambers.senate', ['seats', 'majority', 'tieBreaker', 'notUp', 'independentsCaucus', 'control']);
    count(s.seats, 'results.chambers.senate.seats', 1000);
    count(s.majority, 'results.chambers.senate.majority', s.seats);
    if (s.tieBreaker !== null) party(s.tieBreaker, 'results.chambers.senate.tieBreaker');
    if (partyCounts(s.notUp, 'results.chambers.senate.notUp', s.seats) + SENATE_STATES.length !== s.seats) fail('results.chambers.senate.notUp', `seats not up plus ${SENATE_STATES.length} races must equal the chamber size`);
    if (s.independentsCaucus !== null) party(s.independentsCaucus, 'results.chambers.senate.independentsCaucus', ['D', 'R']);
    control(s.control, 'results.chambers.senate.control', now, published);

    const h = raw.chambers.house;
    object(h, 'results.chambers.house', ['seats', 'majority', 'totals', 'flips', 'control']);
    count(h.seats, 'results.chambers.house.seats', 1000);
    count(h.majority, 'results.chambers.house.majority', h.seats);
    totals(h.totals, 'results.chambers.house.totals', h.seats);
    if (h.flips !== null) {
      object(h.flips, 'results.chambers.house.flips', ['D', 'R']);
      count(h.flips.D, 'results.chambers.house.flips.D', h.seats);
      count(h.flips.R, 'results.chambers.house.flips.R', h.seats);
    }
    control(h.control, 'results.chambers.house.control', now, published);

    const g = raw.chambers.governor;
    object(g, 'results.chambers.governor', ['states', 'notUp', 'totals']);
    count(g.states, 'results.chambers.governor.states', 100);
    if (partyCounts(g.notUp, 'results.chambers.governor.notUp', g.states) + GOVERNOR_STATES.length !== g.states) fail('results.chambers.governor.notUp', `governors not up plus ${GOVERNOR_STATES.length} races must equal the number of states`);
    if (g.totals !== null) totals(g.totals, 'results.chambers.governor.totals', g.states);

    object(raw.races, 'results.races', ['senate', 'governor']);
    raceSet(raw.races.senate, 'results.races.senate', SENATE_STATES, now, published);
    raceSet(raw.races.governor, 'results.races.governor', GOVERNOR_STATES, now, published);

    list(raw.sources, 'results.sources', 24);
    raw.sources.forEach((u, i) => publicContract.publicUrl(u, `results.sources[${i}]`));
    return clone(raw);
  }

  function tally(races) {
    const t = { called: { D: 0, R: 0, I: 0, O: 0 }, leading: { D: 0, R: 0, I: 0, O: 0, tie: 0, none: 0 }, runoff: 0, unknown: 0, uncalled: 0 };
    for (const k of Object.keys(races)) {
      const r = races[k];
      if (r.status === 'called') t.called[r.winner.party]++;
      else if (r.status === 'unknown') t.unknown++;
      else {
        t.uncalled++;
        if (r.status === 'runoff') t.runoff++;
        t.leading[r.leader === null ? 'none' : r.leader]++;
      }
    }
    return t;
  }
  // Seat math for the Senate: seats not up plus this year's calls.
  // Independents caucusing with a party count toward that party's majority.
  function senateSummary(data) {
    const s = data.chambers.senate;
    const t = tally(data.races.senate);
    const caucusI = s.independentsCaucus ? s.notUp.I : 0;
    const seats = {
      D: s.notUp.D + t.called.D + (s.independentsCaucus === 'D' ? caucusI : 0),
      R: s.notUp.R + t.called.R + (s.independentsCaucus === 'R' ? caucusI : 0),
      other: s.notUp.O + (s.independentsCaucus ? 0 : s.notUp.I) + t.called.I + t.called.O,
      uncalled: t.uncalled + t.unknown
    };
    const need = (p) => {
      const target = s.tieBreaker === p ? s.seats / 2 : s.majority;
      return Math.max(0, Math.ceil(target) - seats[p]);
    };
    return { seats, tally: t, need: { D: need('D'), R: need('R') }, caucusI };
  }
  function houseSummary(data) {
    const h = data.chambers.house;
    const seats = { D: h.totals.D, R: h.totals.R, other: h.totals.I + h.totals.O, uncalled: h.totals.uncalled };
    return { seats, need: { D: Math.max(0, h.majority - seats.D), R: Math.max(0, h.majority - seats.R) } };
  }
  // What changed between two versions of the file, so a writer can check the scope of an
  // update before committing it. Key order is ignored. A race whose only change is its
  // note is reported separately: rewriting notes on races whose result did not change
  // turns a small update into a rewrite of the whole file.
  const TOP_FIELDS = Object.freeze(['provider', 'publishedAt', 'observedAt', 'checkStatus', 'note', 'sources']);
  const RACE_FIELDS = Object.freeze(['status', 'special', 'winner', 'calledBy', 'calledAt', 'leader', 'candidates', 'reported', 'otherCalls', 'note']);
  function same(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => own(b, k) && same(a[k], b[k]));
  }
  function compareDatasets(before, after) {
    const top = TOP_FIELDS.filter((k) => !same(before[k], after[k]));
    const chambers = [];
    for (const c of ['senate', 'house', 'governor']) {
      for (const k of Object.keys(after.chambers[c])) if (!same(before.chambers[c][k], after.chambers[c][k])) chambers.push(`${c}.${k}`);
    }
    const races = [];
    let unchanged = 0;
    for (const office of ['senate', 'governor']) {
      for (const state of office === 'senate' ? SENATE_STATES : GOVERNOR_STATES) {
        const a = before.races[office][state];
        const b = after.races[office][state];
        const fields = RACE_FIELDS.filter((k) => !same(a[k], b[k]));
        if (fields.length === 0) unchanged++;
        else races.push({ office, state, fields, noteOnly: fields.length === 1 && fields[0] === 'note' });
      }
    }
    return { top, chambers, races, unchanged, total: SENATE_STATES.length + GOVERNOR_STATES.length };
  }
  return Object.freeze({ PARTIES, STATUSES, SENATE_STATES, GOVERNOR_STATES, STATE_NAMES, TILE_POSITIONS, validateDataset, tally, senateSummary, houseSummary, compareDatasets });
});
