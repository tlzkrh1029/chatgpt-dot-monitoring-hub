(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./public-data.js') : root.MonitorData);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MonitorRefresh = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract) {
  'use strict';

  // One in-flight refresh, with independent last-good values for all five files.
  function createController({ fetchImpl = globalThis.fetch.bind(globalThis), now = Date.now,
    onChange = () => {}, timeoutMs = 15000, baseUrl = '' } = {}) {
    let base = null;
    let inFlight = null;
    let serial = 0;
    const updates = {};
    const statuses = {};
    let baseError = '';
    let lastFetchAt = null;
    let lastLoadedAt = null;
    let revision = 0;
    const keys = Object.keys(contract.CATEGORY_CONFIG);
    const snapshot = () => ({ data: base ? contract.composeData(base, Object.values(updates).filter(update =>
      Date.parse(update.observedAt) >= Date.parse(base.categories.find(c => c.key === update.category).lastCheckAt))) : null,
      statuses: structuredClone(statuses), baseError, lastFetchAt, lastLoadedAt, revision });
    const notify = () => onChange(snapshot());

    async function fetchJson(path, nonce) {
      const abort = new AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const response = await fetchImpl(`${baseUrl}${path}?v=${nonce}`, {
              cache: 'no-store', credentials: 'omit', signal: abort.signal,
              headers: { Accept: 'application/json' }
            });
            if (!response.ok) throw new Error('fetch failed');
            return response.json();
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => {
            abort.abort(); reject(new Error('timeout'));
          }, timeoutMs); })
        ]);
      } finally { clearTimeout(timer); }
    }

    async function run() {
      const nonce = `${now()}-${++serial}`;
      // Fetches are independent. Every settled result is inspected before composing.
      const requests = ['data.json', ...keys.map(key => `data/${key}.json`)];
      const results = await Promise.allSettled(requests.map(path => fetchJson(path, nonce)));
      const options = { now: now() };
      try {
        if (results[0].status !== 'fulfilled') throw new Error('base fetch');
        const candidate = contract.validateData(results[0].value, options);
        if (base && Date.parse(candidate.generatedAt) < Date.parse(base.generatedAt)) throw new Error('base regression');
        if (!base || JSON.stringify(candidate) !== JSON.stringify(base)) {
          base = candidate; revision++;
        }
        baseError = '';
        lastLoadedAt = new Date(now()).toISOString();
      } catch (_) { baseError = '기본 자료를 읽지 못했습니다. 마지막 정상 자료를 유지합니다.'; }

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        try {
          const result = results[i + 1];
          if (result.status !== 'fulfilled') throw new Error('category fetch');
          const candidate = contract.validateCategory(result.value, key, options);
          const prior = updates[key];
          const baseCategory = base && base.categories.find(c => c.key === key);
          const previousObservation = [prior && prior.observedAt, baseCategory && baseCategory.lastCheckAt]
            .filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
          if (prior && Date.parse(candidate.publishedAt) < Date.parse(prior.publishedAt)) throw new Error('publication regression');
          if (previousObservation && Date.parse(candidate.observedAt) < Date.parse(previousObservation)) throw new Error('observation regression');
          // An error report is a publication, never evidence of a new observation.
          if (candidate.checkStatus === 'error' && previousObservation && Date.parse(candidate.observedAt) !== Date.parse(previousObservation)) throw new Error('error advanced observation');
          if (!prior || JSON.stringify(candidate) !== JSON.stringify(prior)) {
            updates[key] = candidate; revision++;
          }
          statuses[key] = { error: '', lastSuccessAt: new Date(now()).toISOString() };
          lastLoadedAt = new Date(now()).toISOString();
        } catch (_) {
          statuses[key] = { ...statuses[key], error: '자료 수신·검증 실패 · 마지막 정상 자료 유지' };
        }
      }
      lastFetchAt = new Date(now()).toISOString();
      notify();
      return snapshot();
    }

    function refresh() {
      if (inFlight) return inFlight;
      inFlight = run().finally(() => { inFlight = null; });
      return inFlight;
    }
    return { refresh, snapshot };
  }
  return { createController };
});
