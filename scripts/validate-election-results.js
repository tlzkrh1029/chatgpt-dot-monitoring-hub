#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateDataset, tally, senateSummary } = require('../election-results-data.js');
try {
  const data = validateDataset(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'election-results.json'), 'utf8')));
  const senate = senateSummary(data);
  const governor = tally(data.races.governor);
  const calledGovernors = governor.called.D + governor.called.R + governor.called.I + governor.called.O;
  console.log(`Validated election results: Senate ${senate.seats.D}D-${senate.seats.R}R with ${senate.seats.uncalled} open, ${calledGovernors} governor races called, ${governor.uncalled} open, ${governor.unknown} unverified.`);
} catch (error) {
  console.error(`Election results validation failed: ${error.message}`);
  process.exitCode = 1;
}
