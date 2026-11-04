#!/usr/bin/env node
'use strict';
// Usage:
//   node scripts/validate-election-results.js [file] [--compare previous.json]
// Validates the election results file (default: data/election-results.json). With
// --compare, also prints which races and fields changed since the previous version,
// so a writer can check that an update touches only what actually changed.
const fs = require('node:fs');
const path = require('node:path');
const { validateDataset, tally, senateSummary, compareDatasets } = require('../election-results-data.js');

function parseArgs(argv) {
  const args = { file: path.join(__dirname, '..', 'data', 'election-results.json'), compare: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--compare') {
      if (!argv[i + 1]) throw new Error('--compare needs the path of the previous file');
      args.compare = argv[++i];
    } else args.file = argv[i];
  }
  return args;
}

function load(file) {
  const text = fs.readFileSync(file, 'utf8');
  return { text, data: validateDataset(JSON.parse(text)) };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Long lists stay readable in a terminal and in a commit message.
const names = (list, max = 8) => (list.length > max ? `${list.slice(0, max).join(', ')} and ${list.length - max} more` : list.join(', '));

function report(previousFile, before, after, text) {
  const diff = compareDatasets(before, after);
  const changed = diff.races.map((r) => `${r.office}.${r.state}`);
  console.log(changed.length
    ? `Compared with ${previousFile}: ${changed.length} of ${diff.total} races changed, ${diff.unchanged} unchanged.`
    : `Compared with ${previousFile}: no race changed (${diff.unchanged} unchanged).`);
  if (diff.top.length) console.log(`  Top level: ${diff.top.join(', ')}`);
  if (diff.chambers.length) console.log(`  Chambers: ${diff.chambers.join(', ')}`);
  for (const r of diff.races) console.log(`  ${r.office}.${r.state}: ${r.fields.join(', ')}`);
  const noteOnly = diff.races.filter((r) => r.noteOnly).map((r) => `${r.office}.${r.state}`);
  if (noteOnly.length) {
    console.log(`Warning: ${plural(noteOnly.length, 'race')} changed only in their note (${names(noteOnly)}). Leave races whose result did not change exactly as they were; put check times in the top-level observedAt and note.`);
  }
  if (text !== `${JSON.stringify(JSON.parse(text), null, 2)}\n`) {
    console.log('Warning: the file is not in the canonical format (JSON.stringify(data, null, 2) plus one final newline). Reformatting rewrites every line of the file.');
  }
  const parts = [];
  parts.push(changed.length ? `${plural(changed.length, 'race')} changed (${names(changed)})` : 'no race changed');
  if (diff.chambers.length) parts.push(`chambers ${diff.chambers.join(', ')}`);
  parts.push(`${plural(diff.unchanged, 'race')} unchanged`);
  console.log(`Commit summary: ${parts.join('; ')}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  const { text, data } = load(args.file);
  const senate = senateSummary(data);
  const governor = tally(data.races.governor);
  const calledGovernors = governor.called.D + governor.called.R + governor.called.I + governor.called.O;
  console.log(`Validated election results: Senate ${senate.seats.D}D-${senate.seats.R}R with ${senate.seats.uncalled} open, ${calledGovernors} governor races called, ${governor.uncalled} open, ${governor.unknown} unverified.`);
  if (args.compare) {
    let previous;
    try {
      previous = load(args.compare).data;
    } catch (error) {
      throw new Error(`previous file ${args.compare} could not be read as a valid results file: ${error.message}`);
    }
    report(args.compare, previous, data, text);
  }
} catch (error) {
  console.error(`Election results validation failed: ${error.message}`);
  process.exitCode = 1;
}
