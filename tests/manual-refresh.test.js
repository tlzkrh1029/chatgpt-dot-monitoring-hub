'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bind } = require('../manual-refresh.js');

const KEYS = ['macro', 'election', 'security', 'xr', 'onchain'];
const FETCHED_AT = '2026-11-04T02:30:00.000Z';

function snapshot(changes = {}) {
  return {
    data: { categories: KEYS.map(key => ({ key, checkStatus: 'ok', observedAt: '2026-11-03T15:00:00.000Z' })) },
    statuses: Object.fromEntries(KEYS.map(key => [key, { error: '' }])),
    baseError: '',
    lastFetchAt: FETCHED_AT,
    ...changes
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function elements() {
  const attributes = new Map();
  const statusAttributes = new Map();
  const listeners = new Map();
  return {
    button: {
      textContent: '새로고침',
      setAttribute: (key, value) => attributes.set(key, String(value)),
      removeAttribute: key => attributes.delete(key),
      addEventListener: (key, listener) => listeners.set(key, listener)
    },
    status: {
      textContent: '', dataset: {},
      setAttribute: (key, value) => statusAttributes.set(key, String(value)),
      removeAttribute: key => statusAttributes.delete(key)
    },
    attributes,
    statusAttributes,
    click: () => {
      assert.ok(listeners.has('click'), 'a manual button listener must be registered');
      return listeners.get('click')({ type: 'click', preventDefault() {} });
    }
  };
}

function harness(refreshImpl = async () => snapshot()) {
  const el = elements();
  let calls = 0;
  const controller = { refresh: () => { calls++; return refreshImpl(); } };
  const api = bind({ button: el.button, status: el.status, controller, categoryKeys: KEYS,
    formatTime: iso => `formatted(${iso})` });
  return { ...el, ...api, calls: () => calls };
}

function assertRestored(h) {
  assert.equal(h.button.textContent, '새로고침');
  assert.equal(h.attributes.get('aria-busy'), 'false');
  assert.equal(h.attributes.get('aria-disabled'), 'false');
  assert.equal(Object.hasOwn(h.button, 'disabled'), false, 'native disabled must not remove keyboard focus');
}

function assertOutcome(h, outcome) {
  assert.equal(h.status.dataset.outcome, outcome);
  const label = h.statusAttributes.get('aria-label');
  if (outcome === 'pending') {
    assert.doesNotMatch(h.status.textContent, /[✅❌]/u);
    assert.equal(label, h.status.textContent);
    return;
  }
  const icon = outcome === 'success' ? '✅' : '❌';
  const opposite = outcome === 'success' ? '❌' : '✅';
  assert.ok(h.status.textContent.endsWith(` ${icon}`), 'the completed outcome icon must follow the status text');
  assert.ok(!h.status.textContent.includes(opposite), 'a completed result must not display the opposite outcome');
  const text = h.status.textContent.slice(0, -(` ${icon}`).length);
  assert.equal(label, `${text} · 새로고침 ${outcome === 'success' ? '성공' : '실패'}`);
}

test('manual refresh gives immediate loading feedback without disabling keyboard focus', async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const completion = h.refresh();
  assert.equal(h.button.textContent, '확인 중…');
  assert.equal(h.attributes.get('aria-busy'), 'true');
  assert.equal(h.attributes.get('aria-disabled'), 'true');
  assert.equal(h.status.dataset.state, 'loading');
  assert.equal(h.status.textContent, '공개 파일을 확인하고 있습니다.');
  assertOutcome(h, 'pending');
  assert.equal(Object.hasOwn(h.button, 'disabled'), false);
  await Promise.resolve();
  assert.equal(h.calls(), 1);
  pending.resolve(snapshot());
  await completion;
  assertRestored(h);
});

test('a successful pass reports five public files and the actual receive time', async () => {
  const result = snapshot();
  const h = harness(async () => result);
  assert.strictEqual(await h.refresh(), result);
  assert.equal(h.status.dataset.state, 'success');
  assertOutcome(h, 'success');
  assert.match(h.status.textContent, /공개 파일 5\/5 수신 완료/);
  assert.ok(h.status.textContent.includes(`formatted(${FETCHED_AT})`));
  assert.equal(result.data.categories[0].observedAt, '2026-11-03T15:00:00.000Z');
  assertRestored(h);
});

test('one failed file reports four of five and preservation of last-good data', async () => {
  const result = snapshot();
  result.statuses.macro.error = 'File unavailable';
  const h = harness(async () => result);
  await h.refresh();
  assert.equal(h.status.dataset.state, 'warning');
  assertOutcome(h, 'failure');
  assert.match(h.status.textContent, /일부 파일 수신 실패 \(4\/5\)/);
  assert.match(h.status.textContent, /마지막 정상/);
  assertRestored(h);
});

test('all five category failures report an error while retaining prior data', async () => {
  const result = snapshot({ statuses: Object.fromEntries(KEYS.map(key => [key, { error: 'Unavailable' }])) });
  const h = harness(async () => result);
  await h.refresh();
  assert.equal(h.status.dataset.state, 'error');
  assertOutcome(h, 'failure');
  assert.match(h.status.textContent, /0\/5/);
  assert.match(h.status.textContent, /마지막 정상/);
  assertRestored(h);
});

test('a failed base file remains a warning even if all category files arrived', async () => {
  const h = harness(async () => snapshot({ baseError: 'Base file unavailable' }));
  await h.refresh();
  assert.equal(h.status.dataset.state, 'warning');
  assertOutcome(h, 'failure');
  assert.doesNotMatch(h.status.textContent, /공개 파일 5\/5 수신 완료/);
  assert.match(h.status.textContent, /기본/);
  assertRestored(h);
});

test('an empty dashboard result cannot be reported as successful', async () => {
  const h = harness(async () => snapshot({ data: null }));
  await h.refresh();
  assert.equal(h.status.dataset.state, 'error');
  assertOutcome(h, 'failure');
  assert.doesNotMatch(h.status.textContent, /수신 완료/);
  assertRestored(h);
});

test('valid files with partial source checks report their incomplete observation status', async () => {
  const result = snapshot();
  result.data.categories[0].checkStatus = 'partial';
  const h = harness(async () => result);
  await h.refresh();
  assert.equal(h.status.dataset.state, 'warning');
  assertOutcome(h, 'success');
  assert.match(h.status.textContent, /부분 확인 1개/);
  assertRestored(h);
});

test('valid files with source check failures report the evidence failure separately', async () => {
  const result = snapshot();
  result.data.categories[1].checkStatus = 'error';
  result.data.categories[2].checkStatus = 'error';
  const h = harness(async () => result);
  await h.refresh();
  assert.equal(h.status.dataset.state, 'warning');
  assertOutcome(h, 'success');
  assert.match(h.status.textContent, /원문 점검 실패 2개/);
  assertRestored(h);
});

test('unexpected exceptions are caught, show a generic error, and restore the button', async () => {
  const privateDetail = 'internal-token-and-private-detail';
  const h = harness(async () => { throw new Error(privateDetail); });
  assert.equal(await h.refresh(), null);
  assert.equal(h.status.dataset.state, 'error');
  assertOutcome(h, 'failure');
  assert.ok(h.status.textContent);
  assert.ok(!h.status.textContent.includes(privateDetail));
  assertRestored(h);
});

test('a synchronous controller exception releases the active pass so the next click can recover', async () => {
  let attempts = 0;
  const recovered = snapshot();
  const h = harness(() => {
    attempts++;
    if (attempts === 1) throw new Error('Private internal synchronous failure');
    return Promise.resolve(recovered);
  });
  const failed = h.click();
  assert.equal(await failed, null);
  assert.equal(attempts, 1);
  assert.equal(h.status.dataset.state, 'error');
  assertOutcome(h, 'failure');
  assert.ok(!h.status.textContent.includes('Private internal synchronous failure'));
  assertRestored(h);
  const retry = h.click();
  assert.notStrictEqual(retry, failed, 'a finished failed pass must not lock the button to its old promise');
  assert.equal(h.status.dataset.state, 'loading');
  assertOutcome(h, 'pending');
  assert.strictEqual(await retry, recovered);
  assert.equal(attempts, 2);
  assert.equal(h.status.dataset.state, 'success');
  assertOutcome(h, 'success');
  assert.match(h.status.textContent, /공개 파일 5\/5 수신 완료/);
  assertRestored(h);
});

test('repeated active clicks return one pending promise and perform one controller pass', async () => {
  const pending = deferred();
  const h = harness(() => pending.promise);
  const first = h.click();
  assert.ok(first && typeof first.then === 'function', 'the event listener must return the caught refresh promise');
  const repeatedClick = h.click();
  const direct = h.refresh();
  assert.strictEqual(repeatedClick, first);
  assert.strictEqual(direct, first);
  await Promise.resolve();
  assert.equal(h.calls(), 1);
  pending.resolve(snapshot());
  await first;
  assertRestored(h);
  await h.refresh();
  assert.equal(h.calls(), 2, 'the next completed manual request may start another pass');
});

test('a click during polling reuses the controller in-flight pass and reports its outcome', async () => {
  const pending = deferred();
  let active = null;
  let networkPasses = 0;
  const controller = {
    refresh() {
      if (active) return active;
      networkPasses++;
      active = pending.promise.finally(() => { active = null; });
      return active;
    }
  };
  const polling = controller.refresh();
  const el = elements();
  const manual = bind({ button: el.button, status: el.status, controller, categoryKeys: KEYS });
  const clicked = manual.refresh();
  assert.equal(networkPasses, 1);
  assert.equal(el.status.dataset.state, 'loading');
  assertOutcome(el, 'pending');
  pending.resolve(snapshot());
  await Promise.all([polling, clicked]);
  assert.equal(networkPasses, 1);
  assert.equal(el.status.dataset.state, 'success');
  assertOutcome(el, 'success');
  assertRestored(el);
});

test('all five source files must arrive even when the dashboard presents four category cards', async () => {
  const result = snapshot();
  result.data.categories = result.data.categories.filter(item => item.key !== 'security');
  const h = harness(async () => result);
  await h.refresh();
  assert.equal(result.data.categories.length, 4);
  assert.match(h.status.textContent, /5\/5/);
  assertOutcome(h, 'success');
  delete result.statuses.security;
  await h.refresh();
  assert.equal(h.status.dataset.state, 'warning');
  assert.match(h.status.textContent, /4\/5/);
  assertOutcome(h, 'failure');
});

test('starting a new refresh clears both previous success and failure icons immediately', async () => {
  const secondPass = deferred();
  const thirdPass = deferred();
  let pass = 0;
  const h = harness(() => {
    pass++;
    return pass === 1 ? Promise.resolve(snapshot()) : pass === 2 ? secondPass.promise : thirdPass.promise;
  });
  await h.refresh();
  assertOutcome(h, 'success');
  const second = h.refresh();
  assert.equal(h.status.dataset.state, 'loading');
  assertOutcome(h, 'pending');
  const failure = snapshot();
  failure.statuses.macro.error = 'Invalid public file';
  secondPass.resolve(failure);
  await second;
  assertOutcome(h, 'failure');
  const third = h.refresh();
  assert.equal(h.status.dataset.state, 'loading');
  assertOutcome(h, 'pending');
  thirdPass.resolve(snapshot());
  await third;
  assertOutcome(h, 'success');
  assertRestored(h);
});
