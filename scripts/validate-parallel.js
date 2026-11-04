#!/usr/bin/env node
'use strict';
/* Validates the parallel timeline data (병렬 타임라인 v3) in data/parallel (or the directory given):
 * index.json, every sessions/YYYY-MM-DD.json and notes/YYYY-MM-DD.json against the parallel-core.js
 * validators, file names against their dates, and that the index lists exactly the session files.
 * Exits 1 on any error; index fields that merely lag behind (notes added later) are warnings.
 */
const fs = require('node:fs');
const path = require('node:path');
const Core = require('../parallel-core.js');

const DATED = /^(\d{4}-\d{2}-\d{2})\.json$/;

function jsonFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** Check a data directory; returns {errors, warnings, sessions, notes, index}. Never throws on bad data. */
function validateDataDir(dir) {
  const errors = [];
  const warnings = [];
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
  const sessionDates = new Set(); // every dated session file, valid or not
  const sessions = new Map();
  const notes = new Map();
  for (const [sub, validate, store] of [['sessions', Core.validateSession, sessions], ['notes', Core.validateNotes, notes]]) {
    for (const name of jsonFiles(path.join(dir, sub))) {
      const rel = `${sub}/${name}`;
      const m = DATED.exec(name);
      if (!m) {
        errors.push(`${rel}: file name must be YYYY-MM-DD.json`);
        continue;
      }
      if (sub === 'sessions') sessionDates.add(m[1]);
      try {
        const obj = validate(read(path.join(dir, sub, name)));
        if (obj.date !== m[1]) throw new Error(`date ${obj.date} does not match the file name`);
        store.set(m[1], obj);
      } catch (error) {
        errors.push(`${rel}: ${error.message}`);
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
  return { errors, warnings, sessions: sessions.size, notes: notes.size, index };
}

function main(argv = process.argv.slice(2)) {
  const dir = path.resolve(argv[0] || path.join(__dirname, '..', 'data', 'parallel'));
  let result;
  try {
    result = validateDataDir(dir);
  } catch (error) {
    console.error(`Parallel timeline validation failed: ${error.message}`);
    return 1;
  }
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error(`Parallel timeline validation failed with ${result.errors.length} error(s).`);
    return 1;
  }
  const latest = result.index && result.index.sessions[0];
  console.log(`Validated parallel timeline: ${result.sessions} session file(s), ${result.notes} notes file(s)`
    + `${latest ? `, latest ${latest.date}${latest.final ? ' (final)' : ''}` : ', no sessions collected yet'}.`);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { validateDataDir, main };
