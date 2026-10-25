import test from 'node:test';
import assert from 'node:assert/strict';
import { spaceWeatherProxy } from '../../server/providers/spaceWeather.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import {
  auroraPayload,
  kpRows,
  ovation,
} from '../testSupport/spaceWeatherFixtures.mjs';

const MINUTE = 60_000;

/** Upstream double: the SWPC aurora grid and Kp rows, with per-call overrides. */
function upstream({
  aurora = () => Response.json(auroraPayload),
  kp = () => Response.json(kpRows),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork \(\+/);
    assert.equal(parsed.hostname, 'services.swpc.noaa.gov');
    if (parsed.pathname === '/json/ovation_aurora_latest.json') return aurora();
    if (parsed.pathname === '/products/noaa-planetary-k-index.json')
      return kp();
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = spaceWeatherProxy(options);
  assert.equal(plugin.name, 'space-weather');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/space-weather');
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
const AURORA_PATH = '/json/ovation_aurora_latest.json';
const KP_PATH = '/products/noaa-planetary-k-index.json';

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves aurora bands and the Kp summary as one valid collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl, now: () => 0 }, hook);
    const res = await request('/?url=https://invalid.example');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'space-weather');
    // Fixed upstream URLs: the client query went nowhere.
    assert.deepEqual(
      calls.map(({ url }) => url.origin + url.pathname),
      [
        'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json',
        'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
      ],
    );
    assert.deepEqual(
      res.body.features.map((feature) => feature.id),
      ['aurora:north-10-1', 'aurora:north-20-1', 'aurora:south-60-2'],
    );
    assert.ok(
      res.body.features.every(
        (feature) => feature.properties.source === 'aurora',
      ),
    );
    assert.equal(res.body.metadata.partial, false);
    assert.deepEqual(
      res.body.metadata.sources.map(({ id, count, ok }) => [id, count, ok]),
      [
        ['aurora', 3, true],
        ['kp', 0, true],
      ],
    );
  });
}

test('guard: lon 350 is served at -10, cells under 10% are dropped, Kp 7.33 is G3', async () => {
  const { fetchImpl } = upstream();
  const res = await install({ fetchImpl, now: () => 0 })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'space-weather');
  const band = res.body.features.find(
    (feature) => feature.id === 'aurora:north-20-1',
  );
  // Cells lon 350 and 351 at lat 65 are -10 and -9 degrees, +-0.5 each.
  assert.deepEqual(band.geometry.coordinates[0][0], [-10.5, 64.5]);
  const lons = band.geometry.coordinates[0].map(([lon]) => lon);
  assert.deepEqual([Math.min(...lons), Math.max(...lons)], [-10.5, -8.5]);
  // No served vertex is anywhere near the unwrapped 350, 351 or 352.
  const allLons = res.body.features.flatMap((feature) =>
    JSON.stringify(feature.geometry.coordinates)
      .match(/-?\d+(?:\.\d+)?(?=,)/g)
      .map(Number),
  );
  assert.ok(allLons.every((lon) => lon >= -180 && lon <= 180));
  assert.ok(!allLons.some((lon) => lon > 100), 'an unwrapped longitude leaked');
  // The 9% cell (lon 352, lat 65) and the 4% cell are not drawn.
  assert.equal(
    res.body.features.reduce((sum, f) => sum + f.properties.cells, 0),
    4,
  );
  assert.deepEqual(sourceMeta(res, 'kp'), {
    kp: 7.33,
    kpTime: '2026-10-25T06:00:00.000Z',
    gScale: 3,
    kpMax24h: 7.33,
    id: 'kp',
    ok: true,
    stale: false,
    count: 0,
    fetchedAt: '1970-01-01T00:00:00.000Z',
    truncated: false,
  });
  assert.equal(
    sourceMeta(res, 'aurora').observationTime,
    '2026-10-25T08:38:00.000Z',
  );
  assert.equal(
    sourceMeta(res, 'aurora').forecastTime,
    '2026-10-25T09:55:00.000Z',
  );
  assert.equal(sourceMeta(res, 'aurora').activeCells, 4);
});

test('aurora refreshes after 5 minutes and Kp after 15', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  const aurora = () => pathCount(calls, AURORA_PATH);
  const kp = () => pathCount(calls, KP_PATH);
  await request();
  clock = 5 * MINUTE - 1;
  await request();
  assert.deepEqual([aurora(), kp()], [1, 1]);
  clock = 5 * MINUTE;
  await request();
  assert.deepEqual([aurora(), kp()], [2, 1]);
  // Aurora is due again at 10 minutes; Kp not before 15.
  clock = 15 * MINUTE - 1;
  await request();
  assert.deepEqual([aurora(), kp()], [3, 1]);
  clock = 15 * MINUTE;
  await request();
  assert.deepEqual([aurora(), kp()], [3, 2]);
});

