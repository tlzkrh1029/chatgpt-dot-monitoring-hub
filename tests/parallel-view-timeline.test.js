'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../parallel-core.js');
const V = require('../parallel-view.js');

const DATE = '2026-11-05';
const iso = (hhmm, date = DATE) => C.kstToUtcIso(date, hhmm);
const ms = (hhmm, date = DATE) => Date.parse(iso(hhmm, date));

function notes(story, extra) {
  return Object.assign({ schemaVersion: 3, kind: 'notes', date: DATE, title: 't', story }, extra || {});
}

const tagged = () => notes([
  { id: 'a1', part: 'asia', at: iso('09:00'), text: '코스피 <x>', sources: [{ label: 'fn', url: 'https://www.fnnews.com/1' }] },
  { id: 'c1', part: 'crypto', at: iso('09:00'), end: iso('16:00'), text: 'BTC 정지', links: [{ to: 'a1', kind: 'none', note: '무반응' }] },
  { id: 'u1', part: 'us', at: iso('23:34'), text: '개장', links: [{ to: 'c2', kind: 'cause', note: '7분' }, { to: 'nope', kind: 'cause' }, { to: 'c2', kind: 'weird' }] },
  { id: 'c2', part: 'crypto', at: iso('23:31'), text: '급락' },
  { text: '태그 없는 단락은 타임라인에서 빠진다' },
  { part: 'cross', at: iso('10:00'), text: 'cross는 열이 아니다' },
], { rails: { left: 'NQ · 원', right: 'VIX · 금' },
  bands: [{ at: iso('16:00'), label: 'CP1 16:00', text: '전염 없음', rails: { left: ['NQ −0.9%'], right: ['VIX 16.6'] } }, { at: 'bad' }] });

test('storyTimelineModel: null without tags, cards sorted and links resolved with tags', () => {
  assert.equal(V.storyTimelineModel(null), null);
  assert.equal(V.storyTimelineModel(notes([{ text: 'plain' }])), null);
  const m = V.storyTimelineModel(tagged());
  assert.deepEqual(m.cards.map((c) => c.id), ['a1', 'c1', 'c2', 'u1']);
  assert.equal(m.cards[1].end, ms('16:00'));
  assert.deepEqual(m.links, [{ from: 'c1', to: 'a1', kind: 'none', note: '무반응' }, { from: 'u1', to: 'c2', kind: 'cause', note: '7분' }]);
  assert.equal(m.bands.length, 1);
  assert.deepEqual(m.bands[0].left, ['NQ −0.9%']);
  assert.deepEqual(m.rails, { left: 'NQ · 원', right: 'VIX · 금' });
});

test('storyTimelineModel: no rails when no band carries values; generated ids', () => {
  const m = V.storyTimelineModel(notes([{ part: 'asia', at: iso('09:00'), text: 'a' }], { bands: [{ at: iso('16:00') }] }));
  assert.equal(m.rails, null);
  assert.equal(m.cards[0].id, 'stl-0');
  assert.equal(m.bands[0].label, '16:00');
});

test('timelineScale: proportional, folds a quiet stretch over 6 h, reserves band room', () => {
  const sc = V.timelineScale([ms('09:00'), ms('10:00'), ms('23:03')], [ms('16:00'), ms('23:30')]);
  assert.equal(sc.y(ms('09:00')), 0);
  assert.equal(sc.y(ms('10:00')), 36); // 60 min * 0.6 px
  assert.equal(sc.folds.length, 1); // 16:00 -> 23:03 is folded, 10:00 -> 16:00 (6 h) is not
  assert.ok(sc.folds[0].from > ms('16:00') && sc.folds[0].to < ms('23:03'));
  const before = sc.yBand(ms('16:00'));
  assert.equal(sc.y(ms('16:00')), before + 32); // a card at the band time sits under the band
  assert.ok(sc.y(ms('23:03')) < sc.y(ms('16:00')) + 84 + 32 + 30, 'the folded night costs about one fold height');
  assert.equal(V.timelineScale([], []), null);
});

