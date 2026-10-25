import test from 'node:test';
import assert from 'node:assert/strict';
import { waterObservationsProxy } from '../../server/providers/waterObservations.js';
import { NWPS_TILES } from '../layers/waterObservations/records.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import {
  ALL_GAUGES,
  GOOD_BUOY_ROWS,
  NOW_MS,
  OTHER_GAUGES,
  fillerGauges,
  ndbcText,
  nwpsTilePayload,
} from '../testSupport/waterObservationsFixtures.mjs';

const MINUTE = 60_000;
const NDBC_PATH = '/data/latest_obs/latest_obs.txt';
const NWPS_PATH = '/nwps/v1/gauges';
const TILES = NWPS_TILES.length;
const ndbc = () => new Response(ndbcText(...GOOD_BUOY_ROWS));

/** Upstream double: the NDBC text file and the NWPS tile endpoint, with per-call overrides. */
function upstream({
  buoys = ndbc,
  tile = (url) => Response.json(nwpsTilePayload(url)),
} = {}) {
  const calls = [];
  const live = { current: 0, max: 0 };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork \(\+/);
    if (parsed.pathname === NDBC_PATH) {
      assert.equal(parsed.hostname, 'www.ndbc.noaa.gov');
      return buoys();
    }
    if (parsed.pathname === NWPS_PATH) {
      assert.equal(parsed.hostname, 'api.water.noaa.gov');
      live.current++;
      live.max = Math.max(live.max, live.current);
      try {
        await new Promise(setImmediate);
        return await tile(url, parsed);
      } finally {
        live.current--;
      }
    }
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, live, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = waterObservationsProxy({ now: () => NOW_MS, ...options });
  assert.equal(plugin.name, 'water-observations');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/water-observations');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

const sourceMeta = (res, id) =>
  res.body.metadata.sources.find((entry) => entry.id === id);
const pathCount = (calls, pathname) =>
  calls.filter(({ url }) => url.pathname === pathname).length;
const counts = (calls) => [
  pathCount(calls, NDBC_PATH),
  pathCount(calls, NWPS_PATH),
];

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves buoys and flooding gauges as one valid collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl }, hook);
    const res = await request('/?url=https://invalid.example&bbox=1,2,3,4');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'water-observations');
    // Fixed upstream URLs: the client query went nowhere.
    const urls = calls.map(({ url }) => url.origin + url.pathname + url.search);
    assert.equal(
      urls[0],
      'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt',
    );
    assert.deepEqual(urls.slice(1).sort(), [
      'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-105&bbox.ymin=0&bbox.xmax=-90&bbox.ymax=35&srid=EPSG_4326',
      'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-105&bbox.ymin=35&bbox.xmax=-90&bbox.ymax=75&srid=EPSG_4326',
      'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-120&bbox.ymin=0&bbox.xmax=-105&bbox.ymax=75&srid=EPSG_4326',
      'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-135&bbox.ymin=0&bbox.xmax=-120&bbox.ymax=75&srid=EPSG_4326',
      'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-180&bbox.ymin=0&bbox.xmax=-135&bbox.ymax=75&srid=EPSG_4326',
      'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-75&bbox.ymin=0&bbox.xmax=-60&bbox.ymax=75&srid=EPSG_4326',
      'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-90&bbox.ymin=0&bbox.xmax=-75&bbox.ymax=34&srid=EPSG_4326',
      'https://api.water.noaa.gov/nwps/v1/gauges?bbox.xmin=-90&bbox.ymin=34&bbox.xmax=-75&bbox.ymax=75&srid=EPSG_4326',
    ]);
    assert.deepEqual(
      res.body.features.map((feature) => feature.id),
      [
        'buoys:41008',
        'buoys:15009',
        'buoys:22108',
        'buoys:41004',
        'buoys:BURL1',
        'rivers:KCFS2',
        'rivers:HNLH1',
        'rivers:EDGE1',
        'rivers:ASTF1',
        'rivers:ATKG1',
        'rivers:HYPO1',
      ],
    );
    assert.deepEqual(
      [...new Set(res.body.features.map((f) => f.properties.source))],
      ['buoys', 'rivers'],
    );
    assert.equal(res.body.metadata.partial, false);
    assert.equal(res.body.metadata.stale, false);
    assert.deepEqual(
      res.body.metadata.sources.map(({ id, count, ok }) => [id, count, ok]),
      [
        ['buoys', 5, true],
        ['rivers', 6, true],
      ],
    );
  });
}

