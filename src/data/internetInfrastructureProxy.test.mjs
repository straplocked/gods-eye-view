import test from 'node:test';
import assert from 'node:assert/strict';
import { internetInfrastructureProxy } from '../../server/providers/internetInfrastructure.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import {
  NOW_MS,
  countryPayload,
  facilityPayload,
  regionPayload,
} from '../testSupport/internetInfrastructureFixtures.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const IODA_PATH = '/v2/outages/alerts';
const PDB_PATH = '/api/fac';

/** Upstream double: IODA's alert list (per entity type) and PeeringDB's facility list. */
function upstream({
  country = () => Response.json(countryPayload()),
  region = () => Response.json(regionPayload()),
  facilities = () => Response.json(facilityPayload()),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork \(\+/);
    if (parsed.pathname === IODA_PATH) {
      assert.equal(parsed.hostname, 'api.ioda.inetintel.cc.gatech.edu');
      return parsed.searchParams.get('entityType') === 'region'
        ? region(parsed)
        : country(parsed);
    }
    if (parsed.pathname === PDB_PATH) {
      assert.equal(parsed.hostname, 'www.peeringdb.com');
      return facilities(parsed);
    }
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = internetInfrastructureProxy({ now: () => NOW_MS, ...options });
  assert.equal(plugin.name, 'internet-infrastructure');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/internet-infrastructure');
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
const entityCalls = (calls, type) =>
  calls.filter(
    ({ url }) =>
      url.pathname === IODA_PATH && url.searchParams.get('entityType') === type,
  ).length;
const pdbCalls = (calls) =>
  calls.filter(({ url }) => url.pathname === PDB_PATH).length;
/** [country requests, region requests, PeeringDB requests]. */
const counts = (calls) => [
  entityCalls(calls, 'country'),
  entityCalls(calls, 'region'),
  pdbCalls(calls),
];

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves data centers and outage markers as one valid collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl }, hook);
    const res = await request('/?url=https://invalid.example&entityType=asn');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'internet-infrastructure');
    // Fixed upstream URLs: the client query went nowhere.
    const urls = calls.map(({ url }) => url.origin + url.pathname + url.search);
    assert.deepEqual(urls.sort(), [
      'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=1792843200&until=1792929600&entityType=country&limit=5000&extendWindow=1209600',
      'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/alerts?from=1792843200&until=1792929600&entityType=region&limit=5000',
      'https://www.peeringdb.com/api/fac?depth=0&fields=id,name,org_name,city,country,latitude,longitude,net_count,ix_count,website,status',
    ]);
    // Data centers first, so the outage markers are added last and draw on top.
    assert.deepEqual(
      res.body.features.map((feature) => feature.id),
      [
        'datacenters:1',
        'datacenters:2',
        'datacenters:4',
        'datacenters:7',
        'datacenters:9',
        'outages:LV',
        'outages:NF',
        'outages:NG',
        'outages:TL',
        'outages:BB',
        'outages:CM',
        'outages:DK',
      ],
    );
    assert.deepEqual(
      [...new Set(res.body.features.map((f) => f.properties.source))],
      ['datacenters', 'outages'],
    );
    assert.equal(res.body.metadata.partial, false);
    assert.equal(res.body.metadata.stale, false);
    assert.deepEqual(
      res.body.metadata.sources.map(({ id, count, ok }) => [id, count, ok]),
      [
        ['datacenters', 5, true],
        ['outages', 7, true],
      ],
    );
    // The normalizer's details ride in the source status.
    assert.equal(sourceMeta(res, 'outages').unplaced, 2);
    assert.equal(sourceMeta(res, 'outages').regionsIncluded, true);
  });
}

