#!/usr/bin/env node
'use strict';
/* Advisory style check for feed records and category summaries
 * (docs/feed-writing-guide.md). It never blocks publication: the contract
 * validator stays the only gate.
 *   node scripts/lint-feed-style.js           newest check run and summary of each category file
 *   node scripts/lint-feed-style.js --all     every record in data/<category>.json
 *   node scripts/lint-feed-style.js --strict  exit 1 when any warning is found
 */
const fs = require('node:fs');
const path = require('node:path');
const { CATEGORY_CONFIG } = require('../public-data.js');
const { WRITER_KINDS } = require('../display-data.js');
const { sentences } = require('../feed-text.js');

const TIMEZONES = 'UTC|KST|EST|EDT|CST|CDT|PST|PDT|AEDT|HKT|CET|CT';
const ALL_FIELDS = ['title', 'text', 'evidence'];
const PROSE_FIELDS = ['text', 'evidence'];
// Body sentence limits by kind (guide: 변화 없음 one sentence, 확인 제한 one or two).
const MAX_SENTENCES = Object.freeze({ '변화 없음': 1, '확인 제한': 2 });
const DEFAULT_MAX_SENTENCES = 4;

// First match in the given fields, labelled with the field and a little context.
function excerpt(record, fields, re) {
  for (const field of fields) {
    const value = record[field];
    const m = value ? re.exec(value) : null;
    if (m) return `${field}: ${value.slice(Math.max(0, m.index - 6), m.index + 10)}`;
  }
  return null;
}
function findSentence(record, fields, predicate, cut) {
  for (const field of fields) {
    const hit = sentences(record[field]).find(predicate);
    if (hit) return `${field}: ${cut(hit)}`;
  }
  return null;
}
const dots = s => (s.match(/·/g) || []).length;

const RULES = [
  // An ordinal such as 제9 is standard spacing; any other syllable directly before a digit is not.
  { id: 'spacing-number', message: '한글 바로 뒤에 숫자가 붙어 있습니다', test: r =>
    excerpt(r, ALL_FIELDS, /[가-힣](?<!제)(?=\d)/) },
  { id: 'spacing-timezone', message: '숫자와 시간대 약어가 붙어 있습니다', test: r =>
    excerpt(r, ALL_FIELDS, new RegExp(`\\d(?:${TIMEZONES})\\b`)) },
  { id: 'title-time', message: '제목이 날짜나 시각으로 시작합니다', test: r =>
    /^\s*(?:\d{1,2}\/\d{1,2}|\d{1,2}월\s*\d{1,2}일|\d{1,2}(?::\d{2})?\s*(?:시|KST))/.test(r.title || '') ? r.title.slice(0, 16) : null },
  { id: 'em-dash', message: '엠대시(—)를 썼습니다', test: r => excerpt(r, ALL_FIELDS, /—/) },
  { id: 'title-dots', message: '제목에 가운뎃점이 세 개 이상입니다', test: r =>
    dots(r.title || '') >= 3 ? r.title : null },
  { id: 'sentence-dots', message: '한 문장에 가운뎃점이 네 개 이상입니다', test: r =>
    findSentence(r, PROSE_FIELDS, s => dots(s) >= 4, s => s.slice(0, 40)) },
  { id: 'noun-ending', message: '문장이 서술어 없이 명사로 끝납니다', test: r =>
    findSentence(r, PROSE_FIELDS, s => !/(?:다|요|까)[.!?]?["'”’)\]]*$/.test(s), s => s.slice(-24)) },
  { id: 'text-length', message: '본문 문장 수가 kind 기준(변화 없음 1, 확인 제한 2, 그 밖에는 4)을 넘습니다', test: r => {
    const n = sentences(r.text).length;
    return n > (MAX_SENTENCES[r.kind] || DEFAULT_MAX_SENTENCES) ? `${n}문장` : null; } },
  { id: 'evidence-length', message: 'evidence가 세 문장이나 250자를 넘습니다', test: r => {
    const value = r.evidence || '';
    const n = sentences(value).length;
    return value.length > 250 || n > 3 ? `${n}문장, ${value.length}자` : null; } },
  { id: 'precision', message: '초 단위 시각이나 과도한 소수 자릿수가 있습니다', test: r =>
    excerpt(r, PROSE_FIELDS, /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?|\d\.\d{3,}%|\d\.\d{5,}/) },
  { id: 'paragraphs', message: '세 문장 이상인데 빈 줄로 단락을 나누지 않았습니다', test: r => {
    for (const field of PROSE_FIELDS) {
      const value = r[field];
      if (value && !/\n/.test(value) && sentences(value).length >= 3) return `${field}: ${sentences(value).length}문장`;
    }
    return null; } },
  // "\\n" in the JSON source arrives as a backslash and an n: the writer escaped twice.
  { id: 'escaped-newline', message: '줄바꿈 대신 역슬래시와 n 글자가 들어 있습니다', test: r =>
    excerpt(r, ALL_FIELDS, /\\n/) },
  { id: 'kind-vocabulary', message: 'kind가 작성용 여섯 어휘에 없습니다', test: r =>
    WRITER_KINDS.includes(r.kind) ? null : String(r.kind) },
];

function lintRecord(record) {
  return RULES.map(rule => ({ rule: rule.id, message: rule.message, sample: rule.test(record) }))
    .filter(result => result.sample !== null && result.sample !== undefined);
}

// Category summaries are one paragraph each; headline follows the title rules.
const SENTENCE_RULES = ['spacing-number', 'spacing-timezone', 'em-dash', 'sentence-dots', 'noun-ending', 'precision', 'escaped-newline'];
const SUMMARY_RULES = Object.freeze({
  headline: ['spacing-number', 'spacing-timezone', 'title-time', 'em-dash', 'title-dots', 'escaped-newline'],
  body: SENTENCE_RULES, unknown: SENTENCE_RULES, gap: SENTENCE_RULES,
});
function lintSummary(file) {
  const results = [];
  for (const [field, ids] of Object.entries(SUMMARY_RULES)) {
    const value = file && file[field];
    if (!value) continue;
    const record = field === 'headline' ? { title: value } : { text: value };
    for (const rule of RULES.filter(candidate => ids.includes(candidate.id))) {
      const sample = rule.test(record);
      if (sample !== null && sample !== undefined)
        results.push({ field, rule: rule.id, message: rule.message, sample: String(sample).replace(/^(?:title|text): /, '') });
    }
  }
  return results;
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
  const count = rule => { counts[rule] = (counts[rule] || 0) + 1; };
  for (const key of Object.keys(CATEGORY_CONFIG)) {
    const file = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', `${key}.json`), 'utf8'));
    for (const record of selectRecords(file.feed || [], all)) {
      checked++;
      const warnings = lintRecord(record);
      if (!warnings.length) continue;
      console.log(`\n[${key}] ${record.at} · ${record.title}`);
      for (const w of warnings) { count(w.rule); console.log(`  - ${w.rule}: ${w.message} (${w.sample})`); }
    }
    const summary = lintSummary(file);
    if (summary.length) {
      console.log(`\n[${key}] 요약 필드`);
      for (const w of summary) { count(w.rule); console.log(`  - ${w.field} ${w.rule}: ${w.message} (${w.sample})`); }
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\n검사한 기록 ${checked}건과 요약 필드, 경고 ${total}건${total ? `: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''}`);
  return strict && total ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { RULES, lintRecord, lintSummary, selectRecords };
