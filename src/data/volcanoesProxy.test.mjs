import test from 'node:test';
import assert from 'node:assert/strict';
import { volcanoesProxy } from '../../server/providers/volcanoes.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import { gvpEruptions, usgsStatus } from '../testSupport/volcanoesFixtures.mjs';

const HOUR = 60 * 60_000;

/** Upstream double: GVP WFS and USGS status, with per-call overrides. */
function upstream({
  gvp = () => Response.json(gvpEruptions),
  // The real service labels its JSON body text/html.
  usgs = () =>
    new Response(JSON.stringify(usgsStatus), {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    }),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    if (parsed.hostname === 'webservices.volcano.si.edu') {
      assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork \(\+/);
      return gvp();
    }
    if (parsed.hostname === 'volcanoes.usgs.gov') {
      // USGS answers 404 to a User-Agent that carries a URL.
      assert.equal(options.headers['User-Agent'], 'GodsEyeView/fork');
      return usgs();
    }
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = volcanoesProxy(options);
  assert.equal(plugin.name, 'volcanoes');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/volcanoes');
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
const bySource = (res, source) =>
  res.body.features
    .filter((feature) => feature.properties.source === source)
    .map((feature) => feature.id);
const hostCount = (calls, host) =>
  calls.filter(({ url }) => url.hostname === host).length;

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves GVP and USGS as one valid merged collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl, now: () => 0 }, hook);
    const res = await request('/?url=https://invalid.example');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'volcanoes');
    // Fixed upstream URLs: the client query went nowhere.
    assert.deepEqual(
      calls.map(({ url }) => url.origin + url.pathname),
      [
        'https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows',
        'https://volcanoes.usgs.gov/vsc/api/volcanoApi/vhpstatus',
      ],
    );
    assert.equal(
      calls[0].url.searchParams.get('CQL_FILTER'),
      "ContinuingEruption='True'",
    );
    assert.equal(
      calls[0].url.searchParams.get('typeName'),
      'GVP-VOTW:E3WebApp_Eruptions1960',
    );
    assert.deepEqual(bySource(res, 'gvp+usgs'), [
      'volcano:332010',
      'volcano:311120',
    ]);
    assert.deepEqual(bySource(res, 'gvp'), [
      'volcano:223020',
      'volcano:252010',
      'volcano:257100',
    ]);
    assert.deepEqual(bySource(res, 'usgs'), [
      'volcano:311360',
      'volcano:284141',
    ]);
    assert.equal(res.body.metadata.partial, false);
    // Per-feed counts are the feeds' own (the joined pair counts in both).
    assert.deepEqual(
      res.body.metadata.sources.map(({ id, count, ok }) => [id, count, ok]),
      [
        ['gvp', 5, true],
        ['usgs', 4, true],
      ],
    );
  });
}

test('guard: a volcano in both feeds is one merged feature with the USGS colorCode and GVP start date; a NORMAL USGS-only volcano is excluded', async () => {
  const { fetchImpl } = upstream();
  const res = await install({ fetchImpl, now: () => 0 })();
  assert.equal(res.status, 200);
  const kilauea = res.body.features.filter(
    (feature) => feature.properties.vnum === 332010,
  );
  assert.equal(kilauea.length, 1, 'Kilauea must appear exactly once');
  assert.equal(kilauea[0].properties.source, 'gvp+usgs');
  assert.equal(kilauea[0].properties.colorCode, 'YELLOW');
  assert.equal(kilauea[0].properties.eruptionStart, '2024-12-23T00:00:00.000Z');
  const sitkin = res.body.features.filter(
    (feature) => feature.properties.vnum === 311120,
  );
  assert.equal(sitkin.length, 1, 'Great Sitkin must appear exactly once');
  assert.equal(sitkin[0].properties.colorCode, 'ORANGE');
  assert.equal(sitkin[0].properties.eruptionStart, '2021-05-25T00:00:00.000Z');
  // Akutan (USGS NORMAL/GREEN) and Adagdak (UNASSIGNED) are not on the map.
  const vnums = res.body.features.map((feature) => feature.properties.vnum);
  assert.ok(!vnums.includes(311320), 'NORMAL USGS-only volcano was served');
  assert.ok(!vnums.includes(311800), 'UNASSIGNED volcano was served');
  assert.equal(res.body.features.length, 7);
});

