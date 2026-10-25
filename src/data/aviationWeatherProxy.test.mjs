import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { aviationWeatherProxy } from '../../server/providers/aviationWeather.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import {
  GOOD_METAR_ROWS,
  NOW_MS,
  collection,
  internationalPayload,
  metarCsv,
  usPayload,
} from '../testSupport/aviationWeatherFixtures.mjs';

const MINUTE = 60_000;
const METAR_PATH = '/data/cache/metars.cache.csv.gz';
const SIGMET_PATH = '/api/data/airsigmet';
const ISIGMET_PATH = '/api/data/isigmet';
const csvGz = () =>
  new Response(gzipSync(metarCsv(...GOOD_METAR_ROWS)), {
    headers: { 'Content-Type': 'application/octet-stream' },
  });

/** Upstream double: the AWC cache file and the two advisory endpoints, with per-call overrides. */
function upstream({
  metar = csvGz,
  sigmet = () => Response.json(usPayload),
  isigmet = () => Response.json(internationalPayload),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork \(\+/);
    assert.equal(parsed.hostname, 'aviationweather.gov');
    if (parsed.pathname === METAR_PATH) return metar();
    if (parsed.pathname === SIGMET_PATH) return sigmet();
    if (parsed.pathname === ISIGMET_PATH) return isigmet();
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = aviationWeatherProxy({ now: () => NOW_MS, ...options });
  assert.equal(plugin.name, 'aviation-weather');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/aviation-weather');
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
  pathCount(calls, METAR_PATH),
  pathCount(calls, SIGMET_PATH),
  pathCount(calls, ISIGMET_PATH),
];

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves METAR points and both advisory feeds as one valid collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl }, hook);
    const res = await request('/?url=https://invalid.example&bbox=1,2,3,4');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'aviation-weather');
    // Fixed upstream URLs: the client query went nowhere.
    assert.deepEqual(
      calls.map(({ url }) => url.origin + url.pathname + url.search),
      [
        'https://aviationweather.gov/data/cache/metars.cache.csv.gz',
        'https://aviationweather.gov/api/data/airsigmet?format=geojson',
        'https://aviationweather.gov/api/data/isigmet?format=geojson',
      ],
    );
    assert.deepEqual(
      res.body.features.map((feature) => feature.id),
      [
        'metar:KSEA',
        'metar:KCAG',
        'metar:EGLL',
        'metar:KSRR',
        'metar:LFPG',
        'metar:PHNL',
        'metar:KJDN',
        'sigmet:sigmet-KKCI-15W-CONVECTIVE-202610251055',
        'sigmet:airmet-KKCI-SFOT-TURB-202610251055',
        'isigmet:sigmet-MMMD-1-TURB-202610251000',
        'isigmet:sigmet-NZKL-18-VA-202610251000',
      ],
    );
    assert.deepEqual(
      [...new Set(res.body.features.map((f) => f.properties.source))],
      ['metar', 'sigmet', 'isigmet'],
    );
    assert.equal(res.body.metadata.partial, false);
    assert.deepEqual(
      res.body.metadata.sources.map(({ id, count, ok }) => [id, count, ok]),
      [
        ['metar', 7, true],
        ['sigmet', 2, true],
        ['isigmet', 2, true],
      ],
    );
  });
}

test('guard: the proxy serves the derived flight category and folded longitudes', async () => {
  const { fetchImpl } = upstream();
  const res = await install({ fetchImpl })();
  const metar = (id) =>
    res.body.features.find((feature) => feature.id === `metar:${id}`);
  // The CSV says "null" for LFPG; 800 ft ceiling and 2 SM must read IFR.
  assert.equal(metar('LFPG').properties.category, 'IFR');
  assert.equal(metar('KJDN').properties.category, null);
  // The date-line advisory is served with longitudes inside +-180 and a closed ring.
  const ash = res.body.features.find((f) =>
    f.id.startsWith('isigmet:sigmet-NZKL'),
  );
  const ring = ash.geometry.coordinates[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  assert.ok(ring.every(([lon]) => lon >= -180 && lon <= 180));
  assert.deepEqual(ring[0], [-179.333, -57.5]);
});

test('the plain (not gzipped) CSV is accepted too', async () => {
  const { fetchImpl } = upstream({
    metar: () => new Response(metarCsv(...GOOD_METAR_ROWS)),
  });
  const res = await install({ fetchImpl })();
  assert.equal(sourceMeta(res, 'metar').count, 7);
});

test('each feed refreshes after 5 minutes and not before', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  await request();
  clock = NOW_MS + 5 * MINUTE - 1;
  await request();
  assert.deepEqual(counts(calls), [1, 1, 1]);
  clock = NOW_MS + 5 * MINUTE;
  await request();
  assert.deepEqual(counts(calls), [2, 2, 2]);
});

