#!/usr/bin/env node
'use strict';
// Only prepares a Git-ignored file for a local preview. Never a publication input.
const fs = require('node:fs');
const path = require('node:path');
const {parseReference,validateDataset,summarizeSeries} = require('../parallel-data.js');
const [pricesPath,eventsPath,...extra] = process.argv.slice(2);
if(!pricesPath||!eventsPath||extra.length) {
  console.error('Usage: node scripts/prepare-parallel-reference.js <prices.csv> <events.csv>');
  process.exitCode=1;
} else {
  try {
    const data=validateDataset(parseReference(fs.readFileSync(path.resolve(pricesPath),'utf8'),fs.readFileSync(path.resolve(eventsPath),'utf8')),{allowLocalReference:true});
    const output=path.join(__dirname,'..','data','parallel-reference.local.json');
    fs.writeFileSync(output,JSON.stringify(data,null,2)+'\n','utf8');
    const missing=data.series.reduce((n,s)=>n+summarizeSeries(s,data.window).missingGridCount,0);
    console.log(`Prepared local-only reference: ${data.series.length} series, ${data.events.length} unverified events, ${missing} internal missing grid cells. Open parallel.html?reference=local. Do not publish the ignored local file.`);
  } catch(_) {
    console.error('Reference preparation failed. Check the two CSV files; no source values are included in this error.');
    process.exitCode=1;
  }
}