test('storyTimelineHtml: skeleton with six columns, cards in time order, escaped text, link specs', () => {
  const html = V.storyTimelineHtml(tagged(), DATE);
  assert.match(html, /^<div class="stl" data-cols="6" data-rails="1">/);
  assert.match(html, /<h3 class="stl-colhd stl-asia">아시아 증시<\/h3>/);
  assert.match(html, /<div class="stl-railhd">NQ · 원<\/div>/);
  assert.ok(html.indexOf('id="stl-c1"') < html.indexOf('id="stl-c2"'));
  assert.match(html, /코스피 &lt;x&gt;/);
  assert.match(html, /<span class="stl-t">09:00–16:00<\/span>BTC 정지/);
  assert.match(html, /<div class="stl-band" data-at="\d+"><b>CP1 16:00<\/b><span>전염 없음<\/span><\/div>/);
  assert.match(html, /<span class="stl-link" data-from="u1" data-to="c2" data-kind="cause" data-note="7분" hidden><\/span>/);
  assert.doesNotMatch(html, /data-to="nope"/);
  assert.match(html, /출처: <a href="https:\/\/www\.fnnews\.com\/1"/);
  assert.equal(V.storyTimelineHtml(notes([{ text: 'plain' }]), DATE), '');
  // without rails: four columns and no rail headers
  const four = V.storyTimelineHtml(notes([{ part: 'us', at: iso('23:34'), text: 'u' }]), DATE);
  assert.match(four, /data-cols="4" data-rails="0"/);
  assert.doesNotMatch(four, /stl-railhd/);
  assert.match(four, /<div class="stl-col stl-asia" data-col="asia"><p class="stl-none">·<\/p><\/div>/);
});

test('storyHtml is unchanged for tagged notes (the fallback for narrow screens)', () => {
  const n = tagged();
  assert.match(V.storyHtml(n), /^<div class="para"><p>코스피 &lt;x&gt;<\/p><p class="src">출처: /);
  assert.equal((V.storyHtml(n).match(/<div class="para">/g) || []).length, 6);
});

test('storyTimelineHtml: paragraphs without tags follow the grid as 교차 읽기', () => {
  const html = V.storyTimelineHtml(tagged(), DATE);
  const tail = html.slice(html.indexOf('<div class="stl-rest">'));
  assert.match(tail, /^<div class="stl-rest"><h3 class="stl-resthd">교차 읽기<\/h3><div class="para"><p>태그 없는 단락은 타임라인에서 빠진다<\/p><\/div><div class="para"><p>cross는 열이 아니다<\/p><\/div><\/div><\/div>$/);
  assert.doesNotMatch(V.storyTimelineHtml(notes([{ part: 'us', at: iso('23:34'), text: 'u' }]), DATE), /stl-rest/);
});

test('storyTabsHtml: a tab per market plus 교차, nearest-card chips, active tab honoured', () => {
  const html = V.storyTabsHtml(tagged(), DATE);
  assert.match(html, /^<div class="stl stl-tabs"><div class="stl-tabbar" role="tablist">/);
  assert.equal((html.match(/data-stl-tab="/g) || []).length, 4);
  assert.match(html, /data-stl-tab="asia" aria-selected="true"/);
  assert.match(html, /<div class="stl-panel" role="tabpanel" data-stl-panel="crypto" hidden>/);
  // crypto card c1 at 09:00 points at the asia card a1 (same time); no us card within 3 h
  assert.match(html, /id="stl-c1"[\s\S]*?같은 시각 <button type="button" class="stl-chip stl-chip-asia" data-stl-goto="a1" data-stl-part="asia">아시아 증시 09:00 ▸<\/button><\/p>/);
  // us card u1 at 23:34 points at crypto c2 (23:31) but not at asia (09:00 is 14 h away)
  assert.match(html, /id="stl-u1"[\s\S]*?data-stl-goto="c2"/);
  assert.doesNotMatch(html.slice(html.indexOf('id="stl-u1"'), html.indexOf('id="stl-u1"') + 600), /stl-chip-asia/);
  const open = V.storyTabsHtml(tagged(), DATE, 'rest');
  assert.match(open, /data-stl-tab="rest" aria-selected="true"/);
  assert.match(open, /<div class="stl-panel" role="tabpanel" data-stl-panel="rest">/);
  assert.match(V.storyTabsHtml(tagged(), DATE, 'nope'), /data-stl-tab="asia" aria-selected="true"/);
  assert.equal(V.storyTabsHtml(notes([{ text: 'plain' }]), DATE), '');
});