test('guard: the route serves MM as null, the exact ISO time and the knot conversion', async () => {
  const { fetchImpl } = upstream();
  const res = await install({ fetchImpl })();
  const buoy = res.body.features.find((f) => f.id === 'buoys:41008');
  assert.equal(buoy.properties.timestamp, '2026-10-25T10:50:00.000Z');
  assert.equal(buoy.properties.windKt, 25.3);
  assert.equal(buoy.properties.gustKt, 31.1);
  // MM stays null through the JSON round trip: not 0, not a missing key.
  assert.equal(buoy.properties.waterC, null);
  assert.ok(Object.hasOwn(buoy.properties, 'waterC'));
  const river = res.body.features.find((f) => f.id === 'rivers:HYPO1');
  assert.equal(river.properties.category, null);
  assert.equal(river.properties.forecastCategory, 'minor');
});

test('tiles are fetched at most three at a time', async () => {
  const { calls, live, fetchImpl } = upstream();
  await install({ fetchImpl })();
  assert.equal(pathCount(calls, NWPS_PATH), TILES);
  assert.ok(live.max >= 2 && live.max <= 3, `max in flight ${live.max}`);
});

test('each feed refreshes after 15 minutes and not before', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  await request();
  clock = NOW_MS + 15 * MINUTE - 1;
  await request();
  assert.deepEqual(counts(calls), [1, TILES]);
  clock = NOW_MS + 15 * MINUTE;
  await request();
  // The file is still the same one, now 15 minutes older, and still recent.
  assert.deepEqual(counts(calls), [2, 2 * TILES]);
});

test('a tile that answers 504 once is asked again; the snapshot is complete', async () => {
  let failed = false;
  const { calls, fetchImpl } = upstream({
    tile: (url) => {
      if (!failed && url.includes('bbox.xmin=-90&bbox.ymin=34')) {
        failed = true;
        return new Response('gateway timeout', { status: 504 });
      }
      return Response.json(nwpsTilePayload(url));
    },
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'rivers').ok, true);
  assert.equal(sourceMeta(res, 'rivers').count, 6);
  assert.equal(pathCount(calls, NWPS_PATH), TILES + 1);
});

