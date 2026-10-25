import test from 'node:test';
import assert from 'node:assert/strict';
import { citizenSensorsProxy } from '../../server/providers/citizenSensors.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import {
  AIR_READINGS,
  NOW_MS,
  measurement,
  reading,
  safecastAnswer,
} from '../testSupport/citizenSensorsFixtures.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const AIR_PATH = '/static/v2/data.dust.min.json';
const SAFECAST_PATH = '/measurements.json';

/** Upstream double: the Sensor.Community file and the Safecast API, with per-call overrides. */
function upstream({
  air = () => Response.json(AIR_READINGS),
  safecast = (url) => Response.json(safecastAnswer(url)),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork \(\+/);
    if (parsed.pathname === AIR_PATH) {
      assert.equal(parsed.hostname, 'data.sensor.community');
      return air();
    }
    if (parsed.pathname === SAFECAST_PATH) {
      assert.equal(parsed.hostname, 'api.safecast.org');
      return safecast(url, parsed);
    }
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = citizenSensorsProxy({ now: () => NOW_MS, ...options });
  assert.equal(plugin.name, 'citizen-sensors');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/citizen-sensors');
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
        this.text = body;
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
  pathCount(calls, AIR_PATH),
  pathCount(calls, SAFECAST_PATH),
];
const pageOf = (url) => Number(url.searchParams.get('page'));

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves PM cells and radiation devices as one valid collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl }, hook);
    const res = await request('/?url=https://invalid.example&bbox=1,2,3,4');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'citizen-sensors');
    // Fixed upstream URLs: the client query went nowhere.
    const urls = calls.map(({ url }) => url.origin + url.pathname + url.search);
    assert.deepEqual(urls, [
      'https://data.sensor.community/static/v2/data.dust.min.json',
      // Six one-hour windows, newest first, one page each.
      'https://api.safecast.org/measurements.json?captured_after=2026-10-25T08:00:00Z&captured_before=2026-10-25T09:00:00Z&per_page=1000&page=1',
      'https://api.safecast.org/measurements.json?captured_after=2026-10-25T07:00:00Z&captured_before=2026-10-25T08:00:00Z&per_page=1000&page=1',
      'https://api.safecast.org/measurements.json?captured_after=2026-10-25T06:00:00Z&captured_before=2026-10-25T07:00:00Z&per_page=1000&page=1',
      'https://api.safecast.org/measurements.json?captured_after=2026-10-25T05:00:00Z&captured_before=2026-10-25T06:00:00Z&per_page=1000&page=1',
      'https://api.safecast.org/measurements.json?captured_after=2026-10-25T04:00:00Z&captured_before=2026-10-25T05:00:00Z&per_page=1000&page=1',
      'https://api.safecast.org/measurements.json?captured_after=2026-10-25T03:00:00Z&captured_before=2026-10-25T04:00:00Z&per_page=1000&page=1',
    ]);
    assert.deepEqual(
      res.body.features.map((feature) => feature.id),
      [
        'airpm:1891_1385',
        'airpm:1093_565',
        'airpm:1823_1388',
        'airpm:2572_1186',
        'airpm:2964_1299',
        'airpm:3599_1000',
        'radiation:d65002',
        'radiation:d401',
        'radiation:d400',
        'radiation:d301',
        'radiation:g18860_13765',
        'radiation:d255',
        'radiation:g19069_14385',
      ],
    );
    assert.deepEqual(
      [...new Set(res.body.features.map((f) => f.properties.source))],
      ['airpm', 'radiation'],
    );
    assert.equal(res.body.metadata.partial, false);
    assert.equal(res.body.metadata.stale, false);
    assert.deepEqual(
      res.body.metadata.sources.map(({ id, count, ok }) => [id, count, ok]),
      [
        ['airpm', 6, true],
        ['radiation', 7, true],
      ],
    );
    // The normalizers' counts ride along as flat scalars. Rows read: the 27
    // fixture rows less the five outside every window (an empty entry, a text
    // entry, a missing time, 2029 and 02:00), plus the 08:00:00 row that both
    // the first and the second hour ask for.
    assert.equal(sourceMeta(res, 'airpm').sensors, 10);
    assert.equal(sourceMeta(res, 'radiation').rows, 27 - 5 + 1);
  });
}

