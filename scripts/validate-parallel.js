#!/usr/bin/env node
'use strict';
/* Validates the parallel timeline data (병렬 타임라인 v3) in data/parallel, or in the directory given (for
 * example a worktree of the data branch): index.json, every sessions/YYYY-MM-DD.json and notes/YYYY-MM-DD.json
 * against the parallel-core.js validators, file names against their dates, and that the index lists exactly
 * the session files. Exits 1 on any error; index fields that merely lag behind (notes added later) are warnings.
 *
 * --notes=warn reports invalid analyst notes as warnings instead of errors. The collect workflow gates on it:
 * a notes typo must not stop price publication (the collector and the page both ignore notes they cannot
 * validate), while index and session errors stay fatal. Without the flag (npm run validate) notes are strict.
 *
 * Usage: node scripts/validate-parallel.js [--notes=error|warn] [DIR]
 */
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../parallel-core.js');

const DATED = /^(\d{4}-\d{2}-\d{2})\.json$/;
const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'parallel');
const NOTES_MODES = ['error', 'warn'];
const USAGE = 'Usage: node scripts/validate-parallel.js [--notes=error|warn] [DIR]';

function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Check a data directory; returns {errors, warnings, notesErrors, sessions, notes, index}. Never throws on bad
 * data. options.notes: 'error' (default) puts notes problems into errors, 'warn' into warnings; either way
 * they are also listed in notesErrors.
 */
function validateDataDir(dir, options = {}) {
  const notesMode = options.notes === undefined ? 'error' : options.notes;
  if (!NOTES_MODES.includes(notesMode)) throw new Error(`notes mode must be ${NOTES_MODES.join(' or ')}`);
  const errors = [];
  const warnings = [];
  const notesErrors = [];
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const sessionDates = new Set(); // every dated session file, valid or not
  const sessions = new Map();
  const notes = new Map();
  for (const [sub, validate, store] of [['sessions', Core.validateSession, sessions], ['notes', Core.validateNotes, notes]]) {
    const problems = sub === 'notes' ? notesErrors : errors;
    for (const name of jsonFiles(path.join(dir, sub))) {
      const rel = `${sub}/${name}`;
      const m = DATED.exec(name);
      if (!m) {
        problems.push(`${rel}: file name must be YYYY-MM-DD.json`);
        continue;
      }
      if (sub === 'sessions') sessionDates.add(m[1]);
      try {
        const obj = validate(read(path.join(dir, sub, name)));
        if (obj.date !== m[1]) throw new Error(`date ${obj.date} does not match the file name`);
        store.set(m[1], obj);
      } catch (error) {
        problems.push(`${rel}: ${error.message}`);
      }
    }
  }

  let index = null;
  const indexFile = path.join(dir, 'index.json');
  if (!fs.existsSync(indexFile)) {
    if (sessionDates.size) errors.push('index.json: missing although session files exist');
  } else {
    try {
      index = Core.validateIndex(read(indexFile));
    } catch (error) {
      errors.push(`index.json: ${error.message}`);
    }
  }

  if (index) {
    const listed = new Set(index.sessions.map((entry) => entry.date));
    for (const date of sessionDates) {
      if (!listed.has(date)) errors.push(`index.json: sessions/${date}.json is not listed`);
    }
    for (const entry of index.sessions) {
      const q = `index.json: ${entry.date}`;
      if (!sessionDates.has(entry.date)) {
        errors.push(`${q} is listed but sessions/${entry.date}.json does not exist`);
        continue;
      }
      const session = sessions.get(entry.date);
      if (!session) continue; // the invalid session file is already reported
      if (entry.final !== session.final) errors.push(`${q} final is ${entry.final} but the session file says ${session.final}`);
      const withData = session.series.filter((s) => s.points.length > 0).length;
      if (entry.seriesWithData != null && entry.seriesWithData !== withData) {
        warnings.push(`${q} seriesWithData is ${entry.seriesWithData} but the session has ${withData}`);
      }
      const note = notes.get(entry.date) || null;
      if (entry.hasNotes === true && !note) warnings.push(`${q} hasNotes is true but there is no valid notes/${entry.date}.json`);
      if (note && entry.hasNotes !== true) {
        warnings.push(`${q} has notes that the index does not list yet (the next collector run refreshes it)`);
      }
      const title = note && typeof note.title === 'string' && note.title.trim() ? note.title : null;
      if (note && (entry.title == null ? null : entry.title) !== title) warnings.push(`${q} title differs from the notes title`);
    }
  }
  if (notesMode === 'warn') {
    for (const problem of notesErrors) warnings.push(`${problem} (analyst notes: the page ignores this file until it is fixed)`);
  } else {
    errors.push(...notesErrors);
  }
  return { errors, warnings, notesErrors, sessions: sessions.size, notes: notes.size, index };
}

/** Command line -> {dir, notes, help}; throws on an unknown option or a second directory. */
function parseArgs(argv) {
  const out = { dir: null, notes: 'error', help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
    } else if (arg === '--notes' || arg.startsWith('--notes=')) {
      const value = arg === '--notes' ? argv[++i] : arg.slice('--notes='.length);
      if (!NOTES_MODES.includes(value)) throw new Error(`--notes must be ${NOTES_MODES.join(' or ')}`);
      out.notes = value;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`);
    } else if (out.dir === null) {
      out.dir = arg;
    } else {
      throw new Error(`unexpected argument ${arg} (one directory at most)`);
    }
  }
  return out;
}

/** GitHub Actions annotation text (workflow command escaping). */
const annotation = (text) => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/**
 * CLI: 0 valid, 1 validation errors, 2 usage error. io (tests): {env, log, warn, error} replace process.env and
 * the console methods.
 */
function main(argv = process.argv.slice(2), io = {}) {
  const env = io.env || process.env;
  const log = io.log || ((line) => console.log(line));
  const warn = io.warn || ((line) => console.warn(line));
  const fail = io.error || ((line) => console.error(line));
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fail(`validate-parallel: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    log(USAGE);
    return 0;
  }
  const dir = path.resolve(args.dir || DEFAULT_DIR);
  let result;
  try {
    result = validateDataDir(dir, { notes: args.notes });
  } catch (error) {
    fail(`Parallel timeline validation failed: ${error.message}`);
    return 1;
  }
  const inActions = env.GITHUB_ACTIONS === 'true';
  for (const warning of result.warnings) {
    warn(`warning: ${warning}`);
  }
  if (inActions && args.notes === 'warn') {
    for (const problem of result.notesErrors) log(`::warning title=parallel notes::${annotation(problem)}`);
  }
  if (result.errors.length) {
    for (const error of result.errors) fail(`error: ${error}`);
    fail(`Parallel timeline validation failed with ${result.errors.length} error(s).`);
    return 1;
  }
  const latest = result.index && result.index.sessions[0];
  const ignored = args.notes === 'warn' && result.notesErrors.length
    ? `; ${result.notesErrors.length} invalid notes file(s) reported as warnings` : '';
  log(`Validated parallel timeline: ${result.sessions} session file(s), ${result.notes} notes file(s)`
    + `${latest ? `, latest ${latest.date}${latest.final ? ' (final)' : ''}` : ', no sessions collected yet'}${ignored}.`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { validateDataDir, parseArgs, main };