test('guard: the route places an outage at its country centroid and drops a facility with no latitude', async () => {
  const { fetchImpl } = upstream();
  const res = await install({ fetchImpl })();
  const timor = res.body.features.find((f) => f.id === 'outages:TL');
  assert.deepEqual(timor.geometry, {
    type: 'Point',
    coordinates: [125.7, -8.8],
  });
  assert.equal(timor.properties.start, '2026-10-25T07:00:00.000Z');
  assert.equal(timor.properties.layer, 'internet-infrastructure');
  assert.equal(timor.properties.source, 'outages');
  // Facility 3 and 5 have a null latitude: not on the route, and nothing at 0,0.
  assert.equal(
    res.body.features.find((f) => f.id === 'datacenters:3'),
    undefined,
  );
  assert.equal(
    res.body.features.find((f) => f.id === 'datacenters:5'),
    undefined,
  );
  assert.deepEqual(
    res.body.features.filter(
      ({ geometry }) =>
        geometry.coordinates[0] === 0 && geometry.coordinates[1] === 0,
    ),
    [],
  );
  const hub = res.body.features.find((f) => f.id === 'datacenters:1');
  assert.equal(hub.properties.netCount, 523);
  assert.equal(hub.properties.website, 'https://colo.example/');
});

test('outages refresh after 10 minutes, data centers only after 24 hours', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  await request();
  clock = NOW_MS + 10 * MINUTE - 1;
  await request();
  assert.deepEqual(counts(calls), [1, 1, 1]);
  clock = NOW_MS + 10 * MINUTE;
  await request();
  assert.deepEqual(counts(calls), [2, 2, 1]);
  clock = NOW_MS + 24 * HOUR - 1;
  await request();
  assert.equal(pdbCalls(calls), 1);
  clock = NOW_MS + 24 * HOUR;
  await request();
  assert.equal(pdbCalls(calls), 2);
});