test('GUARD: the route serves the hand-computed cell medians, AQI category and radiation estimate', async () => {
  const { fetchImpl } = upstream();
  const res = await install({ fetchImpl })();
  const cell = res.body.features.find((f) => f.id === 'airpm:1891_1385');
  assert.deepEqual(cell.geometry, {
    type: 'Point',
    coordinates: [9.15, 48.55],
  });
  // Four outdoor sensors at 10, 20, 40 and 36 µg/m³: median (20 + 36) / 2.
  // The indoor 500, the negative, the 1000.01 and the superseded 999 are out.
  assert.deepEqual(cell.properties, {
    pm25: 28,
    pm10: 47.5,
    sensors: 4,
    aqi: 86,
    category: 'moderate',
    timestamp: '2026-10-25T08:55:00.000Z',
    layer: 'citizen-sensors',
    source: 'airpm',
  });
  // Exactly 1000 µg/m³ is kept (hazardous, AQI capped at 500); 1000.01 is not.
  const extreme = res.body.features.find((f) => f.id === 'airpm:2572_1186');
  assert.equal(extreme.properties.category, 'hazardous');
  assert.equal(extreme.properties.aqi, 500);
  const device = res.body.features.find((f) => f.id === 'radiation:d65002');
  assert.deepEqual(device.properties, {
    device: 65002,
    unit: 'cpm',
    cpm: 50,
    usv: 0.15,
    usvEstimated: true,
    timestamp: '2026-10-25T08:58:00.000Z',
    layer: 'citizen-sensors',
    source: 'radiation',
  });
  // PM10 absent stays null through the JSON round trip: not 0, not a missing key.
  const noPm10 = res.body.features.find((f) => f.id === 'airpm:1823_1388');
  assert.equal(noPm10.properties.pm10, null);
  assert.ok(Object.hasOwn(noPm10.properties, 'pm10'));
});

test('particulates refresh after 10 minutes and radiation after 30, each on its own clock', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  await request();
  assert.deepEqual(counts(calls), [1, 6]);
  clock = NOW_MS + 10 * MINUTE - 1;
  await request();
  assert.deepEqual(counts(calls), [1, 6]);
  clock = NOW_MS + 10 * MINUTE;
  await request();
  assert.deepEqual(counts(calls), [2, 6]);
  clock = NOW_MS + 30 * MINUTE - 1;
  await request();
  assert.deepEqual(counts(calls), [3, 6]);
  // Particulates were last read a millisecond ago; radiation is 30 minutes old.
  clock = NOW_MS + 30 * MINUTE;
  const res = await request();
  assert.deepEqual(counts(calls), [3, 12]);
  // The windows moved with the clock: the newest slice now ends at 09:30.
  assert.match(
    calls.at(-6).url.search,
    /captured_after=2026-10-25T08:30:00Z&captured_before=2026-10-25T09:30:00Z/,
  );
  assert.equal(res.status, 200);
});

test('a busy hour is read page by page, three pages at most, and never more than one request at a time', async () => {
  const busy = (devices) =>
    Array.from({ length: devices }, (_, i) =>
      measurement({
        id: 1000 + i,
        device: 1 + i,
        value: 40,
        // Spread over the newest hour, oldest first like the API.
        at: new Date(NOW_MS - HOUR + 1000 + i).toISOString(),
        lat: 10 + (i % 80) * 0.5,
        lon: -170 + Math.floor(i / 80) * 0.5,
      }),
    );
  for (const [devices, pages] of [
    [999, 1],
    [1000, 2],
    [2500, 3],
    [3500, 3],
  ]) {
    const rows = busy(devices);
    let live = 0;
    let maxLive = 0;
    const { calls, fetchImpl } = upstream({
      safecast: async (url) => {
        live++;
        maxLive = Math.max(maxLive, live);
        await new Promise(setImmediate);
        live--;
        return Response.json(safecastAnswer(url, rows));
      },
    });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 200, `${devices} rows`);
    const safecast = calls.filter(({ url }) => url.pathname === SAFECAST_PATH);
    // The newest hour needs `pages` requests; the other five hours one each.
    assert.equal(safecast.length, pages + 5, `${devices} rows`);
    assert.deepEqual(
      safecast.slice(0, pages).map(({ url }) => pageOf(url)),
      Array.from({ length: pages }, (_, i) => i + 1),
    );
    assert.equal(maxLive, 1);
    // At most 600 devices are served, the newest.
    assert.equal(
      sourceMeta(res, 'radiation').count,
      Math.min(600, Math.min(devices, pages * 1000)),
      `${devices} rows`,
    );
  }
});

