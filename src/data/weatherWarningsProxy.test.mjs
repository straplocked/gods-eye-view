import test from 'node:test';
import assert from 'node:assert/strict';
import { weatherWarningsProxy } from '../../server/providers/weatherWarnings.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import {
  noisySquareRing,
  nwsAlert,
  nwsCollection,
  polygonGeometry,
  squareRing,
  tsunamiEntry,
  tsunamiFeedOf,
  tsunamiPaaq,
  tsunamiPheb,
  zoneFeature,
  zoneUrl,
} from '../testSupport/weatherWarningsFixtures.mjs';

const NOW = Date.parse('2026-10-25T09:00:00Z');
const zoneId = (n) => `TXZ${100 + n}`;
const zoneOf = (n) => zoneUrl(zoneId(n));
/** Alert whose only area is zone `n`. */
const zoneAlert = (n, extra = {}) =>
  nwsAlert({ id: `urn:oid:zone-${n}`, zones: [zoneOf(n)], ...extra });

/**
 * Upstream double: NWS alerts, NWS zones and the two tsunami.gov feeds, with
 * per-call overrides. Zone n resolves to a noisy 1-degree square.
 */
function upstream({
  alerts = () => Response.json(nwsCollection()),
  zone = (url) => {
    const id = url.pathname.split('/').pop();
    return Response.json(
      zoneFeature(
        id,
        polygonGeometry(noisySquareRing(-100, 30, 1, 20)),
        url.pathname.split('/')[3],
      ),
    );
  },
  tsunami = (center) =>
    new Response(center === 'PAAQ' ? tsunamiPaaq : tsunamiPheb),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork/);
    if (parsed.hostname === 'api.weather.gov') {
      assert.equal(options.headers.Accept, 'application/geo+json');
      return parsed.pathname.startsWith('/zones/')
        ? zone(parsed)
        : alerts(parsed);
    }
    if (parsed.hostname === 'www.tsunami.gov') {
      const center = /\/(\w+)Atom\.xml$/.exec(parsed.pathname)?.[1];
      return tsunami(center);
    }
    throw new Error(`unexpected upstream ${url}`);
  };
  const zoneCalls = () =>
    calls.filter(({ url }) => url.pathname.startsWith('/zones/'));
  const alertCalls = () =>
    calls.filter(({ url }) => url.pathname.startsWith('/alerts/'));
  const tsunamiCalls = () =>
    calls.filter(({ url }) => url.hostname === 'www.tsunami.gov');
  return { calls, fetchImpl, zoneCalls, alertCalls, tsunamiCalls };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = weatherWarningsProxy({ now: () => NOW, ...options });
  assert.equal(plugin.name, 'weather-warnings');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/weather-warnings');
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

const ids = (res, source) =>
  res.body.features
    .filter((feature) => feature.properties.source === source)
    .map((feature) => feature.id);
