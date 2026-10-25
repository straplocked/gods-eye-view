import test from 'node:test';
import assert from 'node:assert/strict';
import { globalHazardsProxy } from '../../server/providers/globalHazards.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import {
  eonetEvents,
  gdacsCyclones,
  gdacsDroughts,
  gdacsEarthquakes,
  gdacsFloods,
  gdacsVolcanoes,
  gdacsWildfires,
} from '../testSupport/globalHazardsFixtures.mjs';

const GDACS_BY_TYPE = {
  EQ: gdacsEarthquakes,
  TC: gdacsCyclones,
  FL: gdacsFloods,
  VO: gdacsVolcanoes,
  DR: gdacsDroughts,
  WF: gdacsWildfires,
};

/** Upstream double: GDACS MAP per type and EONET, with per-call overrides. */
function upstream({
  gdacs = (type) => Response.json(GDACS_BY_TYPE[type]),
  eonet = () => Response.json(eonetEvents),
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork/);
    if (parsed.hostname === 'www.gdacs.org')
      return gdacs(parsed.searchParams.get('eventtype'));
    if (parsed.hostname === 'eonet.gsfc.nasa.gov') return eonet();
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = globalHazardsProxy(options);
  assert.equal(plugin.name, 'global-hazards');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/global-hazards');
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
  test(`${hook}: serves every GDACS type and EONET as one valid collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl, now: () => 0 }, hook);
    const res = await request('/?url=https://invalid.example');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'global-hazards');
    assert.deepEqual(
      calls
        .filter(({ url }) => url.hostname === 'www.gdacs.org')
        .map(({ url }) => url.searchParams.get('eventtype')),
      ['EQ', 'TC', 'FL', 'VO', 'DR', 'WF'],
    );
    assert.ok(
      calls.every(({ url }) =>
        ['www.gdacs.org', 'eonet.gsfc.nasa.gov'].includes(url.hostname),
      ),
    );
    assert.deepEqual(ids(res, 'gdacs'), [
      'gdacs:EQ-1573748',
      'gdacs:TC-1001338',
      'gdacs:FL-1104243',
      'gdacs:VO-1000152',
      'gdacs:DR-1027465',
      'gdacs:WF-1033119',
    ]);
    assert.deepEqual(ids(res, 'eonet'), [
      'eonet:EONET_25590',
      'eonet:EONET_25589',
      'eonet:EONET_6474',
      'eonet:EONET_9001',
    ]);
    assert.equal(res.body.metadata.partial, false);
  });
}

test('a GDACS type with nothing current (404) is empty, not a failure', async () => {
  const { fetchImpl } = upstream({
    gdacs: (type) =>
      type === 'VO'
        ? Response.json({ title: 'Not Found', status: 404 }, { status: 404 })
        : Response.json(GDACS_BY_TYPE[type]),
  });
  const res = await install({ fetchImpl })();
  assert.equal(sourceMeta(res, 'gdacs').ok, true);
  assert.equal(sourceMeta(res, 'gdacs').count, 5);
  assert.ok(!ids(res, 'gdacs').includes('gdacs:VO-1000152'));
});

test('corrupt GDACS while EONET is fine: 200 with EONET, gdacs ok:false, nothing cached for GDACS', async () => {
  let clock = 0;
  let corrupt = true;
  const { calls, fetchImpl } = upstream({
    gdacs: (type) =>
      corrupt
        ? new Response('{"features": "<html>maintenance</html>"}')
        : Response.json(GDACS_BY_TYPE[type]),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'global-hazards');
  assert.deepEqual(ids(res, 'gdacs'), []);
  assert.equal(ids(res, 'eonet').length, 4);
  assert.deepEqual(sourceMeta(res, 'gdacs'), {
    id: 'gdacs',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'invalid_payload',
  });
  assert.equal(sourceMeta(res, 'eonet').ok, true);
  assert.equal(res.body.metadata.partial, true);
  // No empty GDACS snapshot was cached: the status route has nothing, and
  // once the failure backoff passes the next request asks GDACS again.
  const status = await request('/status');
  assert.equal(status.body.sources[0].cached, false);
  assert.equal(status.body.sources[0].lastError, 'invalid_payload');
  const gdacsCalls = () =>
    calls.filter(({ url }) => url.hostname === 'www.gdacs.org').length;
  assert.equal(gdacsCalls(), 6);
  corrupt = false;
  clock = 60_000;
  const recovered = await request();
  assert.equal(gdacsCalls(), 12);
  assert.equal(sourceMeta(recovered, 'gdacs').ok, true);
  assert.equal(ids(recovered, 'gdacs').length, 6);
});

test('one failing GDACS type serves the other five and names the missing type', async () => {
  let clock = 0;
  let tcDown = true;
  const { fetchImpl } = upstream({
    gdacs: (type) =>
      type === 'TC' && tcDown
        ? new Response('busy', { status: 503 })
        : Response.json(GDACS_BY_TYPE[type]),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'global-hazards');
  assert.equal(sourceMeta(res, 'gdacs').ok, true);
  assert.equal(sourceMeta(res, 'gdacs').missingTypes, 'TC');
  assert.equal(ids(res, 'gdacs').length, 5);
  assert.equal(ids(res, 'eonet').length, 4);
  // TC recovers, then fails again: its last good list fills the gap.
  tcDown = false;
  clock = 15 * 60_000;
  const recovered = await request();
  assert.equal(ids(recovered, 'gdacs').length, 6);
  assert.equal(sourceMeta(recovered, 'gdacs').missingTypes, undefined);
  tcDown = true;
  clock = 30 * 60_000;
  const held = await request();
  assert.equal(ids(held, 'gdacs').length, 6);
  assert.equal(sourceMeta(held, 'gdacs').missingTypes, 'TC(cached)');
});

test('a hanging GDACS type misses its deadline without holding back the rest', async () => {
  const { fetchImpl } = upstream({
    gdacs: (type) =>
      type === 'DR'
        ? new Promise(() => {})
        : Response.json(GDACS_BY_TYPE[type]),
  });
  const started = performance.now();
  const res = await install({ fetchImpl, gdacsTypeDeadlineMs: 40 })();
  assert.ok(performance.now() - started < 2_000);
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'gdacs').ok, true);
  assert.equal(sourceMeta(res, 'gdacs').missingTypes, 'DR');
  assert.equal(ids(res, 'gdacs').length, 5);
});

test('GDACS refreshes after 15 minutes and EONET after 30', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  const count = (host) =>
    calls.filter(({ url }) => url.hostname === host).length;
  await request();
  clock = 15 * 60_000 - 1;
  await request();
  assert.equal(count('www.gdacs.org'), 6);
  assert.equal(count('eonet.gsfc.nasa.gov'), 1);
  clock = 15 * 60_000;
  await request();
  assert.equal(count('www.gdacs.org'), 12);
  assert.equal(count('eonet.gsfc.nasa.gov'), 1);
  clock = 30 * 60_000;
  await request();
  assert.equal(count('eonet.gsfc.nasa.gov'), 2);
});

test('a failed refresh serves the last good snapshot as stale', async () => {
  let clock = 0;
  let fail = false;
  const { fetchImpl } = upstream({
    gdacs: (type) => {
      if (fail) throw new Error('private upstream details');
      return Response.json(GDACS_BY_TYPE[type]);
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  fail = true;
  clock = 15 * 60_000;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.metadata.stale, true);
  assert.deepEqual(sourceMeta(res, 'gdacs'), {
    id: 'gdacs',
    ok: false,
    stale: true,
    count: 6,
    fetchedAt: '1970-01-01T00:00:00.000Z',
    truncated: false,
    error: 'upstream_unavailable',
  });
  assert.equal(ids(res, 'gdacs').length, 6);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
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
    const { fetchImpl } = upstream({ gdacs: huge, eonet: huge });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'global_hazards_unavailable' });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('an oversized EONET body fails only EONET', async () => {
  const { fetchImpl } = upstream({
    eonet: () =>
      new Response('[]', {
        headers: { 'Content-Length': String(9 * 1024 * 1024) },
      }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'eonet').error, 'response_too_large');
  assert.equal(ids(res, 'gdacs').length, 6);
});

test('malformed data from both feeds never becomes a cached empty snapshot', async () => {
  let clock = 0;
  const { calls, fetchImpl } = upstream({
    gdacs: () => Response.json({ error: 'upstream detail' }),
    eonet: () => Response.json({ error: 'upstream detail' }),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 502);
  clock = 60_000;
  const again = await request();
  assert.equal(again.status, 502);
  assert.deepEqual(again.body, { error: 'global_hazards_unavailable' });
  assert.equal(calls.length, 14);
});

test('concurrent requests share one upstream operation per feed', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    gdacs: async (type) => {
      await pending;
      return Response.json(GDACS_BY_TYPE[type]);
    },
    eonet: async () => {
      await pending;
      return Response.json(eonetEvents);
    },
  });
  const request = install({ fetchImpl });
  const responses = [request(), request('/', 'GET', 'other')];
  await new Promise(setImmediate);
  assert.equal(calls.length, 7);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.equal(calls.length, 7);
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
