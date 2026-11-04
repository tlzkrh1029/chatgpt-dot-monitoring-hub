#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {validateDataset}=require('../parallel-data.js');
try {
  const data=validateDataset(JSON.parse(fs.readFileSync(path.join(__dirname,'..','data','parallel.json'),'utf8')));
  console.log(`Validated parallel publication: ${data.series.length} series, ${data.series.filter(s=>s.points.length).length} connected series, ${data.events.length} source-checked events.`);
} catch(error) {
  console.error(`Parallel publication validation failed: ${error.message}`);
  process.exitCode=1;
}
