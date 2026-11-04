(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./parallel-data.js') : root.ParallelData);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ParallelRefresh = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (contract) {
  'use strict';

  const MAX_BYTES = 2 * 1024 * 1024;
  const FAILURE = '병렬 자료 수신·검증 실패 · 마지막 정상 자료 유지';
  const clone = value => value === null ? null : JSON.parse(JSON.stringify(value));
  const byteLength = value => new TextEncoder().encode(value).byteLength;

  // This reads one published file. It does not collect market prices or change
  // source timestamps, and it never reads the five existing producer files.
  function createController({ fetchImpl = globalThis.fetch.bind(globalThis), now = Date.now,
    onChange = () => {}, timeoutMs = 15000, path = 'data/parallel.json' } = {}) {
    let data = null;
    let error = '';
    let lastAttemptAt = null;
    let lastReceivedAt = null;
    let revision = 0;
    let serial = 0;
    let inFlight = null;
    const snapshot = () => ({ data: clone(data), error, lastAttemptAt, lastReceivedAt, revision });

    async function readJson(response) {
      const lengthHeader = response.headers?.get?.('content-length');
      if (lengthHeader !== null && lengthHeader !== undefined && Number(lengthHeader) > MAX_BYTES) throw new Error('size');
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) {
              await reader.cancel();
              throw new Error('size');
            }
            chunks.push(value);
          }
          const joined = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
          return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
        } finally { reader.releaseLock(); }
      }
      if (typeof response.text === 'function') {
        const text = await response.text();
        if (byteLength(text) > MAX_BYTES) throw new Error('size');
        return JSON.parse(text);
      }
      // Small injected fetch adapters may expose only json(). Native browser
      // responses use the bounded stream above.
      const value = await response.json();
      if (byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('size');
      return value;
    }

    async function fetchJson(nonce) {
      const abort = new AbortController();
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const separator = path.includes('?') ? '&' : '?';
            const response = await fetchImpl(`${path}${separator}v=${nonce}`, {
              cache: 'no-store', credentials: 'omit', signal: abort.signal,
              headers: { Accept: 'application/json' }
            });
            if (!response.ok) throw new Error('fetch');
            return readJson(response);
          })(),
          new Promise((_, reject) => { timer = setTimeout(() => {
            abort.abort(); reject(new Error('timeout'));
          }, timeoutMs); })
        ]);
      } catch (reason) {
        abort.abort();
        throw reason;
      } finally { clearTimeout(timer); }
    }

    function noRegression(candidate) {
      if (!data) return;
      const regressed = (next, prior) => prior !== null && prior !== undefined &&
        (next === null || next === undefined || Date.parse(next) < Date.parse(prior));
      if (regressed(candidate.publishedAt, data.publishedAt)) throw new Error('publication regression');
      if (data.schemaVersion === 2 && candidate.schemaVersion !== 2) throw new Error('provider provenance removed');

      const start = Date.parse(candidate.window.start);
      const end = Date.parse(candidate.window.end);
      const inWindow = at => Date.parse(at) >= start && Date.parse(at) <= end;
      const currentSeries = new Map(candidate.series.map(item => [item.id, item]));
      for (const prior of data.series) {
        const item = currentSeries.get(prior.id);
        const retained = prior.points.filter(point => inWindow(point.at));
        if (!item) {
          if (retained.length) throw new Error('overlapping series removed');
          continue;
        }
        // One ID represents one instrument, source and calculation basis. A
        // replacement/correction needs a new ID until an explicit correction
        // contract exists; a publication cannot silently relabel old values.
        for (const key of ['instrument', 'panel', 'basis', 'provider', 'sourceUrl']) {
          if (item[key] !== prior[key]) throw new Error('series identity changed');
        }
        const points = new Map(item.points.map(point => [Date.parse(point.at), point.pct]));
        for (const point of retained) {
          const at = Date.parse(point.at);
          if (!points.has(at) || points.get(at) !== point.pct) throw new Error('overlapping source point changed');
        }
        if (regressed(item.observedAt, prior.observedAt) || regressed(item.asOf, prior.asOf)) throw new Error('source clock regression');
      }

      const currentProviders = new Map((candidate.providers || []).map(provider => [provider.id, provider]));
      for (const priorProvider of data.providers || []) {
        const provider = currentProviders.get(priorProvider.id);
        const retainedReceipts = priorProvider.series.filter(receipt =>
          receipt.samples.some(sample => inWindow(sample.at)));
        if (!provider) {
          if (retainedReceipts.length) throw new Error('provider provenance removed');
          continue;
        }
        for (const key of ['label', 'metric', 'frequency', 'sourceUrl', 'licenseName', 'licenseUrl', 'attribution', 'attributionUrl', 'transformation']) {
          if (provider[key] !== priorProvider[key]) throw new Error('provider identity changed');
        }
        if (regressed(provider.observedAt, priorProvider.observedAt)) throw new Error('provider receipt regression');
        const receipts = new Map(provider.series.map(receipt => [receipt.id, receipt]));
        for (const prior of priorProvider.series) {
          const receipt = receipts.get(prior.id);
          const retainedSamples = prior.samples.filter(sample => inWindow(sample.at));
          if (!receipt) {
            if (retainedSamples.length) throw new Error('raw provenance removed');
            continue;
          }
          if (receipt.asset !== prior.asset || Date.parse(receipt.baseline.at) !== Date.parse(prior.baseline.at) ||
            !contract.sameRate(receipt.baseline.value, prior.baseline.value)) throw new Error('raw comparison basis changed');
          if (regressed(receipt.observedAt, prior.observedAt) || regressed(receipt.latest.at, prior.latest.at)) throw new Error('raw source clock regression');
          if (Date.parse(receipt.latest.at) === Date.parse(prior.latest.at) && !contract.sameRate(receipt.latest.value, prior.latest.value)) throw new Error('latest raw source value changed');
          const samples = new Map(receipt.samples.map(sample => [Date.parse(sample.at), sample.value]));
          for (const sample of retainedSamples) {
            if (!samples.has(Date.parse(sample.at)) || !contract.sameRate(samples.get(Date.parse(sample.at)), sample.value)) throw new Error('retained raw source value changed');
          }
        }
      }

      const currentEvents = new Map(candidate.events.map(item => [item.id, item]));
      for (const prior of data.events) {
        const item = currentEvents.get(prior.id);
        if (!item) {
          if (inWindow(prior.at)) throw new Error('overlapping event removed');
          continue;
        }
        for (const key of ['at', 'type', 'sourceUrl']) {
          if (item[key] !== prior[key]) throw new Error('event identity changed');
        }
        if (prior.verification === 'verified' && item.verification !== 'verified') throw new Error('event verification downgraded');
        if (regressed(item.observedAt, prior.observedAt)) throw new Error('source clock regression');
      }
    }

    async function run() {
      lastAttemptAt = new Date(now()).toISOString();
      const nonce = `${Date.parse(lastAttemptAt)}-${++serial}`;
      try {
        const raw = await fetchJson(nonce);
        // A public fetch can never enable the browser-local reference bypass.
        const candidate = contract.validateDataset(raw, { now: now(), allowLocalReference: false });
        noRegression(candidate);
        if (!data || JSON.stringify(candidate) !== JSON.stringify(data)) {
          data = clone(candidate);
          revision++;
        }
        error = '';
        lastReceivedAt = new Date(now()).toISOString();
      } catch (_) { error = FAILURE; }
      onChange(snapshot());
      return snapshot();
    }

    function refresh() {
      if (inFlight) return inFlight;
      inFlight = run().finally(() => { inFlight = null; });
      return inFlight;
    }
    return { refresh, snapshot };
  }
  return Object.freeze({ createController });
});
