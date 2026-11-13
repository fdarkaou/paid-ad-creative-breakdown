import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAd, parseApp, toReport, diff, diffLines, toCsv, toMarkdown, median } from '../breakdown.js';

const cur = JSON.parse(readFileSync(new URL('../examples/breakdown.json', import.meta.url)));
const prev = JSON.parse(readFileSync(new URL('../examples/previous.json', import.meta.url)));

test('parseAd accepts platform:id, canonicalKey and Meta ad library links', () => {
  assert.deepEqual(parseAd('meta:111222333'), { platform: 'meta', archiveId: '111222333' });
  assert.deepEqual(parseAd('paid:tiktok:74000'), { platform: 'tiktok', archiveId: '74000' });
  assert.deepEqual(parseAd('https://www.facebook.com/ads/library?id=111222333'), { platform: 'meta', archiveId: '111222333' });
  assert.equal(parseAd('google:1'), null);
  assert.deepEqual(parseApp('https://apps.apple.com/us/app/x/id1000000001=Rival'), { storeId: '1000000001', label: 'Rival' });
});

test('report reads analysis state, timeline and transcript as returned', () => {
  const r = toReport(cur);
  assert.equal(r.totals.ads, 3);
  assert.deepEqual(r.totals.byStatus, { ready: 2, pending: 0, failed: 0, not_requested: 1 });
  assert.equal(r.totals.withTimeline, 2);
  assert.equal(r.totals.medianDurationSeconds, 20.5);
  assert.equal(r.totals.productInFirst3s, 1);
  assert.equal(r.ads[0].daysLive, 72);
  assert.equal(r.ads[0].transcript.words, 20);
  assert.equal(r.ads[2].analysis, null);
  // ingredients count once per ad, case-insensitive
  assert.deepEqual(r.ingredients[0], { key: 'product demonstration', count: 2 });
});

test('a pending state wins over an analysis on the ad read; no state means the ad read decides', () => {
  const e = cur.ads[0];
  const pending = toReport({ ads: [{ ...e, analysisState: { status: 'pending', requestedAt: '2026-11-13T08:00:00.000Z' } }] });
  assert.equal(pending.ads[0].analysis, null);
  assert.equal(pending.ads[0].analysisStatus, 'pending');
  const noState = toReport({ ads: [{ platform: e.platform, archiveId: e.archiveId, ad: e.ad }] });
  assert.equal(noState.ads[0].analysisStatus, 'ready');
});

test('diff finds new ads, status moves, gone ads and new ingredients', () => {
  const d = diff(toReport(cur), prev);
  assert.equal(d.newAds.length, 1);
  assert.deepEqual(d.statusChanges.map((x) => [x.from, x.to]), [['pending', 'ready']]);
  assert.equal(d.gone.length, 1);
  assert.deepEqual(d.newIngredients.sort(), ['outcome shown first', 'pov caption', 'screen recording']);
  assert.ok(diffLines(d).length >= 4);
});

test('outputs and bad input', () => {
  const r = toReport(cur);
  assert.equal(toCsv(r).split('\n').length, 4);
  assert.match(toMarkdown(r), /not performance/);
  assert.throws(() => toReport({ items: [] }), /Expected/);
  assert.equal(median([3, null, 1, 2]), 2);
});

test('a bare ad read (or an array of them) is accepted', () => {
  const r = toReport(cur.ads[1].ad);
  assert.equal(r.ads[0].key, 'tiktok:7400000000000000002');
  assert.equal(r.ads[0].analysisStatus, 'ready');
  assert.equal(toReport([cur.ads[0].ad, cur.ads[2].ad]).ads[1].analysisStatus, null);
});
