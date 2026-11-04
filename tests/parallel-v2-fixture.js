'use strict';

// Deliberately synthetic rates used only by provider-contract and UI tests.
module.exports = function fixture() {
  const id = 'synthetic-btc-2026-11-04';
  const sourceUrl = 'https://gitbook-docs.coinmetrics.io/coin-metrics-prices/coin-metrics-prices/reference-rate-metrics';
  return {
    schemaVersion: 2, mode: 'observed', title: 'Synthetic live contract fixture', publishedAt: '2026-11-04T00:35:00Z',
    window: { start: '2026-11-03T23:00:00Z', end: '2026-11-04T00:34:00Z', timezone: 'Asia/Seoul', intervalMinutes: 15 },
    series: [{ id, panel: 'crypto', label: 'BTC', instrument: 'Synthetic ReferenceRateUSD USD', basis: '2026-11-04 08:00 KST synthetic baseline',
      provider: 'Coin Metrics synthetic fixture', sourceUrl, verification: 'verified', redistribution: 'permitted', availability: 'available',
      asOf: '2026-11-04T00:30:00Z', observedAt: '2026-11-04T00:34:30Z', delaySeconds: 30, marketState: 'unknown',
      points: [{ at: '2026-11-03T23:00:00Z', pct: 0 }, { at: '2026-11-04T00:30:00Z', pct: (102 / 100 - 1) * 100 }] }],
    providers: [{ id: 'coinmetrics-community-reference-rate', label: 'Coin Metrics Community ReferenceRateUSD', metric: 'ReferenceRateUSD', frequency: '1m',
      sourceUrl, requestUrl: 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=ReferenceRateUSD&frequency=1m',
      licenseName: 'CC BY-NC 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      attribution: 'Data: Coin Metrics', attributionUrl: 'https://coinmetrics.io/', transformation: 'Synthetic exact 15-minute samples and percentage calculation.',
      observedAt: '2026-11-04T00:34:30Z', requestedStartAt: '2026-11-03T23:00:00Z', requestedEndAt: '2026-11-04T00:34:00Z', pages: 1,
      series: [{ id, asset: 'btc', observedAt: '2026-11-04T00:34:30Z', baseline: { at: '2026-11-03T23:00:00Z', value: '100.00' },
        latest: { at: '2026-11-04T00:34:00Z', value: '103.00' }, samples: [{ at: '2026-11-03T23:00:00Z', value: '100.00' }, { at: '2026-11-04T00:30:00Z', value: '102.00' }] }] }],
    events: [], stories: []
  };
};
