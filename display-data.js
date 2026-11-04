/* Lossless presentation only. The five publisher keys and JSON contracts stay independent. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MonitorView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SECURITY_NAME = '크립토 보안·해킹';
  const SUBTYPES = Object.freeze({ security: '사건·복구', onchain: 'ZachXBT 조사·자금 추적' });
  const displayKey = key => key === 'onchain' ? 'security' : key;
  const subtype = key => SUBTYPES[key] || '';
  const matches = (item, key) => key === 'all' || displayKey(item.category) === displayKey(key);

  function categories(data) {
    const groups = new Map();
    for (const c of data.categories || []) {
      const key = displayKey(c.key);
      if (!groups.has(key)) groups.set(key, { key, name: key === 'security' ? SECURITY_NAME : c.name,
        color: key === 'security' ? '#F0B429' : c.color, members: [] });
      groups.get(key).members.push(c);
    }
    for (const group of groups.values()) group.members.sort((a, b) =>
      (a.key === 'security' ? 0 : 1) - (b.key === 'security' ? 0 : 1));
    return [...groups.values()];
  }

  // Group only clearly named subjects. Roundups mentioning multiple subjects
  // and unnamed investigations remain separate. These are related records,
  // never an inferred count of incidents or a combined loss/recovery amount.
  const SUBJECTS = [
    ['binance', 'Binance', /\bBinance\b|바이낸스/i],
    ['gitbook', 'GitBook', /\bGitBook\b|깃북/i],
    ['mercado', 'Mercado Bitcoin', /\bMercado(?:\s+Bitcoin)?\b|메르카도/i],
    ['btcpay', 'BTCPay', /\bBTCPay(?:\s+Server)?\b/i],
    ['chainalysis', 'Chainalysis', /\bChainalysis\b/i],
  ];
  function subject(item) {
    if (!subtype(item.category) || item.isQuiet) return null;
    const title = SUBJECTS.filter(([, , pattern]) => pattern.test(item.title || ''));
    const body = SUBJECTS.filter(([, , pattern]) => pattern.test(item.text || ''));
    // A single-subject title cannot turn a multi-subject roundup into one case.
    if (body.length > 1 || title.length > 1) return null;
    const found = title.length ? title : body;
    return found.length === 1 && (!body.length || !title.length || body[0][0] === title[0][0]) ? found[0] : null;
  }
  function groupFeed(items) {
    const groups = [];
    const named = new Map();
    const sorted = items.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    for (const item of sorted) {
      const match = subject(item);
      let group = match && named.get(match[0]);
      if (!group) {
        group = { key: match ? match[0] : '', label: match ? match[1] : '', records: [] };
        groups.push(group);
        if (match) named.set(match[0], group);
      }
      group.records.push(item);
    }
    return groups;
  }
  return Object.freeze({ SECURITY_NAME, displayKey, subtype, matches, categories, groupFeed });
});