test('USGS failing while GVP is fine: GVP volcanoes only, usgs ok:false, nothing cached for USGS', async () => {
  let clock = 0;
  let corrupt = true;
  const { calls, fetchImpl } = upstream({
    usgs: () =>
      corrupt
        ? new Response('<html>maintenance</html>', {
            headers: { 'Content-Type': 'text/html' },
          })
        : new Response(JSON.stringify(usgsStatus)),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'volcanoes');
  assert.deepEqual(bySource(res, 'usgs'), []);
  assert.deepEqual(bySource(res, 'gvp+usgs'), []);
  assert.equal(bySource(res, 'gvp').length, 5);
  assert.deepEqual(sourceMeta(res, 'usgs'), {
    id: 'usgs',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'invalid_payload',
  });
  assert.equal(res.body.metadata.partial, true);
  const status = await request('/status');
  assert.equal(status.body.sources[1].cached, false);
  assert.equal(status.body.sources[1].lastError, 'invalid_payload');
  assert.equal(hostCount(calls, 'volcanoes.usgs.gov'), 1);
  // After the failure backoff the next request asks USGS again and merges.
  corrupt = false;
  clock = 60_000;
  const recovered = await request();
  assert.equal(hostCount(calls, 'volcanoes.usgs.gov'), 2);
  assert.equal(sourceMeta(recovered, 'usgs').ok, true);
  assert.equal(bySource(recovered, 'gvp+usgs').length, 2);
});

test('GVP failing while USGS is fine: USGS volcanoes only, gvp ok:false', async () => {
  const { fetchImpl } = upstream({
    gvp: () => new Response('busy', { status: 503 }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'volcanoes');
  assert.equal(sourceMeta(res, 'gvp').error, 'upstream_status');
  assert.equal(sourceMeta(res, 'gvp').count, 0);
  assert.equal(res.body.features.length, 4);
  assert.ok(res.body.features.every((f) => f.properties.source === 'usgs'));
  // Same ids as when GVP is up, so an open card survives the outage.
  assert.deepEqual(
    res.body.features.map((f) => f.id),
    ['volcano:332010', 'volcano:311120', 'volcano:311360', 'volcano:284141'],
  );
});

test('GVP refreshes after 6 hours and USGS after 10 minutes', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  const gvp = () => hostCount(calls, 'webservices.volcano.si.edu');
  const usgs = () => hostCount(calls, 'volcanoes.usgs.gov');
  await request();
  clock = 10 * 60_000 - 1;
  await request();
  assert.deepEqual([gvp(), usgs()], [1, 1]);
  clock = 10 * 60_000;
  await request();
  assert.deepEqual([gvp(), usgs()], [1, 2]);
  clock = 6 * HOUR - 1;
  await request();
  assert.equal(gvp(), 1);
  clock = 6 * HOUR;
  await request();
  assert.deepEqual([gvp(), usgs()], [2, 3]);
});

test('a failed refresh serves the last good snapshot as stale and still merges it', async () => {
  let clock = 0;
  let fail = false;
  const { fetchImpl } = upstream({
    usgs: () => {
      if (fail) throw new Error('private upstream details');
      return new Response(JSON.stringify(usgsStatus));
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  fail = true;
  clock = 10 * 60_000;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.metadata.stale, true);
  assert.deepEqual(sourceMeta(res, 'usgs'), {
    id: 'usgs',
    ok: false,
    stale: true,
    count: 4,
    fetchedAt: '1970-01-01T00:00:00.000Z',
    truncated: false,
    error: 'upstream_unavailable',
  });
  assert.equal(bySource(res, 'gvp+usgs').length, 2);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('a legitimately empty GVP list is cached and does not hide USGS volcanoes', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream({
    gvp: () => Response.json({ type: 'FeatureCollection', features: [] }),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'gvp').ok, true);
  assert.equal(sourceMeta(res, 'gvp').count, 0);
  assert.equal(res.body.features.length, 4);
  clock = 5 * 60_000;
  await request();
  assert.equal(hostCount(calls, 'webservices.volcano.si.edu'), 1);
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
    const { fetchImpl } = upstream({ gvp: huge, usgs: huge });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'volcanoes_unavailable' });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('an oversized USGS body fails only USGS', async () => {
  const { fetchImpl } = upstream({
    usgs: () =>
      new Response('[]', {
        headers: { 'Content-Length': String(3 * 1024 * 1024) },
      }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'usgs').error, 'response_too_large');
  assert.equal(bySource(res, 'gvp').length, 5);
});

test('malformed data from both feeds never becomes a cached empty snapshot', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream({
    gvp: () => Response.json({ error: 'upstream detail' }),
    // An empty list is as wrong as no list: USGS always monitors dozens.
    usgs: () => new Response('[]'),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 502);
  clock = 60_000;
  const again = await request();
  assert.equal(again.status, 502);
  assert.deepEqual(again.body, { error: 'volcanoes_unavailable' });
  assert.equal(calls.length, 4);
});

test('concurrent requests share one upstream operation per feed', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    gvp: async () => {
      await pending;
      return Response.json(gvpEruptions);
    },
    usgs: async () => {
      await pending;
      return new Response(JSON.stringify(usgsStatus));
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
