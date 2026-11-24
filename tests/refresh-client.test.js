'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../refresh-client.js');
const { CATEGORY_CONFIG, freshness } = require('../public-data.js');
const base = require('../data.json');
const macro = require('../data/macro.json');
function harness() {
  const calls = []; let failure = ''; let clock = Date.now();
  const controller = createController({ now: () => clock, timeoutMs: 30, fetchImpl: async (url, options) => {
    const file = url.split('?')[0]; calls.push({file,url,options});
    if (failure === 'hang') return new Promise(() => {});
    return { ok: failure !== 'http', json: async () => {
      if (failure === 'parse') throw new SyntaxError('invalid JSON');
      return structuredClone(file === 'data.json' ? base : macro);
    }};
  }});
  return { controller, calls, fail: value => { failure = value; clock += 1000; } };
}
test('initial load and repeat polling access only the base and active publisher', async () => {
  const h = harness();
  const first = await h.controller.refresh();
  const second = await h.controller.refresh();
  assert.deepEqual(Object.keys(CATEGORY_CONFIG), ['macro']);
  assert.deepEqual(h.calls.map(c => c.file), ['data.json','data/macro.json','data.json','data/macro.json']);
  assert.deepEqual(second.data, first.data);
  assert.deepEqual(first.data.setting, base.setting);
  assert.notEqual(h.calls[0].url,h.calls[2].url);
  for (const {options} of h.calls) {
    assert.equal(options.credentials,'omit'); assert.equal(options.cache,'no-store');
  }
});
for (const failure of ['http','parse','hang']) test(`${failure} failures preserve the last valid data and recover`, async () => {
  const h = harness(); const first = await h.controller.refresh();
  h.fail(failure); const failed = await h.controller.refresh();
  assert.deepEqual(failed.data,first.data); assert.ok(failed.statuses.macro.error);
  h.fail(''); const recovered = await h.controller.refresh();
  assert.equal(recovered.statuses.macro.error,''); assert.deepEqual(recovered.data,first.data);
});
test('freshness depends on actual observation time', async () => {
  const h = harness(); const {data} = await h.controller.refresh();
  assert.deepEqual(freshness(data,Date.parse(macro.observedAt)+91*60000).staleKeys,['macro']);
});