const sourceMeta = (res, id) =>
  res.body.metadata.sources.find((entry) => entry.id === id);

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: a zone-only alert is served as a polygon feature with its alert id`, async () => {
    const polygonAlert = nwsAlert({
      id: 'urn:oid:own-polygon',
      geometry: polygonGeometry(squareRing(-104.85, 32, 0.5)),
      severity: 'Severe',
    });
    const { calls, fetchImpl, zoneCalls } = upstream({
      alerts: () =>
        Response.json(
          nwsCollection(
            polygonAlert,
            zoneAlert(1, { severity: 'Minor' }),
            nwsAlert({
              id: 'urn:oid:two-zones',
              zones: [zoneOf(2), zoneOf(3)],
              severity: 'Moderate',
            }),
          ),
        ),
    });
    const request = install({ fetchImpl }, hook);
    const res = await request('/?url=https://invalid.example&zone=x');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'weather-warnings');
    // Every request goes to a fixed upstream: api.weather.gov or tsunami.gov.
    assert.ok(
      calls.every(({ url }) =>
        ['api.weather.gov', 'www.tsunami.gov'].includes(url.hostname),
      ),
    );
    // Moderate (two zones) outranks Minor (one zone): severity decides first.
    assert.deepEqual(
      zoneCalls().map(({ url }) => url.pathname),
      [
        '/zones/forecast/TXZ102',
        '/zones/forecast/TXZ103',
        '/zones/forecast/TXZ101',
      ],
    );
    assert.deepEqual(ids(res, 'nws'), [
      'nws:urn:oid:own-polygon',
      'nws:urn:oid:two-zones',
      'nws:urn:oid:zone-1',
    ]);
    const zoned = res.body.features.find(
      ({ id }) => id === 'nws:urn:oid:zone-1',
    );
    // The noisy 81-point square was decimated to its four corners.
    assert.deepEqual(zoned.geometry, {
      type: 'Polygon',
      coordinates: [
        [
          [-100, 30],
          [-99, 30],
          [-99, 31],
          [-100, 31],
          [-100, 30],
        ],
      ],
    });
    const two = res.body.features.find(
      ({ id }) => id === 'nws:urn:oid:two-zones',
    );
    assert.equal(two.geometry.type, 'MultiPolygon');
    assert.equal(two.geometry.coordinates.length, 2);
    assert.deepEqual(ids(res, 'tsunami'), [
      'tsunami:PAAQ-890504a1-0c59-4a3d-b6be-7bee3e3bebc3',
      'tsunami:PHEB-ba64bc82-07f7-45fb-ab6c-25420fca6851',
    ]);
    assert.deepEqual(sourceMeta(res, 'nws'), {
      alerts: 3,
      pendingAlerts: 0,
      pendingZones: 0,
      unmappedAlerts: 0,
      tolerance: 0.01,
      id: 'nws',
      ok: true,
      stale: false,
      count: 3,
      fetchedAt: '2026-10-25T09:00:00.000Z',
      truncated: false,
    });
    assert.equal(res.body.metadata.partial, false);
  });
}

test('the zone budget caps new zone fetches per refresh; the rest wait for the next one', async () => {
  let clock = NOW;
  const { fetchImpl, zoneCalls } = upstream({
    alerts: () =>
      Response.json(nwsCollection(...[1, 2, 3, 4, 5].map((n) => zoneAlert(n)))),
  });
  const request = install({
    fetchImpl,
    now: () => clock,
    zones: { maxNewPerRefresh: 3 },
  });
  const first = await request();
  assert.equal(zoneCalls().length, 3);
  assert.equal(ids(first, 'nws').length, 3);
  assert.equal(sourceMeta(first, 'nws').pendingAlerts, 2);
  assert.equal(sourceMeta(first, 'nws').pendingZones, 2);
  assertValidKeylessLayerCollection(first.body, 'weather-warnings');
  // Within the 2-minute TTL nothing is refreshed.
  clock += 119_000;
  await request();
  assert.equal(zoneCalls().length, 3);
  // The next refresh fetches only the two missing zones, not all five again.
  clock += 2_000;
  const second = await request();
  assert.equal(zoneCalls().length, 5);
  assert.equal(ids(second, 'nws').length, 5);
  assert.equal(sourceMeta(second, 'nws').pendingAlerts, 0);
  assert.equal(sourceMeta(second, 'nws').pendingZones, 0);
  // Fully cached: later refreshes fetch no zones at all.
  clock += 121_000;
  const third = await request();
  assert.equal(zoneCalls().length, 5);
  assert.equal(ids(third, 'nws').length, 5);
});

test('the default budget is 150 zones per refresh, four requests at a time', async () => {
  let clock = NOW;
  let active = 0;
  let peak = 0;
  const { fetchImpl, zoneCalls } = upstream({
    alerts: () =>
      Response.json(
        nwsCollection(...Array.from({ length: 160 }, (_, i) => zoneAlert(i))),
      ),
    zone: async (url) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(setImmediate);
      active -= 1;
      return Response.json(
        zoneFeature(
          url.pathname.split('/').pop(),
          polygonGeometry(squareRing(-100, 30, 1)),
        ),
      );
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  const first = await request();
  assert.equal(zoneCalls().length, 150);
  assert.equal(peak, 4);
  assert.equal(ids(first, 'nws').length, 150);
  assert.equal(sourceMeta(first, 'nws').pendingAlerts, 10);
  clock += 120_000;
  const second = await request();
  assert.equal(zoneCalls().length, 160);
  assert.equal(ids(second, 'nws').length, 160);
});

test('severe alerts get their zones first when the budget cannot cover everything', async () => {
  const { fetchImpl, zoneCalls } = upstream({
    alerts: () =>
      Response.json(
        nwsCollection(
          zoneAlert(1, { severity: 'Minor' }),
          zoneAlert(2, { severity: 'Extreme' }),
          zoneAlert(3, { severity: 'Moderate' }),
        ),
      ),
  });
  const res = await install({ fetchImpl, zones: { maxNewPerRefresh: 2 } })();
  assert.deepEqual(
    zoneCalls().map(({ url }) => url.pathname.split('/').pop()),
    [zoneId(2), zoneId(3)],
  );
  assert.deepEqual(ids(res, 'nws'), [
    'nws:urn:oid:zone-2',
    'nws:urn:oid:zone-3',
  ]);
});

test('only api.weather.gov zone urls are ever requested', async () => {
  const { calls, fetchImpl } = upstream({
    alerts: () =>
      Response.json(
        nwsCollection(
          nwsAlert({
            id: 'urn:oid:hostile',
            zones: [
              'https://evil.example/zones/forecast/TXZ101',
              'http://api.weather.gov/zones/forecast/TXZ102',
              'https://api.weather.gov/alerts/active',
              zoneOf(3),
            ],
          }),
        ),
      ),
  });
  const res = await install({ fetchImpl })();
  assert.deepEqual(
    calls
      .filter(({ url }) => url.pathname.startsWith('/zones/'))
      .map(({ url }) => url.href),
    [zoneOf(3)],
  );
  assert.deepEqual(ids(res, 'nws'), ['nws:urn:oid:hostile']);
});

test('a missing zone (404) is remembered as gone; a failing one is retried after five minutes', async () => {
  let clock = NOW;
  const { fetchImpl, zoneCalls } = upstream({
    alerts: () =>
      Response.json(nwsCollection(zoneAlert(1), zoneAlert(2), zoneAlert(3))),
    zone: (url) => {
      const id = url.pathname.split('/').pop();
      if (id === zoneId(1)) return new Response('', { status: 404 });
      if (id === zoneId(2)) return new Response('busy', { status: 503 });
      return Response.json(
        zoneFeature(id, polygonGeometry(squareRing(-100, 30, 1))),
      );
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  const first = await request();
  assert.equal(zoneCalls().length, 3);
  assert.deepEqual(ids(first, 'nws'), ['nws:urn:oid:zone-3']);
  assert.equal(sourceMeta(first, 'nws').unmappedAlerts, 1);
  assert.equal(sourceMeta(first, 'nws').pendingAlerts, 1);
  // 2 minutes later: the 404 zone is not asked again, the 503 zone waits.
  clock += 120_000;
  await request();
  assert.equal(zoneCalls().length, 3);
  // Past the five-minute retry the failing zone is tried once more.
  clock += 240_000;
  await request();
  assert.equal(zoneCalls().length, 4);
});

test('the alerts are cached for two minutes and tsunami for five', async () => {
  let clock = NOW;
  const { alertCalls, tsunamiCalls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  await request();
  clock += 2 * 60_000 - 1;
  await request();
  assert.equal(alertCalls().length, 1);
  assert.equal(tsunamiCalls().length, 2);
  clock += 1;
  await request();
  assert.equal(alertCalls().length, 2);
  assert.equal(tsunamiCalls().length, 2);
  clock = NOW + 5 * 60_000;
  await request();
  assert.equal(alertCalls().length, 3);
  assert.equal(tsunamiCalls().length, 4);
});

test('tsunami reads both warning centers, PAAQ and PHEB', async () => {
  const { tsunamiCalls, fetchImpl } = upstream();
  await install({ fetchImpl })();
  assert.deepEqual(
    tsunamiCalls().map(({ url }) => url.pathname),
    ['/events/xml/PAAQAtom.xml', '/events/xml/PHEBAtom.xml'],
  );
});

test('tsunami warnings sort first and old bulletins are dropped', async () => {
  const { fetchImpl } = upstream({
    tsunami: (center) =>
      new Response(
        center === 'PAAQ'
          ? tsunamiPaaq
          : tsunamiFeedOf(
              tsunamiEntry({ id: 'urn:uuid:w1', category: 'Warning' }),
              tsunamiEntry({
                id: 'urn:uuid:ancient',
                updated: '2026-09-01T00:00:00Z',
              }),
            ),
      ),
  });
  const res = await install({ fetchImpl })();
  assert.deepEqual(ids(res, 'tsunami'), [
    'tsunami:PHEB-w1',
    'tsunami:PAAQ-890504a1-0c59-4a3d-b6be-7bee3e3bebc3',
  ]);
});

test('a failed refresh serves the last good snapshot as stale', async () => {
  let clock = NOW;
  let fail = false;
  const { fetchImpl } = upstream({
    alerts: () => {
      if (fail) throw new Error('private upstream details');
      return Response.json(nwsCollection(zoneAlert(1)));
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  fail = true;
  clock += 2 * 60_000;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.metadata.stale, true);
  const meta = sourceMeta(res, 'nws');
  assert.equal(meta.ok, false);
  assert.equal(meta.stale, true);
  assert.equal(meta.error, 'upstream_unavailable');
  assert.equal(meta.count, 1);
  assert.deepEqual(ids(res, 'nws'), ['nws:urn:oid:zone-1']);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('one subsource failing leaves the other serving', async () => {
  const { fetchImpl } = upstream({
    tsunami: () => new Response('down', { status: 503 }),
    alerts: () => Response.json(nwsCollection(zoneAlert(1))),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.deepEqual(ids(res, 'nws'), ['nws:urn:oid:zone-1']);
  assert.deepEqual(ids(res, 'tsunami'), []);
  assert.equal(sourceMeta(res, 'tsunami').ok, false);
  assert.equal(sourceMeta(res, 'tsunami').error, 'upstream_status');
  assert.equal(sourceMeta(res, 'nws').ok, true);
  assert.equal(res.body.metadata.partial, true);

  const alertsDown = upstream({
    alerts: () => new Response('down', { status: 500 }),
  });
  const other = await install({ fetchImpl: alertsDown.fetchImpl })();
  assert.equal(other.status, 200);
  assert.equal(sourceMeta(other, 'nws').error, 'upstream_status');
  assert.equal(ids(other, 'tsunami').length, 2);
});

test('one failing tsunami center fails the subsource rather than hiding a center', async () => {
  const { fetchImpl } = upstream({
    tsunami: (center) =>
      center === 'PHEB'
        ? new Response('busy', { status: 503 })
        : new Response(tsunamiPaaq),
  });
  const res = await install({ fetchImpl })();
  assert.deepEqual(ids(res, 'tsunami'), []);
  assert.equal(sourceMeta(res, 'tsunami').error, 'upstream_status');
});

test('corrupt alerts never become a cached empty snapshot', async () => {
  let clock = NOW;
  let corrupt = true;
  const { fetchImpl, alertCalls } = upstream({
    alerts: () =>
      corrupt
        ? Response.json({ title: 'maintenance', features: 'none' })
        : Response.json(nwsCollection(zoneAlert(1))),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'nws').error, 'invalid_payload');
  assert.deepEqual(ids(res, 'nws'), []);
  const status = await request('/status');
  assert.equal(status.body.sources[0].cached, false);
  assert.equal(status.body.sources[0].lastError, 'invalid_payload');
  corrupt = false;
  clock += 60_000;
  const recovered = await request();
  assert.equal(alertCalls().length, 2);
  assert.deepEqual(ids(recovered, 'nws'), ['nws:urn:oid:zone-1']);
});

test('a non-Atom tsunami body is rejected, not cached as empty', async () => {
  let clock = NOW;
  let html = true;
  const { fetchImpl, tsunamiCalls } = upstream({
    tsunami: (center) =>
      html
        ? new Response('<html><body>Service unavailable</body></html>')
        : new Response(center === 'PAAQ' ? tsunamiPaaq : tsunamiPheb),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(sourceMeta(res, 'tsunami').error, 'invalid_payload');
  html = false;
  clock += 60_000;
  const recovered = await request();
  assert.equal(tsunamiCalls().length, 4);
  assert.equal(ids(recovered, 'tsunami').length, 2);
});

test('oversized bodies are capped; everything failing gives a sanitized 502', async () => {
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
    const { fetchImpl } = upstream({ alerts: huge, tsunami: huge });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'weather_warnings_unavailable' });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('an oversized tsunami feed fails only tsunami; an oversized zone is treated as gone', async () => {
  const { fetchImpl } = upstream({
    alerts: () => Response.json(nwsCollection(zoneAlert(1), zoneAlert(2))),
    tsunami: () =>
      new Response('<feed/>', {
        headers: { 'Content-Length': String(2 * 1024 * 1024) },
      }),
    zone: (url) =>
      url.pathname.endsWith(zoneId(1))
        ? new Response('{}', {
            headers: { 'Content-Length': String(3 * 1024 * 1024) },
          })
        : Response.json(
            zoneFeature(zoneId(2), polygonGeometry(squareRing(-100, 30, 1))),
          ),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'tsunami').error, 'response_too_large');
  assert.deepEqual(ids(res, 'nws'), ['nws:urn:oid:zone-2']);
  assert.equal(sourceMeta(res, 'nws').unmappedAlerts, 1);
  assert.equal(sourceMeta(res, 'nws').pendingAlerts, 0);
});

test('concurrent requests share one upstream operation per subsource', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { fetchImpl, alertCalls, zoneCalls, tsunamiCalls } = upstream({
    alerts: async () => {
      await pending;
      return Response.json(nwsCollection(zoneAlert(1)));
    },
    tsunami: async (center) => {
      await pending;
      return new Response(center === 'PAAQ' ? tsunamiPaaq : tsunamiPheb);
    },
  });
  const request = install({ fetchImpl });
  const responses = [
    request(),
    request('/', 'GET', 'other'),
    request('/', 'GET', 'third'),
  ];
  await new Promise(setImmediate);
  assert.equal(alertCalls().length, 1);
  assert.equal(tsunamiCalls().length, 2);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.equal(alertCalls().length, 1);
  assert.equal(zoneCalls().length, 1);
  assert.equal(tsunamiCalls().length, 2);
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