test('aurora failing while Kp is fine: Kp still served, aurora ok:false, nothing cached for it', async () => {
  let clock = 0;
  let corrupt = true;
  const { calls, fetchImpl } = upstream({
    aurora: () =>
      corrupt
        ? new Response('<html>maintenance</html>')
        : Response.json(auroraPayload),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'space-weather');
  assert.deepEqual(res.body.features, []);
  assert.deepEqual(sourceMeta(res, 'aurora'), {
    id: 'aurora',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'invalid_payload',
  });
  assert.equal(sourceMeta(res, 'kp').kp, 7.33);
  assert.equal(res.body.metadata.partial, true);
  const status = await request('/status');
  assert.equal(status.body.sources[0].cached, false);
  assert.equal(status.body.sources[0].lastError, 'invalid_payload');
  assert.equal(pathCount(calls, AURORA_PATH), 1);
  // After the failure backoff the next request asks SWPC again.
  corrupt = false;
  clock = MINUTE;
  const recovered = await request();
  assert.equal(pathCount(calls, AURORA_PATH), 2);
  assert.equal(sourceMeta(recovered, 'aurora').ok, true);
  assert.equal(recovered.body.features.length, 3);
});

test('Kp failing while aurora is fine: bands served, no Kp summary', async () => {
  const { fetchImpl } = upstream({
    kp: () => new Response('busy', { status: 503 }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'space-weather');
  assert.equal(res.body.features.length, 3);
  assert.deepEqual(sourceMeta(res, 'kp'), {
    id: 'kp',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'upstream_status',
  });
});

test('a failed refresh serves the last good snapshot as stale, summary included', async () => {
  let clock = 0;
  let fail = false;
  const { fetchImpl } = upstream({
    kp: () => {
      if (fail) throw new Error('private upstream details');
      return Response.json(kpRows);
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  fail = true;
  clock = 15 * MINUTE;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.metadata.stale, true);
  const kp = sourceMeta(res, 'kp');
  assert.deepEqual(
    [kp.ok, kp.stale, kp.kp, kp.gScale, kp.error],
    [false, true, 7.33, 3, 'upstream_unavailable'],
  );
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('a quiet sky is cached like any snapshot and is not an error', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream({
    aurora: () =>
      Response.json(
        ovation([
          [0, -90, 3],
          [0, -89, 0],
          [1, 0, 2],
        ]),
      ),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.features, []);
  assert.equal(sourceMeta(res, 'aurora').ok, true);
  assert.equal(sourceMeta(res, 'aurora').activeCells, 0);
  clock = 4 * MINUTE;
  await request();
  assert.equal(pathCount(calls, AURORA_PATH), 1);
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
    const { fetchImpl } = upstream({ aurora: huge, kp: huge });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'space_weather_unavailable' });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('an oversized Kp body fails only Kp', async () => {
  const { fetchImpl } = upstream({
    kp: () =>
      new Response('[]', {
        headers: { 'Content-Length': String(2 * 1024 * 1024) },
      }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'kp').error, 'response_too_large');
  assert.equal(res.body.features.length, 3);
});

test('malformed data from both feeds never becomes a cached empty snapshot', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream({
    aurora: () => Response.json({ error: 'upstream detail' }),
    // An empty list is as wrong as no list: Kp always has rows.
    kp: () => Response.json([]),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 502);
  clock = MINUTE;
  const again = await request();
  assert.equal(again.status, 502);
  assert.deepEqual(again.body, { error: 'space_weather_unavailable' });
  assert.equal(calls.length, 4);
});

test('a grid in a changed format is refused, not served as a calm sky', async () => {
  const { fetchImpl } = upstream({
    aurora: () =>
      Response.json(
        ovation(Array.from({ length: 40 }, (_, i) => [i + 0.5, 10, 50])),
      ),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'aurora').ok, false);
  assert.equal(sourceMeta(res, 'aurora').error, 'invalid_payload');
  assert.deepEqual(res.body.features, []);
});

test('concurrent requests share one upstream operation per feed', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    aurora: async () => {
      await pending;
      return Response.json(auroraPayload);
    },
    kp: async () => {
      await pending;
      return Response.json(kpRows);
    },
  });
  const request = install({ fetchImpl });
  const responses = [request(), request('/', 'GET', 'other')];
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
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

test('an unknown sub-route is a 404 and never reaches SWPC', async () => {
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
