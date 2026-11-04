/* Public publication contract, shared by the dashboard and offline validation.
 * This is an allowlist, not proof that prose is public: writers must summarize
 * public evidence and exclude personal account details before committing.
 * Category writers own only data/<category>.json. They never rewrite data.json.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MonitorData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MINUTE = 60 * 1000;
  const CLOCK_SKEW_MS = 5 * MINUTE;
  const CATEGORY_CONFIG = Object.freeze({
    macro: Object.freeze({ name: '거시·크립토', color: '#F2555A', staleAfterMs: 90 * MINUTE }),
    election: Object.freeze({ name: '미국 중간선거', color: '#5B9BFF', staleAfterMs: 90 * MINUTE }),
    security: Object.freeze({ name: '크립토 보안', color: '#F0B429', staleAfterMs: 90 * MINUTE }),
    xr: Object.freeze({ name: 'X 계정 연구', color: '#B197FC', staleAfterMs: 300 * MINUTE }),
    onchain: Object.freeze({ name: '온체인 보안·자금흐름 추적', color: '#50C4AE', staleAfterMs: 90 * MINUTE })
  });
  const KEYS = Object.freeze(Object.keys(CATEGORY_CONFIG));
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  function fail(path, reason) { throw new Error(`${path}: ${reason}`); }
  function object(v, path, allowed, required = allowed) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail(path, 'expected a plain object');
    for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(path, 'unrecognized field');
    for (const k of required) if (!own(v, k)) fail(`${path}.${k}`, 'required field missing');
  }
  function list(v, path, max = 100000) {
    if (!Array.isArray(v) || v.length > max) fail(path, 'expected an array within size limit');
  }
  function text(v, path, max = 8000, allowEmpty = true) {
    if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim())) fail(path, 'expected plain text within size limit');
    // Links belong only in the reviewed sources field, never prose or account fields.
    if (/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|(?:[a-z0-9-]+\.)?notion\.(?:so|site|com)\b)/i.test(v) || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(v)) fail(path, 'links or personal contact details are not allowed in prose');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) fail(path, 'control characters are not allowed');
    if (/(?:\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*\S+)/i.test(v)) fail(path, 'possible credentials are not allowed');
    return v;
  }
  function publicUrl(v, path = 'source') {
    if (typeof v !== 'string' || v.length > 2048) fail(path, 'expected a public HTTPS source URL');
    let u;
    try { u = new URL(v); } catch (_) { fail(path, 'invalid source URL'); }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443')) fail(path, 'only HTTPS without credentials, fragments or nonstandard ports is allowed');
    if (!host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || /(?:^|\.)(?:localhost|local|internal|lan|test|example|invalid|notion\.so|notion\.site|notion\.com|docs\.google\.com|drive\.google\.com|slack\.com|chatgpt\.com|dropbox\.com|box\.com|onedrive\.live\.com)$/.test(host)) fail(path, 'private or unsupported source host');
    const decodedPath = decodeUrlComponent(u.pathname, path).replace(/\\/g, '/');
    if (/(?:^|\/)(?:settings|account|accounts|login|signin|sign-in|profile)(?:\/|$)/i.test(decodedPath)) fail(path, 'account or settings URLs are not public sources');
    if (/(?:^|\.)(?:x\.com|twitter\.com)$/.test(host) && !/^\/[A-Za-z0-9_]+\/status\/\d+\/?$/.test(u.pathname)) fail(path, 'X sources must point to an individual public post');
    for (const [rawKey, rawValue] of u.searchParams) {
      const key = decodeUrlComponent(rawKey, path);
      const value = decodeUrlComponent(rawValue, path);
      if (/(?:token|api.?key|secret|auth|password|signature|session|jwt|^sig$|^code$)/i.test(key)) fail(path, 'credential-bearing query parameters are not allowed');
      // A source must be a direct public URL. Redirect wrappers can otherwise
      // conceal a private workspace URL in an encoded query parameter.
      if (/(?:[a-z][a-z0-9+.-]*:)?\/\/|(?:notion\.(?:so|site|com)|docs\.google\.com|drive\.google\.com|slack\.com|chatgpt\.com|dropbox\.com|box\.com|onedrive\.live\.com)(?:[/:?\s]|$)/i.test(value)) fail(path, 'nested URLs and workspace links are not allowed in source parameters');
    }
    if (/\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{20,}/.test(v)) fail(path, 'possible credentials in source URL');
    return v;
  }
  function decodeUrlComponent(v, path) {
    let decoded = v;
    for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(decoded); i++) {
      try { decoded = decodeURIComponent(decoded); } catch (_) { fail(path, 'invalid source URL encoding'); }
    }
    if (/%[0-9a-f]{2}/i.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) fail(path, 'ambiguous source URL encoding');
    return decoded;
  }
  function nowValue(now) {
    const n = now === undefined ? Date.now() : Number(new Date(now));
    if (!Number.isFinite(n)) fail('now', 'invalid clock');
    return n;
  }
  function date(v, path, now) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(v)) fail(path, 'expected an ISO UTC timestamp');
    const n = Date.parse(v);
    if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 19) !== v.slice(0, 19)) fail(path, 'invalid timestamp');
    if (n > now + CLOCK_SKEW_MS) fail(path, 'timestamp is in the future');
    return n;
  }
  function category(v, path) {
    if (!KEYS.includes(v)) fail(path, 'unknown category');
    return v;
  }
  function feedItem(item, path, now, { withCategory = false, observedAt, publishedAt } = {}) {
    const allowed = ['at', 'kind', 'title', 'text', 'evidence', 'timeBasis', 'sources'];
    if (withCategory) allowed.push('category');
    object(item, path, allowed, withCategory ? ['at', 'category', 'kind', 'title', 'text'] : ['at', 'kind', 'title', 'text']);
    const at = date(item.at, `${path}.at`, now);
    if (withCategory) category(item.category, `${path}.category`);
    for (const k of ['kind', 'title', 'text', 'evidence']) if (own(item, k)) text(item[k], `${path}.${k}`, k === 'kind' ? 60 : 8000, k === 'evidence');
    if (own(item, 'timeBasis') && !['observation', 'notification'].includes(item.timeBasis)) fail(`${path}.timeBasis`, 'invalid time basis');
    const basis = item.timeBasis || 'observation';
    if (observedAt !== undefined && basis === 'observation' && at > observedAt) fail(`${path}.at`, 'observation record is newer than the evidence check');
    if (publishedAt !== undefined && at > publishedAt) fail(`${path}.at`, 'record is newer than publication');
    if (own(item, 'sources')) {
      list(item.sources, `${path}.sources`, 8);
      item.sources.forEach((source, i) => publicUrl(source, `${path}.sources[${i}]`));
    }
  }
  function validateData(raw, options = {}) {
    const now = nowValue(options.now);
    const required = ['generatedAt', 'latestRunAt', 'setting', 'warnings', 'categories', 'feed', 'gaps', 'events', 'quiet', 'links'];
    object(raw, 'data', required.concat('schemaVersion'), required);
    if (own(raw, 'schemaVersion') && raw.schemaVersion !== 1) fail('data.schemaVersion', 'unsupported schema version');
    const pub = date(raw.generatedAt, 'data.generatedAt', now);
    const last = date(raw.latestRunAt, 'data.latestRunAt', now);
    object(raw.setting, 'data.setting', ['title', 'level', 'at', 'by', 'reason', 'evidence', 'next', 'release'], ['title', 'level', 'at', 'by', 'reason', 'evidence']);
    for (const key of Object.keys(raw.setting)) if (key !== 'at') text(raw.setting[key], `data.setting.${key}`, 8000, false);
    date(raw.setting.at, 'data.setting.at', now);
    list(raw.warnings, 'data.warnings', 50);
    raw.warnings.forEach((w, i) => text(w, `data.warnings[${i}]`));
    list(raw.categories, 'data.categories', 5);
    if (raw.categories.length !== 5) fail('data.categories', 'all five categories are required');
    const seen = new Set();
    const observed = new Map();
    raw.categories.forEach((c, i) => {
      const p = `data.categories[${i}]`;
      object(c, p, ['key', 'name', 'color', 'headline', 'body', 'lastCheckAt', 'unknown']);
      category(c.key, `${p}.key`);
      if (seen.has(c.key)) fail(p, 'duplicate category');
      seen.add(c.key);
      if (c.name !== CATEGORY_CONFIG[c.key].name || c.color !== CATEGORY_CONFIG[c.key].color) fail(p, 'category identity must match the fixed configuration');
      for (const k of ['headline', 'body', 'unknown']) text(c[k], `${p}.${k}`);
      const checked = date(c.lastCheckAt, `${p}.lastCheckAt`, now);
      if (checked > pub) fail(`${p}.lastCheckAt`, 'evidence check is newer than publication');
      observed.set(c.key, checked);
    });
    if (last !== Math.max(...observed.values())) fail('data.latestRunAt', 'must equal the latest actual category observation');
    list(raw.feed, 'data.feed');
    raw.feed.forEach((item, i) => feedItem(item, `data.feed[${i}]`, now, { withCategory: true, observedAt: observed.get(item.category), publishedAt: pub }));
    list(raw.gaps, 'data.gaps', 1000);
    raw.gaps.forEach((g, i) => {
      const p = `data.gaps[${i}]`;
      object(g, p, ['category', 'label', 'text']); category(g.category, `${p}.category`);
      text(g.label, `${p}.label`, 200); text(g.text, `${p}.text`);
    });
    list(raw.events, 'data.events', 0);
    object(raw.links, 'data.links', []);
    list(raw.quiet, 'data.quiet');
    raw.quiet.forEach((q, i) => {
      const p = `data.quiet[${i}]`;
      object(q, p, ['at', 'category', 'text']); category(q.category, `${p}.category`); text(q.text, `${p}.text`);
      if (date(q.at, `${p}.at`, now) > observed.get(q.category)) fail(`${p}.at`, 'quiet check is newer than category observation');
    });
    return clone(raw);
  }
  function validateCategory(raw, expectedKey, options = {}) {
    const now = nowValue(options.now);
    const fields = ['schemaVersion', 'category', 'publishedAt', 'observedAt', 'checkStatus', 'headline', 'body', 'unknown', 'gap', 'feed'];
    object(raw, 'category', fields);
    if (raw.schemaVersion !== 1) fail('category.schemaVersion', 'unsupported schema version');
    category(expectedKey, 'expectedKey'); category(raw.category, 'category.category');
    if (raw.category !== expectedKey) fail('category.category', 'does not match the owned category file');
    const pub = date(raw.publishedAt, 'category.publishedAt', now);
    const observed = date(raw.observedAt, 'category.observedAt', now);
    if (observed > pub) fail('category.observedAt', 'evidence check is newer than publication');
    if (!['ok', 'partial', 'error'].includes(raw.checkStatus)) fail('category.checkStatus', 'invalid check status');
    for (const key of ['headline', 'body', 'unknown', 'gap']) text(raw[key], `category.${key}`);
    if (raw.checkStatus !== 'ok' && !raw.gap.trim()) fail('category.gap', 'partial and error checks must describe the missing evidence');
    list(raw.feed, 'category.feed', 200);
    raw.feed.forEach((item, i) => feedItem(item, `category.feed[${i}]`, now, { observedAt: observed, publishedAt: pub }));
    return clone(raw);
  }
  function composeData(base, updates = []) {
    // Inputs have already passed boundary validation. Composition never changes
    // the user's alert setting, drops history, or assigns new observation times.
    const result = clone(base);
    const envelopes = Array.isArray(updates) ? updates : Object.values(updates);
    const seen = new Set();
    for (const update of envelopes) {
      if (!update) continue;
      const key = category(update.category, 'update.category');
      if (seen.has(key)) fail('updates', 'duplicate category envelope');
      seen.add(key);
      const i = result.categories.findIndex((c) => c.key === key);
      if (i < 0) fail('updates', 'missing base category');
      const previous = result.categories[i];
      if (Date.parse(update.observedAt) < Date.parse(previous.lastCheckAt)) fail('update.observedAt', 'cannot regress the known evidence check');
      result.categories[i] = { ...previous, headline: update.headline, body: update.body, unknown: update.unknown,
        lastCheckAt: update.observedAt, observedAt: update.observedAt, publishedAt: update.publishedAt,
        checkStatus: update.checkStatus, gap: update.gap };
      result.gaps = result.gaps.filter((g) => g.category !== key);
      if (update.gap) result.gaps.push({ category: key, label: '확인 제한', text: update.gap });
      for (const item of update.feed) result.feed.push({ ...clone(item), category: key });
      if (Date.parse(update.publishedAt) > Date.parse(result.generatedAt)) result.generatedAt = update.publishedAt;
    }
    const unique = new Set();
    result.feed = result.feed.filter((item) => {
      // A correction with different text remains visible beside its old record.
      const id = JSON.stringify([item.category, item.at, item.kind, item.title, item.text, item.timeBasis || 'observation', item.sources || [], item.evidence || '']);
      if (unique.has(id)) return false;
      unique.add(id); return true;
    }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    result.latestRunAt = result.categories.reduce((last, c) => Date.parse(c.lastCheckAt) > Date.parse(last) ? c.lastCheckAt : last, result.categories[0].lastCheckAt);
    return result;
  }
  function freshness(data, now = Date.now()) {
    const clock = nowValue(now);
    const categories = data.categories.map((c) => {
      const observedAt = c.observedAt || c.lastCheckAt;
      const ageMs = Math.max(0, clock - Date.parse(observedAt));
      const staleAfterMs = CATEGORY_CONFIG[c.key].staleAfterMs;
      return { key: c.key, observedAt, publishedAt: c.publishedAt || data.generatedAt,
        checkStatus: c.checkStatus || 'partial', ageMs, stale: ageMs > staleAfterMs, staleAfterMs };
    });
    const observations = categories.map((c) => c.observedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
    const staleKeys = categories.filter((c) => c.stale).map((c) => c.key);
    return { allFresh: staleKeys.length === 0, staleKeys, latestObservationAt: observations[observations.length - 1],
      oldestObservationAt: observations[0], publicationAt: data.generatedAt, categories };
  }
  return Object.freeze({ CATEGORY_CONFIG, validateData, validateCategory, publicUrl, composeData, freshness });
});
