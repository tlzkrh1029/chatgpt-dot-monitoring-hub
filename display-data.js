/* Lossless presentation only. Presentation helpers for the active publisher. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MonitorView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Fixed feed signal vocabulary (docs/feed-writing-guide.md). A kind outside
  // this list is still shown, as a plain label without signal styling.
  const KIND_STYLES = Object.freeze({ '새 사실': 'k-new', '정정': 'k-new', '누락 보완': 'k-base', '참고': 'k-note',
    '확인 제한': 'k-quiet', '변화 없음': 'k-quiet', '기준점': 'k-base', '감시 설정': 'k-set' });
  // Order of same-time records. Kinds outside the table rank with '참고', so a
  // run written with legacy kinds keeps the writer's order.
  const KIND_RANK = Object.freeze({ '새 사실': 0, '정정': 0, '감시 설정': 1, '기준점': 2, '누락 보완': 3, '참고': 3,
    '확인 제한': 4, '변화 없음': 4 });
  const UNLISTED_RANK = 3;
  // The six kinds monitoring jobs write. '기준점' and '감시 설정' stay displayable for
  // existing base records but are not part of the writing vocabulary.
  const WRITER_KINDS = Object.freeze(['새 사실', '정정', '누락 보완', '참고', '확인 제한', '변화 없음']);
  // Records shown dimmed: quiet checks and the two low-signal kinds.
  const DIM_KINDS = Object.freeze(['변화 없음', '확인 제한']);
  const isDim = item => Boolean(item && (item.isQuiet || DIM_KINDS.includes(item.kind)));
  // Newest first; within one time, dimmed records go last so they never head a
  // check run, then signal kinds come before the rest.
  const rankOf = item => KIND_RANK[item.kind] ?? UNLISTED_RANK;
  const compareRecords = (a, b) => Date.parse(b.at) - Date.parse(a.at)
    || Number(isDim(a)) - Number(isDim(b)) || rankOf(a) - rankOf(b);
  const displayKey = key => key;
  const subtype = () => '';
  const matches = (item, key) => key === 'all' || displayKey(item.category) === displayKey(key);

  function categories(data) {
    const groups = new Map();
    for (const c of data.categories || []) {
      const key = displayKey(c.key);
      if (!groups.has(key)) groups.set(key, { key, name: c.name,
        color: c.color, members: [] });
      groups.get(key).members.push(c);
    }
    return [...groups.values()];
  }

  function groupFeed(items) {
    return items.slice().sort((a,b) => Date.parse(b.at)-Date.parse(a.at))
      .map(item => ({ key: '', label: '', records: [item] }));
  }
  // Reader-facing names for source hosts. Unknown hosts fall back to the bare
  // hostname, so a new source never breaks the list or hides its origin.
  const SOURCE_NAMES = [
    [/(?:^|\.)okx\.com$/, 'OKX'],
    [/(?:^|\.)coinmarketcap\.com$/, 'CoinMarketCap'],
    [/^fred\.stlouisfed\.org$/, 'FRED'],
    [/(?:^|\.)marketwatch\.com$/, 'MarketWatch'],
    [/(?:^|\.)cboe\.com$/, 'Cboe'],
    [/(?:^|\.)eia\.gov$/, 'EIA'],
    [/(?:^|\.)frbservices\.org$/, 'FRB Services'],
    [/^status\.coinbase\.com$/, 'Coinbase 상태'],
    [/^status\.circle\.com$/, 'Circle 상태'],
    [/^status\.kraken\.com$/, 'Kraken 상태'],
    [/^status\.solana\.com$/, 'Solana 상태'],
    [/^status\.mercadobitcoin\.com\.br$/, 'Mercado Bitcoin 상태'],
    [/(?:^|\.)gitbookstatus\.com$/, 'GitBook 상태'],
    [/(?:^|\.)githubstatus\.com$/, 'GitHub 상태'],
    [/(?:^|\.)gitbook\.com$/, 'GitBook'],
    [/(?:^|\.)binance\.com$/, 'Binance'],
    [/(?:^|\.)chainalysis\.com$/, 'Chainalysis'],
    [/(?:^|\.)btcpayserver\.org$/, 'BTCPay'],
    [/(?:^|\.)bitquery\.io$/, 'Bitquery'],
    [/(?:^|\.)cm-arkea\.com$/, 'Crédit Mutuel Arkéa'],
    [/^forum\.arbitrum\.foundation$/, 'Arbitrum 포럼'],
    [/(?:^|\.)(?:x|twitter)\.com$/, 'X'],
    [/^t\.me$/, 'Telegram'],
    [/(?:^|\.)theguardian\.com$/, 'Guardian'],
    [/(?:^|\.)cointelegraph\.com$/, 'Cointelegraph'],
    [/(?:^|\.)ca9\.uscourts\.gov$/, '제9연방항소법원'],
    [/(?:^|\.)ncsbe\.gov$/, 'North Carolina 선관위'],
    [/(?:^|\.)crotononhudson-ny\.gov$/, 'Croton-on-Hudson'],
    [/(?:^|\.)hawaii\.gov$/, 'Hawaii 주정부'],
    [/(?:^|\.)sos\.state\.tx\.us$/, 'Texas 주정부'],
    [/(?:^|\.)sos\.ks\.gov$/, 'Kansas 주정부'],
    [/(?:^|\.)sos\.mn\.gov$/, 'Minnesota 주정부'],
    [/(?:^|\.)nebraska\.gov$/, 'Nebraska 주정부'],
  ];
  function sourceInfo(url) {
    let u;
    try { u = new URL(url); } catch (_) { return { url, name: String(url || ''), detail: '', api: false }; }
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const known = SOURCE_NAMES.find(([pattern]) => pattern.test(host));
    // The address without the scheme, so readers see the real domain as well.
    let detail = `${host}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    try { detail = decodeURIComponent(detail); } catch (_) { /* keep the encoded path */ }
    return { url, name: known ? known[1] : host, detail, api: /\/api\//i.test(u.pathname) };
  }
  // One summary per record: distinct source names in first-seen order.
  function sourceSummary(urls) {
    const sources = (urls || []).map(sourceInfo);
    return { sources, names: [...new Set(sources.map(source => source.name))] };
  }
  return Object.freeze({ KIND_STYLES, KIND_RANK, WRITER_KINDS, DIM_KINDS, isDim, compareRecords,
    displayKey, subtype, matches, categories, groupFeed, sourceInfo, sourceSummary });
});