test('a tile that keeps failing fails the river feed only; buoys still serve and nothing is cached for rivers', async () => {
  let clock = NOW_MS;
  let broken = true;
  const { calls, fetchImpl } = upstream({
    tile: (url) =>
      broken && url.includes('bbox.xmin=-90&bbox.ymin=0')
        ? new Response('gateway timeout', { status: 504 })
        : Response.json(nwpsTilePayload(url)),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'water-observations');
  assert.equal(res.body.features.length, 5);
  assert.deepEqual(sourceMeta(res, 'rivers'), {
    id: 'rivers',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'upstream_status',
  });
  assert.equal(sourceMeta(res, 'buoys').ok, true);
  assert.equal(res.body.metadata.partial, true);
  const status = await request('/status');
  assert.deepEqual(
    status.body.sources.map(({ id, cached, lastError }) => [
      id,
      cached,
      lastError,
    ]),
    [
      ['buoys', true, null],
      ['rivers', false, 'upstream_status'],
    ],
  );
  // Inside the failure backoff nothing is retried; after it, NWPS is asked again.
  const tileCalls = pathCount(calls, NWPS_PATH);
  await request();
  assert.equal(pathCount(calls, NWPS_PATH), tileCalls);
  broken = false;
  clock = NOW_MS + MINUTE;
  const recovered = await request();
  assert.equal(sourceMeta(recovered, 'rivers').ok, true);
  assert.equal(recovered.body.features.length, 11);
});

test('NDBC failing while the gauges are fine: gauges served, buoys ok:false', async () => {
  const { fetchImpl } = upstream({
    buoys: () => new Response('busy', { status: 503 }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'water-observations');
  assert.equal(res.body.features.length, 6);
  assert.equal(sourceMeta(res, 'buoys').error, 'upstream_status');
  assert.equal(sourceMeta(res, 'buoys').ok, false);
});

test('a failed refresh serves the last good snapshot as stale', async () => {
  let clock = NOW_MS;
  let fail = false;
  const { fetchImpl } = upstream({
    tile: (url) => {
      if (fail) throw new Error('private upstream details');
      return Response.json(nwpsTilePayload(url));
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  fail = true;
  clock = NOW_MS + 15 * MINUTE;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.metadata.stale, true);
  const rivers = sourceMeta(res, 'rivers');
  assert.deepEqual(
    [rivers.ok, rivers.stale, rivers.count, rivers.error],
    [false, true, 6, 'upstream_unavailable'],
  );
  assert.equal(res.body.features.length, 11);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('an NDBC file that has stopped updating is refused and the last good map is served stale', async () => {
  let clock = NOW_MS;
  const { fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  assert.equal(sourceMeta(await request(), 'buoys').count, 5);
  // The upstream file never changes, so seven hours later every report is too old.
  clock = NOW_MS + 7 * 3_600_000;
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(
    [
      sourceMeta(res, 'buoys').ok,
      sourceMeta(res, 'buoys').stale,
      sourceMeta(res, 'buoys').error,
    ],
    [false, true, 'invalid_payload'],
  );
  assert.equal(sourceMeta(res, 'buoys').count, 5);
});

test('no river at or above action stage is cached like any snapshot and is not an error', async () => {
  let clock = NOW_MS;
  const quiet = [...OTHER_GAUGES, ...fillerGauges(1100)];
  const { calls, fetchImpl } = upstream({
    tile: (url) => Response.json(nwpsTilePayload(url, quiet)),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'water-observations');
  assert.equal(res.body.features.length, 5);
  assert.equal(sourceMeta(res, 'rivers').ok, true);
  assert.equal(sourceMeta(res, 'rivers').count, 0);
  clock = NOW_MS + 14 * MINUTE;
  await request();
  assert.deepEqual(counts(calls), [1, TILES]);
});

test('every tile answering with an empty list is a broken service, never a cached empty map', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    tile: () => Response.json({ gauges: [] }),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'rivers').error, 'invalid_payload');
  assert.equal(sourceMeta(res, 'rivers').count, 0);
  assert.equal(res.body.features.length, 5);
  const before = pathCount(calls, NWPS_PATH);
  clock = NOW_MS + MINUTE;
  await request();
  assert.ok(pathCount(calls, NWPS_PATH) > before, 'retried after the backoff');
});

test('oversized streamed and declared bodies are capped; all failing gives a sanitized 502', async () => {
  for (const declared of [true, false]) {
    let cancelled = 0;
    const huge = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled++;
          },
        }),
        {
          headers: declared
            ? { 'Content-Length': String(64 * 1024 * 1024) }
            : {},
        },
      );
    const { fetchImpl } = upstream({ buoys: huge, tile: huge });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'water_observations_unavailable' });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('malformed data from both feeds never becomes a cached empty snapshot', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    buoys: () => new Response('<html>error</html>'),
    tile: () => Response.json({ error: 'upstream detail' }),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 502);
  clock = NOW_MS + MINUTE;
  const again = await request();
  assert.equal(again.status, 502);
  assert.deepEqual(again.body, { error: 'water_observations_unavailable' });
  // One NDBC request and one failing tile per refresh (the first bad tile
  // stops the rest from starting); two refreshes.
  assert.ok(pathCount(calls, NDBC_PATH) === 2);
  assert.ok(pathCount(calls, NWPS_PATH) >= 2);
});

test('concurrent requests share one upstream operation per feed', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    buoys: async () => {
      await pending;
      return ndbc();
    },
    tile: async (url) => {
      await pending;
      return Response.json(nwpsTilePayload(url));
    },
  });
  const request = install({ fetchImpl });
  const responses = [request(), request('/', 'GET', 'other')];
  await new Promise((resolve) => setTimeout(resolve, 10));
  // NDBC once, and only the first three tiles are in flight.
  assert.deepEqual(counts(calls), [1, 3]);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.deepEqual(counts(calls), [1, TILES]);
});

test('non-GET requests never fetch upstream', async () => {
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl });
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
    const res = await request('/', method);
    assert.equal(res.status, 405);
    assert.equal(res.headers.Allow, 'GET');
  }
  assert.equal(calls.length, 0);
});

test('an unknown sub-route is a 404 and never reaches NOAA', async () => {
  const { calls, fetchImpl } = upstream();
  const res = await install({ fetchImpl })('/anything');
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test('a client over the rate limit gets 429 with Retry-After', async () => {
  const { fetchImpl } = upstream();
  const request = install({ fetchImpl });
  let limited = null;
  for (let i = 0; i < 80 && !limited; i++) {
    const res = await request('/', 'GET', 'noisy');
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'no 429 after 80 requests');
  assert.equal(limited.headers['Retry-After'], '60');
  assert.deepEqual(limited.body, { error: 'rate_limited' });
});

test('the fixture universe really lists enough gauges for the sanity floor', () => {
  assert.ok(ALL_GAUGES.length > 1000);
});
