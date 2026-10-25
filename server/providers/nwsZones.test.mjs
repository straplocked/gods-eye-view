import assert from 'node:assert/strict';
import test from 'node:test';
import { createNwsZoneResolver } from './nwsZones.js';
import {
  polygonGeometry,
  squareRing,
  zoneFeature,
  zoneUrl,
} from '../../src/testSupport/weatherWarningsFixtures.mjs';

const url = (n) => zoneUrl(`TXZ${100 + n}`);
const square = (id) =>
  zoneFeature(id, polygonGeometry(squareRing(-100, 30, 1)));
const okZone = async (zone) => square(zone.split('/').pop());
const DAY = 24 * 3600 * 1000;

test('lookup distinguishes resolved, gone and not-yet-resolved zones', async () => {
  const zones = createNwsZoneResolver();
  assert.equal(zones.lookup(url(1)), undefined);
  assert.equal(zones.needsFetch(url(1)), true);
  await zones.fill([url(1), url(2)], {
    fetchZone: async (zone) => (zone === url(2) ? null : square('TXZ101')),
  });
  assert.deepEqual(zones.lookup(url(1)), [[squareRing(-100, 30, 1)]]);
  assert.equal(zones.lookup(url(2)), null);
  assert.equal(zones.needsFetch(url(1)), false);
  assert.equal(zones.needsFetch(url(2)), false);
  assert.equal(zones.size(), 2);
});

test('urls that are not api.weather.gov zones are never fetched', async () => {
  const zones = createNwsZoneResolver();
  const seen = [];
  const stats = await zones.fill(
    [
      'https://evil.example/zones/forecast/TXZ101',
      'file:///etc/passwd',
      url(1),
    ],
    {
      fetchZone: async (zone) => {
        seen.push(zone);
        return square('TXZ101');
      },
    },
  );
  assert.deepEqual(seen, [url(1)]);
  assert.equal(stats.attempted, 1);
});

test('the budget caps attempts per fill and reports the deferred rest', async () => {
  const zones = createNwsZoneResolver({ maxNewPerRefresh: 3 });
  const seen = [];
  const stats = await zones.fill([1, 2, 3, 4, 5, 6, 7].map(url), {
    fetchZone: async (zone) => {
      seen.push(zone);
      return square('TXZ101');
    },
  });
  assert.deepEqual(seen, [url(1), url(2), url(3)]);
  assert.deepEqual(stats, {
    attempted: 3,
    resolved: 3,
    gone: 0,
    failed: 0,
    deferred: 4,
  });
  // Failed attempts spend budget too.
  const failing = createNwsZoneResolver({ maxNewPerRefresh: 2 });
  const failedStats = await failing.fill([1, 2, 3].map(url), {
    fetchZone: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(failedStats.attempted, 2);
  assert.equal(failedStats.failed, 2);
  assert.equal(failedStats.deferred, 1);
});

test('at most four zone requests are in flight', async () => {
  const zones = createNwsZoneResolver({ maxNewPerRefresh: 20 });
  let active = 0;
  let peak = 0;
  await zones.fill(
    Array.from({ length: 10 }, (_, i) => url(i)),
    {
      fetchZone: async (zone) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(setImmediate);
        active -= 1;
        return okZone(zone);
      },
    },
  );
  assert.equal(peak, 4);
});

test('no new request starts after the deadline or an abort', async () => {
  let clock = 0;
  const zones = createNwsZoneResolver({
    now: () => clock,
    deadlineMs: 1000,
    concurrency: 1,
  });
  const seen = [];
  const stats = await zones.fill([1, 2, 3, 4].map(url), {
    fetchZone: async (zone) => {
      seen.push(zone);
      clock += 600;
      return okZone(zone);
    },
  });
  // 0 ms and 600 ms are inside the deadline; 1200 ms is not.
  assert.equal(seen.length, 2);
  assert.equal(stats.deferred, 2);
  assert.equal(zones.lookup(url(3)), undefined);

  const controller = new AbortController();
  const abortable = createNwsZoneResolver({ concurrency: 1 });
  const done = [];
  await abortable.fill([1, 2, 3].map(url), {
    signal: controller.signal,
    fetchZone: async (zone) => {
      done.push(zone);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    },
  });
  assert.equal(done.length, 1);
  // An aborted fetch is not remembered as a failure: it is simply retried.
  assert.equal(abortable.needsFetch(url(1)), true);
});

test('a failing zone is retried after five minutes, not before', async () => {
  let clock = 0;
  const zones = createNwsZoneResolver({ now: () => clock });
  await zones.fill([url(1)], {
    fetchZone: async () => {
      throw new Error('503');
    },
  });
  assert.equal(zones.lookup(url(1)), undefined);
  clock = 5 * 60_000 - 1;
  assert.equal(zones.needsFetch(url(1)), false);
  clock = 5 * 60_000;
  assert.equal(zones.needsFetch(url(1)), true);
});

test('zones live for a week; an expired copy keeps being served while it refreshes', async () => {
  let clock = 0;
  const zones = createNwsZoneResolver({ now: () => clock });
  await zones.fill([url(1)], { fetchZone: okZone });
  clock = 7 * DAY - 1;
  assert.equal(zones.needsFetch(url(1)), false);
  clock = 7 * DAY;
  assert.equal(zones.needsFetch(url(1)), true);
  assert.ok(zones.lookup(url(1)), 'expired zone is still served');
  // A failed refresh keeps the old polygons.
  await zones.fill([url(1)], {
    fetchZone: async () => {
      throw new Error('503');
    },
  });
  assert.ok(zones.lookup(url(1)));
  // A successful refresh replaces them and restarts the week.
  clock += 5 * 60_000;
  await zones.fill([url(1)], { fetchZone: okZone });
  assert.equal(zones.needsFetch(url(1)), false);
});

test('zones without an area are left alone for a day, and oversized ones are gone', async () => {
  let clock = 0;
  const zones = createNwsZoneResolver({ now: () => clock });
  await zones.fill([url(1), url(2)], {
    fetchZone: async (zone) => {
      if (zone === url(2))
        throw Object.assign(new Error('big'), { code: 'RESPONSE_TOO_LARGE' });
      return zoneFeature('TXZ101', null);
    },
  });
  assert.equal(zones.lookup(url(1)), null);
  assert.equal(zones.lookup(url(2)), null);
  clock = DAY - 1;
  assert.equal(zones.needsFetch(url(1)), false);
  clock = DAY;
  assert.equal(zones.needsFetch(url(1)), true);
});

test('a payload that is not a zone feature is a failure, not a cached empty', async () => {
  const zones = createNwsZoneResolver();
  const stats = await zones.fill([url(1)], {
    fetchZone: async () => ({ type: 'FeatureCollection', features: [] }),
  });
  assert.equal(stats.failed, 1);
  assert.equal(zones.lookup(url(1)), undefined);
});

test('the cache is bounded; the oldest zones go first', async () => {
  const zones = createNwsZoneResolver({ maxEntries: 3 });
  await zones.fill([1, 2, 3, 4].map(url), { fetchZone: okZone });
  assert.equal(zones.size(), 3);
  assert.equal(zones.lookup(url(1)), undefined);
  assert.ok(zones.lookup(url(4)));
});