test('a Safecast request answering 502 once is asked again; the snapshot is complete', async () => {
  let failed = false;
  const { calls, fetchImpl } = upstream({
    safecast: (url) => {
      if (!failed && url.includes('captured_after=2026-10-25T06:00:00Z')) {
        failed = true;
        return new Response('bad gateway', { status: 502 });
      }
      return Response.json(safecastAnswer(url));
    },
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'radiation').ok, true);
  assert.equal(sourceMeta(res, 'radiation').count, 7);
  assert.equal(pathCount(calls, SAFECAST_PATH), 7);
});

test('a Safecast hour that keeps failing fails the radiation feed only; particulates still serve and nothing is cached', async () => {
  let clock = NOW_MS;
  let broken = true;
  const { calls, fetchImpl } = upstream({
    safecast: (url) =>
      broken && url.includes('captured_after=2026-10-25T05:00:00Z')
        ? new Response('bad gateway', { status: 502 })
        : Response.json(safecastAnswer(url)),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'citizen-sensors');
  assert.equal(res.body.features.length, 6);
  assert.deepEqual(sourceMeta(res, 'radiation'), {
    id: 'radiation',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'upstream_status',
  });
  assert.equal(sourceMeta(res, 'airpm').ok, true);
  assert.equal(res.body.metadata.partial, true);
  const status = await request('/status');
  assert.deepEqual(
    status.body.sources.map(({ id, cached, lastError }) => [
      id,
      cached,
      lastError,
    ]),
    [
      ['airpm', true, null],
      ['radiation', false, 'upstream_status'],
    ],
  );
  // Inside the failure backoff nothing is retried; after it, Safecast is asked again.
  const safecastCalls = pathCount(calls, SAFECAST_PATH);
  await request();
  assert.equal(pathCount(calls, SAFECAST_PATH), safecastCalls);
  broken = false;
  clock = NOW_MS + MINUTE;
  const recovered = await request();
  assert.equal(sourceMeta(recovered, 'radiation').ok, true);
  assert.equal(recovered.body.features.length, 13);
});

test('Sensor.Community failing while Safecast is fine: radiation served, particulates ok:false', async () => {
  const { fetchImpl } = upstream({
    air: () => new Response('busy', { status: 503 }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'citizen-sensors');
  assert.equal(res.body.features.length, 7);
  assert.equal(sourceMeta(res, 'airpm').error, 'upstream_status');
  assert.equal(sourceMeta(res, 'airpm').ok, false);
});

test('a failed refresh serves the last good snapshot as stale', async () => {
  let clock = NOW_MS;
  let fail = false;
  const { fetchImpl } = upstream({
    air: () => {
      if (fail) throw new Error('private upstream details');
      return Response.json(AIR_READINGS);
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  fail = true;
  clock = NOW_MS + 10 * MINUTE;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.metadata.stale, true);
  const air = sourceMeta(res, 'airpm');
  assert.deepEqual(
    [air.ok, air.stale, air.count, air.error],
    [false, true, 6, 'upstream_unavailable'],
  );
  assert.equal(res.body.features.length, 13);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('a Sensor.Community file that has stopped updating is refused and the last good map is served stale', async () => {
  let clock = NOW_MS;
  const { fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  assert.equal(sourceMeta(await request(), 'airpm').count, 6);
  // The upstream file never changes, so six hours later every reading is too
  // old (the fixture's one reading stamped two hours ahead included).
  clock = NOW_MS + 6 * HOUR;
  const res = await request();
  assert.equal(res.status, 200);
  const air = sourceMeta(res, 'airpm');
  assert.deepEqual(
    [air.ok, air.stale, air.error, air.count],
    [false, true, 'invalid_payload', 6],
  );
});

test('empty or unusable data is a broken feed, never a cached empty snapshot', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    air: () => Response.json([]),
    safecast: () => Response.json([]),
  });
  const request = install({ fetchImpl, now: () => clock });
  const first = await request();
  assert.equal(first.status, 502);
  assert.deepEqual(first.body, { error: 'citizen_sensors_unavailable' });
  clock = NOW_MS + MINUTE;
  const again = await request();
  assert.equal(again.status, 502);
  // Both feeds were asked again after the backoff: nothing was cached.
  assert.equal(pathCount(calls, AIR_PATH), 2);
  assert.ok(pathCount(calls, SAFECAST_PATH) >= 12);
  const status = await request('/status');
  assert.deepEqual(
    status.body.sources.map(({ id, cached, lastError }) => [
      id,
      cached,
      lastError,
    ]),
    [
      ['airpm', false, 'invalid_payload'],
      ['radiation', false, 'invalid_payload'],
    ],
  );
});

test('malformed data from both feeds never becomes a cached empty snapshot', async () => {
  let clock = NOW_MS;
  const { fetchImpl } = upstream({
    air: () => new Response('<html>error</html>'),
    safecast: () => Response.json({ error: 'upstream detail' }),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 502);
  clock = NOW_MS + MINUTE;
  const again = await request();
  assert.equal(again.status, 502);
  assert.deepEqual(again.body, { error: 'citizen_sensors_unavailable' });
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
    const { fetchImpl } = upstream({ air: huge, safecast: huge });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'citizen_sensors_unavailable' });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('a Safecast page over its 2 MiB cap fails radiation as response_too_large while particulates serve', async () => {
  const { fetchImpl } = upstream({
    safecast: () =>
      new Response('[]', {
        headers: { 'Content-Length': String(3 * 1024 * 1024) },
      }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'radiation').error, 'response_too_large');
  assert.equal(sourceMeta(res, 'airpm').ok, true);
});

test('concurrent requests share one upstream operation per feed', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    air: async () => {
      await pending;
      return Response.json(AIR_READINGS);
    },
    safecast: async (url) => {
      await pending;
      return Response.json(safecastAnswer(url));
    },
  });
  const request = install({ fetchImpl });
  const responses = [request(), request('/', 'GET', 'other')];
  await new Promise((resolve) => setTimeout(resolve, 10));
  // One file request, and only the newest hour's first page is in flight.
  assert.deepEqual(counts(calls), [1, 1]);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.deepEqual(counts(calls), [1, 6]);
});

test("the route stays under 1.5 MB at today's volume and when the sensor count triples", async () => {
  // Today: ~9,000 outdoor sensors in ~3,900 cells. Build cells 0.5 degrees
  // apart so that every sensor group is its own 0.1 degree cell.
  const sensors = (count) =>
    Array.from({ length: count }, (_, i) =>
      reading({
        loc: 100_000 + i,
        lat: -60 + Math.floor(i / 200) * 0.5 + 0.05,
        lon: -170 + (i % 200) * 0.5 + 0.05,
        p1: 10 + (i % 50),
        p2: 5 + (i % 40),
      }),
    );
  // 700 radiation devices spread over the six hours.
  const devices = Array.from({ length: 700 }, (_, i) =>
    measurement({
      id: 5000 + i,
      device: 1 + i,
      value: 30 + (i % 70),
      at: new Date(NOW_MS - (i % 6) * HOUR - 30 * MINUTE - i).toISOString(),
      lat: -40 + Math.floor(i / 50),
      lon: -100 + (i % 50) * 2,
    }),
  );
  for (const [count, expectedCells, truncated] of [
    [3900, 3900, false],
    [12_000, 4500, true],
  ]) {
    const { fetchImpl } = upstream({
      air: () => Response.json(sensors(count)),
      safecast: (url) => Response.json(safecastAnswer(url, devices)),
    });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 200, `${count} sensors`);
    assertValidKeylessLayerCollection(res.body, 'citizen-sensors');
    const air = sourceMeta(res, 'airpm');
    assert.equal(air.count, expectedCells, `${count} sensors`);
    assert.equal(air.truncated, truncated, `${count} sensors`);
    assert.equal(sourceMeta(res, 'radiation').count, 600);
    assert.ok(
      Buffer.byteLength(res.text) < 1_500_000,
      `${count} sensors: ${Buffer.byteLength(res.text)} bytes`,
    );
  }
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

test('an unknown sub-route is a 404 and never reaches an upstream', async () => {
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
