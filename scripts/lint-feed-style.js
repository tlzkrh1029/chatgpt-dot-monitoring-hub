#!/usr/bin/env node
'use strict';
/* Advisory style check for feed records (docs/feed-writing-guide.md).
 * It never blocks publication: the contract validator stays the only gate.
 *   node scripts/lint-feed-style.js           newest check run of each category file
 *   node scripts/lint-feed-style.js --all     every record in data/<category>.json
 *   node scripts/lint-feed-style.js --strict  exit 1 when any warning is found
 */
const fs = require('node:fs');
const path = require('node:path');
const { CATEGORY_CONFIG } = require('../public-data.js');
const { KIND_STYLES } = require('../display-data.js');

const TIMEZONES = 'UTC|KST|EST|EDT|CST|CDT|PST|PDT|AEDT|HKT|CET|CT';
const sentences = text => String(text || '').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
// First match in title, text or evidence, with a little context for the report.
const excerpt = (record, re) => {
  const text = [record.title, record.text, record.evidence].filter(Boolean).join(' ');
  const m = re.exec(text);
  return m ? text.slice(Math.max(0, m.index - 6), m.index + 10) : null;
};

const RULES = [
  // An ordinal such as 제9 is standard spacing; any other syllable directly before a digit is not.
  { id: 'spacing-number', message: '한글 바로 뒤에 숫자가 붙어 있습니다', test: r => excerpt(r, /[가-힣](?<!제)(?=\d)/) },
  { id: 'spacing-timezone', message: '숫자와 시간대 약어가 붙어 있습니다', test: r =>
    excerpt(r, new RegExp(`\\d(?:${TIMEZONES})\\b`)) },
  { id: 'title-time', message: '제목이 날짜나 시각으로 시작합니다', test: r =>
    /^\s*(?:\d{1,2}\/\d{1,2}|\d{1,2}월\s*\d{1,2}일|\d{1,2}(?::\d{2})?\s*(?:시|KST))/.test(r.title || '') ? r.title.slice(0, 16) : null },
  { id: 'em-dash', message: '엠대시(—)를 썼습니다', test: r => /—/.test(`${r.title} ${r.text}`) ? '—' : null },
  { id: 'title-dots', message: '제목에 가운뎃점이 세 개 이상입니다', test: r =>
    ((r.title || '').match(/·/g) || []).length >= 3 ? r.title : null },
  { id: 'sentence-dots', message: '본문 한 문장에 가운뎃점이 네 개 이상입니다', test: r =>
    sentences(r.text).find(s => (s.match(/·/g) || []).length >= 4)?.slice(0, 40) || null },
  { id: 'noun-ending', message: '본문 문장이 서술어 없이 명사로 끝납니다', test: r =>
    sentences(r.text).find(s => !/(?:다|요|까)[.!?]?$/.test(s))?.slice(-24) || null },
  { id: 'text-length', message: '본문이 네 문장을 넘습니다', test: r =>
    sentences(r.text).length > 4 ? `${sentences(r.text).length}문장` : null },
  { id: 'evidence-length', message: 'evidence가 250자를 넘습니다', test: r =>
    (r.evidence || '').length > 250 ? `${r.evidence.length}자` : null },
  { id: 'precision', message: '밀리초 시각이나 과도한 소수 자릿수가 있습니다', test: r => {
    const m = String(r.text || '').match(/\d{2}:\d{2}:\d{2}\.\d+|\d\.\d{3,}%|\d\.\d{5,}/);
    return m ? m[0] : null; } },
  { id: 'kind-vocabulary', message: 'kind가 고정 어휘에 없습니다', test: r =>
    Object.prototype.hasOwnProperty.call(KIND_STYLES, r.kind) ? null : r.kind },
];

function lintRecord(record) {
  return RULES.map(rule => ({ rule: rule.id, message: rule.message, sample: rule.test(record) }))
    .filter(result => result.sample !== null && result.sample !== undefined);
}

function selectRecords(feed, all) {
  if (all || !feed.length) return feed;
  const newest = Math.max(...feed.map(record => Date.parse(record.at)));
  return feed.filter(record => Date.parse(record.at) === newest);
}

function main(argv) {
  const all = argv.includes('--all');
  const strict = argv.includes('--strict');
  const counts = {};
  let checked = 0;
  for (const key of Object.keys(CATEGORY_CONFIG)) {
    const file = path.join(__dirname, '..', 'data', `${key}.json`);
    const feed = JSON.parse(fs.readFileSync(file, 'utf8')).feed || [];
    for (const record of selectRecords(feed, all)) {
      checked++;
      const warnings = lintRecord(record);
      if (!warnings.length) continue;
      console.log(`\n[${key}] ${record.at} · ${record.title}`);
      for (const w of warnings) {
        counts[w.rule] = (counts[w.rule] || 0) + 1;
        console.log(`  - ${w.rule}: ${w.message} (${w.sample})`);
      }
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n검사한 기록 ${checked}건, 경고 ${total}건${total ? `: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
  return strict && total ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { RULES, lintRecord, selectRecords };
