#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const contract = require('../public-data.js');
const root = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
try {
  const base = contract.validateData(read('data.json'));
  const updates = Object.keys(contract.CATEGORY_CONFIG).map(key =>
    contract.validateCategory(read(`data/${key}.json`), key));
  const data = contract.composeData(base, updates);
  console.log(`Validated base, ${updates.length} category files, and ${data.feed.length} preserved public records.`);
} catch (error) {
  console.error(`Publication validation failed: ${error.message}`);
  process.exitCode = 1;
}