test('a failing region list only drops the region detail; the country markers still serve', async () => {
  const { fetchImpl } = upstream({
    region: () => new Response('busy', { status: 503 }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'internet-infrastructure');
  assert.deepEqual(
    res.body.features
      .filter((f) => f.properties.source === 'outages')
      .map((f) => f.id),
    [
      'outages:NF',
      'outages:TL',
      'outages:BB',
      'outages:CM',
      'outages:DK',
      'outages:NG',
    ],
  );
  assert.equal(sourceMeta(res, 'outages').ok, true);
  assert.equal(sourceMeta(res, 'outages').regionsIncluded, false);
  assert.equal(res.body.metadata.partial, false);
});

test('a country list that fails fails the outage feed only; data centers still serve and nothing is cached for outages', async () => {
  let clock = NOW_MS;
  let broken = true;
  const { calls, fetchImpl } = upstream({
    country: () =>
      broken
        ? new Response('bad gateway', { status: 502 })
        : Response.json(countryPayload()),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'internet-infrastructure');
  assert.equal(res.body.features.length, 5);
  assert.deepEqual(sourceMeta(res, 'outages'), {
    id: 'outages',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'upstream_status',
  });
  assert.equal(sourceMeta(res, 'datacenters').ok, true);
  assert.equal(res.body.metadata.partial, true);
  const status = await request('/status');
  assert.deepEqual(
    status.body.sources.map(({ id, cached, lastError }) => [
      id,
      cached,
      lastError,
    ]),
    [
      ['datacenters', true, null],
      ['outages', false, 'upstream_status'],
    ],
  );
  // Inside the failure backoff nothing is retried; after it, IODA is asked again.
  const before = entityCalls(calls, 'country');
  await request();
  assert.equal(entityCalls(calls, 'country'), before);
  broken = false;
  clock = NOW_MS + MINUTE;
  const recovered = await request();
  assert.equal(sourceMeta(recovered, 'outages').ok, true);
  assert.equal(recovered.body.features.length, 12);
});

test('PeeringDB failing while IODA is fine: outages served, data centers ok:false', async () => {
  const { fetchImpl } = upstream({
    facilities: () => new Response('throttled', { status: 429 }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'internet-infrastructure');
  assert.equal(res.body.features.length, 7);
  assert.equal(sourceMeta(res, 'datacenters').error, 'upstream_status');
  assert.equal(sourceMeta(res, 'datacenters').ok, false);
});

test('a failed refresh serves the last good snapshot as stale', async () => {
  let clock = NOW_MS;
  let fail = false;
  const { fetchImpl } = upstream({
    country: () => {
      if (fail) throw new Error('private upstream details');
      return Response.json(countryPayload());
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
  const outages = sourceMeta(res, 'outages');
  assert.deepEqual(
    [outages.ok, outages.stale, outages.count, outages.error],
    [false, true, 7, 'upstream_unavailable'],
  );
  assert.equal(res.body.features.length, 12);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('a PeeringDB error body or short list is refused and never cached as an empty map', async () => {
  let clock = NOW_MS;
  let answer = () =>
    Response.json({ meta: { error: 'rate limited' }, data: [] });
  const { calls, fetchImpl } = upstream({ facilities: () => answer() });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'datacenters').error, 'invalid_payload');
  assert.equal(sourceMeta(res, 'datacenters').count, 0);
  assert.equal(res.body.features.length, 7);
  // Retried after the backoff, then healthy, then cached for the day.
  answer = () => Response.json(facilityPayload());
  clock = NOW_MS + MINUTE;
  const healed = await request();
  assert.equal(sourceMeta(healed, 'datacenters').count, 5);
  assert.equal(pdbCalls(calls), 2);
  clock = NOW_MS + 2 * HOUR;
  await request();
  assert.equal(pdbCalls(calls), 2);
});

test('a quiet world (every signal normal) is cached like any snapshot and is not an error', async () => {
  let clock = NOW_MS;
  const quiet = {
    ...countryPayload(),
    data: countryPayload().data.filter((a) => a.level === 'normal'),
  };
  const { calls, fetchImpl } = upstream({
    country: () => Response.json(quiet),
    region: () => Response.json({ ...regionPayload(), data: [] }),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'outages').ok, true);
  assert.equal(sourceMeta(res, 'outages').count, 0);
  assert.equal(res.body.features.length, 5);
  clock = NOW_MS + 9 * MINUTE;
  await request();
  assert.deepEqual(counts(calls), [1, 1, 1]);
});

test('an IODA answer with no alerts at all is a broken service, never a cached empty map', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    country: () => Response.json({ ...countryPayload(), data: [] }),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(sourceMeta(res, 'outages').error, 'invalid_payload');
  assert.equal(sourceMeta(res, 'outages').count, 0);
  const before = entityCalls(calls, 'country');
  clock = NOW_MS + MINUTE;
  await request();
  assert.ok(
    entityCalls(calls, 'country') > before,
    'retried after the backoff',
  );
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
    const { fetchImpl } = upstream({ country: huge, facilities: huge });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, {
      error: 'internet_infrastructure_unavailable',
    });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('malformed data from both feeds never becomes a cached empty snapshot', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    country: () => new Response('<html>error</html>'),
    facilities: () => Response.json({ error: 'upstream detail' }),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 502);
  clock = NOW_MS + MINUTE;
  const again = await request();
  assert.equal(again.status, 502);
  assert.deepEqual(again.body, {
    error: 'internet_infrastructure_unavailable',
  });
  // The region list is only asked for after the country list parses.
  assert.equal(entityCalls(calls, 'country'), 2);
  assert.equal(entityCalls(calls, 'region'), 0);
  assert.equal(pdbCalls(calls), 2);
});

test('concurrent requests share one upstream operation per feed', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    country: async () => {
      await pending;
      return Response.json(countryPayload());
    },
    facilities: async () => {
      await pending;
      return Response.json(facilityPayload());
    },
  });
  const request = install({ fetchImpl });
  const responses = [request(), request('/', 'GET', 'other')];
  await new Promise((resolve) => setTimeout(resolve, 10));
  // One country request and one PeeringDB request in flight, the region list not yet.
  assert.deepEqual(counts(calls), [1, 0, 1]);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.deepEqual(counts(calls), [1, 1, 1]);
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