test('one advisory feed failing: METARs and the other feed still serve, nothing is cached for the failed one', async () => {
  let clock = NOW_MS;
  let corrupt = true;
  const { calls, fetchImpl } = upstream({
    sigmet: () =>
      corrupt
        ? new Response('<html>maintenance</html>')
        : Response.json(usPayload),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'aviation-weather');
  assert.equal(res.body.features.length, 7 + 2);
  assert.deepEqual(sourceMeta(res, 'sigmet'), {
    id: 'sigmet',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'invalid_payload',
  });
  assert.equal(sourceMeta(res, 'metar').ok, true);
  assert.equal(sourceMeta(res, 'isigmet').ok, true);
  assert.equal(res.body.metadata.partial, true);
  const status = await request('/status');
  assert.deepEqual(
    status.body.sources.map(({ id, cached, lastError }) => [
      id,
      cached,
      lastError,
    ]),
    [
      ['metar', true, null],
      ['sigmet', false, 'invalid_payload'],
      ['isigmet', true, null],
    ],
  );
  // Within the failure backoff nothing is retried; after it, the next request asks AWC again.
  assert.equal(pathCount(calls, SIGMET_PATH), 1);
  corrupt = false;
  clock = NOW_MS + MINUTE;
  const recovered = await request();
  assert.equal(pathCount(calls, SIGMET_PATH), 2);
  assert.equal(sourceMeta(recovered, 'sigmet').ok, true);
  assert.equal(recovered.body.features.length, 11);
});

test('the METAR cache failing while advisories are fine: advisories served, METAR ok:false', async () => {
  const { fetchImpl } = upstream({
    metar: () => new Response('busy', { status: 503 }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'aviation-weather');
  assert.equal(res.body.features.length, 4);
  assert.equal(sourceMeta(res, 'metar').error, 'upstream_status');
  assert.equal(sourceMeta(res, 'metar').ok, false);
});

test('a failed refresh serves the last good snapshot as stale', async () => {
  let clock = NOW_MS;
  let fail = false;
  const { fetchImpl } = upstream({
    isigmet: () => {
      if (fail) throw new Error('private upstream details');
      return Response.json(internationalPayload);
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  fail = true;
  clock = NOW_MS + 5 * MINUTE;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.metadata.stale, true);
  const intl = sourceMeta(res, 'isigmet');
  assert.deepEqual(
    [intl.ok, intl.stale, intl.count, intl.error],
    [false, true, 2, 'upstream_unavailable'],
  );
  assert.equal(res.body.features.length, 11);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('a METAR file that has gone stale is refused and the last good map is served stale', async () => {
  let clock = NOW_MS;
  const { fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  assert.equal(sourceMeta(await request(), 'metar').count, 7);
  // The upstream file never changes, so four hours later every report is too old.
  clock = NOW_MS + 4 * 3_600_000;
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(
    [
      sourceMeta(res, 'metar').ok,
      sourceMeta(res, 'metar').stale,
      sourceMeta(res, 'metar').error,
    ],
    [false, true, 'invalid_payload'],
  );
  assert.equal(sourceMeta(res, 'metar').count, 7);
});

test('no advisories in force is cached like any snapshot and is not an error', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    sigmet: () => Response.json(collection()),
    isigmet: () => Response.json(collection()),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'aviation-weather');
  assert.equal(res.body.features.length, 7);
  assert.equal(sourceMeta(res, 'sigmet').ok, true);
  assert.equal(sourceMeta(res, 'isigmet').count, 0);
  clock = NOW_MS + 4 * MINUTE;
  await request();
  assert.deepEqual(counts(calls), [1, 1, 1]);
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
    const { fetchImpl } = upstream({
      metar: huge,
      sigmet: huge,
      isigmet: huge,
    });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'aviation_weather_unavailable' });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('a small gzip file that inflates past the decoded cap is refused for METAR only', async () => {
  const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 'a'));
  assert.ok(bomb.length < 100_000, 'the bomb should compress well');
  const { fetchImpl } = upstream({ metar: () => new Response(bomb) });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'metar').error, 'response_too_large');
  assert.equal(res.body.features.length, 4);
});

test('malformed data from every feed never becomes a cached empty snapshot', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    metar: () => new Response('<html>error</html>'),
    sigmet: () => Response.json({ error: 'upstream detail' }),
    isigmet: () => Response.json([]),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 502);
  clock = NOW_MS + MINUTE;
  const again = await request();
  assert.equal(again.status, 502);
  assert.deepEqual(again.body, { error: 'aviation_weather_unavailable' });
  assert.equal(calls.length, 6);
});

test('concurrent requests share one upstream operation per feed', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    metar: async () => {
      await pending;
      return csvGz();
    },
    sigmet: async () => {
      await pending;
      return Response.json(usPayload);
    },
    isigmet: async () => {
      await pending;
      return Response.json(internationalPayload);
    },
  });
  const request = install({ fetchImpl });
  const responses = [request(), request('/', 'GET', 'other')];
  await new Promise(setImmediate);
  assert.equal(calls.length, 3);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.equal(calls.length, 3);
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

test('an unknown sub-route is a 404 and never reaches AWC', async () => {
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
