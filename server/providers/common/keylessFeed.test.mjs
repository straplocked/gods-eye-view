import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  KEYLESS_FEED_USER_AGENT,
  createKeylessFeedProxy,
  createUpstreamClient,
  invalidPayload,
  keylessErrorCode,
  keylessLayerRoute,
} from './keylessFeed.js';
import { assertValidKeylessLayerCollection } from '../../../src/testSupport/geojson.mjs';

const point = (id, lon = 1, lat = 2, extra = {}) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { name: id, ...extra },
});
const fc = (...features) => ({ type: 'FeatureCollection', features });

function install(options, hook = 'configureServer') {
  let handler;
  const plugin = createKeylessFeedProxy({
    name: 'test-layer',
    layerId: 'test-layer',
    ...options,
  });
  plugin[hook]({
    middlewares: {
      use(route, callback) {
        assert.equal(route, '/api/v1/layers/test-layer');
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

test('route convention and configuration validation', () => {
  assert.equal(
    keylessLayerRoute('global-hazards'),
    '/api/v1/layers/global-hazards',
  );
  const ok = { id: 'a', fetchSnapshot: async () => fc() };
  for (const bad of [
    { name: '', layerId: 'x', subsources: [ok] },
    { name: 'x', layerId: 'Not A Slug', subsources: [ok] },
    { name: 'x', layerId: 'x', subsources: [] },
    { name: 'x', layerId: 'x', subsources: [ok, ok] },
    { name: 'x', layerId: 'x', subsources: [{ id: 'b' }] },
  ])
    assert.throws(() => createKeylessFeedProxy(bad), TypeError);
});

test('stamps the layer contract onto features and reports metadata', async () => {
  const request = install({
    now: () => Date.parse('2026-10-25T08:00:00Z'),
    subsources: [
      {
        id: 'alpha',
        fetchSnapshot: async () =>
          fc(point('one', 1, 2, { timestamp: '2026-10-25T07:00:00.000Z' })),
      },
      { id: 'beta', fetchSnapshot: async () => fc() },
    ],
  });
  const res = await request('/?ignored=1');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assertValidKeylessLayerCollection(res.body, 'test-layer');
  assert.deepEqual(res.body.features, [
    {
      type: 'Feature',
      id: 'alpha:one',
      geometry: { type: 'Point', coordinates: [1, 2] },
      properties: {
        name: 'one',
        timestamp: '2026-10-25T07:00:00.000Z',
        layer: 'test-layer',
        source: 'alpha',
      },
    },
  ]);
  assert.deepEqual(res.body.metadata, {
    layer: 'test-layer',
    fetchedAt: '2026-10-25T08:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      {
        id: 'alpha',
        ok: true,
        stale: false,
        count: 1,
        fetchedAt: '2026-10-25T08:00:00.000Z',
        truncated: false,
      },
      {
        id: 'beta',
        ok: true,
        stale: false,
        count: 0,
        fetchedAt: '2026-10-25T08:00:00.000Z',
        truncated: false,
      },
    ],
  });
});

test('a subsource whose output breaks the contract is rejected, not served', async () => {
  for (const output of [
    fc({ ...point('x'), id: '' }),
    fc(point('dup'), point('dup')),
    fc(point('bad', 200, 0)),
    { features: [] },
    null,
  ]) {
    const request = install({
      subsources: [{ id: 'alpha', fetchSnapshot: async () => output }],
    });
    const res = await request();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'test_layer_unavailable' });
  }
});

test('per-subsource TTLs refresh independently', async () => {
  let clock = 0;
  const calls = { fast: 0, slow: 0 };
  const request = install({
    now: () => clock,
    subsources: [
      {
        id: 'fast',
        ttlMs: 1000,
        fetchSnapshot: async () => fc(point(`f${++calls.fast}`)),
      },
      {
        id: 'slow',
        ttlMs: 5000,
        fetchSnapshot: async () => fc(point(`s${++calls.slow}`)),
      },
    ],
  });
  await request();
  clock = 999;
  await request();
  assert.deepEqual(calls, { fast: 1, slow: 1 });
  clock = 1000;
  const res = await request();
  assert.deepEqual(calls, { fast: 2, slow: 1 });
  assert.deepEqual(
    res.body.features.map((f) => f.id),
    ['fast:f2', 'slow:s1'],
  );
});

test('a failed subsource is not retried before the backoff elapses', async () => {
  let clock = 0;
  let calls = 0;
  const request = install({
    now: () => clock,
    failureBackoffMs: 60_000,
    subsources: [
      {
        id: 'alpha',
        fetchSnapshot: async () => {
          calls++;
          throw new Error('secret upstream detail');
        },
      },
    ],
  });
  assert.equal((await request()).status, 502);
  clock = 59_999;
  const held = await request();
  assert.equal(held.status, 502);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(held.body), /secret/);
  clock = 60_000;
  await request();
  assert.equal(calls, 2);
});

test('the status route reads the cache without fetching', async () => {
  let calls = 0;
  const request = install({
    now: () => 0,
    subsources: [
      {
        id: 'alpha',
        fetchSnapshot: async () => {
          calls++;
          return fc(point('one'));
        },
      },
    ],
  });
  assert.deepEqual((await request('/status')).body, {
    layer: 'test-layer',
    sources: [
      {
        id: 'alpha',
        cached: false,
        fetchedAt: null,
        count: 0,
        lastError: null,
      },
    ],
  });
  assert.equal(calls, 0);
  await request();
  assert.equal((await request('/status')).body.sources[0].cached, true);
  assert.equal((await request('/nope')).status, 404);
  assert.equal(calls, 1);
});

test('per-client rate limit answers 429 with Retry-After', async () => {
  const request = install({
    rateLimit: { windowMs: 60_000, max: 2, globalMax: 100 },
    subsources: [{ id: 'alpha', fetchSnapshot: async () => fc() }],
  });
  assert.equal((await request('/', 'GET', 'a')).status, 200);
  assert.equal((await request('/', 'GET', 'a')).status, 200);
  const limited = await request('/', 'GET', 'a');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['Retry-After'], '60');
  assert.equal((await request('/', 'GET', 'b')).status, 200);
});

test('feature cap truncates and says so', async () => {
  const request = install({
    maxFeatures: 2,
    subsources: [
      {
        id: 'alpha',
        fetchSnapshot: async () => fc(point('a'), point('b'), point('c')),
      },
    ],
  });
  const res = await request();
  assert.equal(res.body.features.length, 2);
  assert.equal(res.body.metadata.sources[0].truncated, true);
});

test('subsource details reach metadata.sources as flat scalars only', async () => {
  const request = install({
    subsources: [
      {
        id: 'alpha',
        fetchSnapshot: async () => ({
          ...fc(point('a')),
          details: {
            pendingZones: 7,
            note: 'warming',
            ok: false,
            count: 99,
            nested: { deep: 1 },
            list: [1],
            tooLong: 'x'.repeat(65),
            'bad key': 1,
            nan: Number.NaN,
          },
        }),
      },
      { id: 'beta', fetchSnapshot: async () => fc() },
    ],
  });
  const res = await request();
  const [alpha, beta] = res.body.metadata.sources;
  assert.equal(alpha.pendingZones, 7);
  assert.equal(alpha.note, 'warming');
  // Reserved status keys cannot be overridden and structured values are dropped.
  assert.equal(alpha.ok, true);
  assert.equal(alpha.count, 1);
  for (const key of ['nested', 'list', 'tooLong', 'bad key', 'nan'])
    assert.equal(key in alpha, false, key);
  assert.equal('pendingZones' in beta, false);
  assertValidKeylessLayerCollection(res.body, 'test-layer');
});

test('upstream client sends the User-Agent, the signal and redirect:error', async () => {
  const seen = [];
  const signal = new AbortController().signal;
  const client = createUpstreamClient({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return Response.json({ ok: true });
    },
    signal,
    maxBytes: 1024,
  });
  assert.deepEqual(await client.fetchJson('https://example.test/a'), {
    ok: true,
  });
  assert.equal(seen[0].init.headers['User-Agent'], KEYLESS_FEED_USER_AGENT);
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.signal, signal);
  assert.doesNotMatch(KEYLESS_FEED_USER_AGENT, /@/);
});

test('upstream client maps empty statuses, HTTP errors and caps', async () => {
  const signal = new AbortController().signal;
  const client = (response) =>
    createUpstreamClient({
      fetchImpl: async () => response(),
      signal,
      maxBytes: 16,
    });
  assert.equal(
    await client(() => new Response('{}', { status: 404 })).fetchJson('u', {
      emptyStatuses: [404],
    }),
    null,
  );
  await assert.rejects(
    client(() => new Response('{}', { status: 503 })).fetchJson('u'),
    { code: 'upstream_status' },
  );
  await assert.rejects(client(() => new Response('not json')).fetchJson('u'), {
    code: 'invalid_payload',
  });
  await assert.rejects(
    client(() => new Response('x'.repeat(17))).fetchText('u'),
    { code: 'RESPONSE_TOO_LARGE' },
  );
});

test('upstream client gunzips .gz text bodies under a decoded cap', async () => {
  const signal = new AbortController().signal;
  const body = 'a,b\n1,2\n';
  const gz = gzipSync(body);
  const client = createUpstreamClient({
    fetchImpl: async () => new Response(gz),
    signal,
    maxBytes: 1024,
  });
  assert.equal(await client.fetchText('u', { gzip: true }), body);
  assert.equal(await client.fetchText('u', { gzip: 'auto' }), body);
  const plain = createUpstreamClient({
    fetchImpl: async () => new Response(body),
    signal,
    maxBytes: 1024,
  });
  assert.equal(await plain.fetchText('u', { gzip: 'auto' }), body);
  await assert.rejects(plain.fetchText('u', { gzip: true }), {
    code: 'invalid_payload',
  });
  const bomb = createUpstreamClient({
    fetchImpl: async () => new Response(gzipSync('x'.repeat(10_000))),
    signal,
    maxBytes: 1024,
  });
  await assert.rejects(
    bomb.fetchText('u', { gzip: true, maxDecodedBytes: 1000 }),
    { code: 'RESPONSE_TOO_LARGE' },
  );
});

test('upstream client reads binary bodies under a byte cap', async () => {
  const signal = new AbortController().signal;
  const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 255]);
  const client = (response, maxBytes = 16) =>
    createUpstreamClient({
      fetchImpl: async () => response(),
      signal,
      maxBytes,
    });
  assert.deepEqual(
    await client(() => new Response(bytes)).fetchBytes('u'),
    bytes,
  );
  assert.equal(
    await client(() => new Response('', { status: 404 })).fetchBytes('u', {
      emptyStatuses: [404],
    }),
    null,
  );
  await assert.rejects(
    client(() => new Response('', { status: 503 })).fetchBytes('u'),
    { code: 'upstream_status' },
  );
  await assert.rejects(
    client(() => new Response(new Uint8Array(17))).fetchBytes('u'),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  // A per-call cap wins over the client default.
  assert.equal(
    (
      await client(() => new Response(new Uint8Array(40)), 16).fetchBytes('u', {
        maxBytes: 64,
      })
    ).byteLength,
    40,
  );
});

test('error codes are fixed and client-safe', () => {
  assert.equal(keylessErrorCode(invalidPayload('x')), 'invalid_payload');
  assert.equal(
    keylessErrorCode(
      Object.assign(new Error('x'), { code: 'invalid_payload' }),
    ),
    'invalid_payload',
  );
  assert.equal(
    keylessErrorCode(
      Object.assign(new Error(), { code: 'RESPONSE_TOO_LARGE' }),
    ),
    'response_too_large',
  );
  assert.equal(
    keylessErrorCode(new DOMException('t', 'TimeoutError')),
    'timeout',
  );
  assert.equal(keylessErrorCode(new SyntaxError('x')), 'invalid_payload');
  assert.equal(
    keylessErrorCode(
      Object.assign(new Error('/etc/passwd'), { code: 'EACCES' }),
    ),
    'upstream_unavailable',
  );
});

test('combine joins the served subsources into the response features', async () => {
  const seen = [];
  const request = install({
    now: () => 0,
    combine(features) {
      seen.push(features.map((feature) => feature.id));
      const keys = new Map();
      for (const feature of features) {
        const key = feature.id.split(':')[1];
        const entry = keys.get(key) || [];
        entry.push(feature.properties.source);
        keys.set(key, entry);
      }
      return [...keys].map(([key, sources]) => ({
        type: 'Feature',
        id: `joined:${key}`,
        geometry: point(key).geometry,
        properties: {
          layer: 'test-layer',
          source: sources.join('+'),
          timestamp: null,
        },
      }));
    },
    subsources: [
      { id: 'alpha', fetchSnapshot: async () => fc(point('x'), point('y')) },
      { id: 'beta', fetchSnapshot: async () => fc(point('x')) },
    ],
  });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'test-layer');
  // combine sees the stamped, prefixed features of every served subsource.
  assert.deepEqual(seen, [['alpha:x', 'alpha:y', 'beta:x']]);
  assert.deepEqual(
    res.body.features.map((f) => [f.id, f.properties.source]),
    [
      ['joined:x', 'alpha+beta'],
      ['joined:y', 'alpha'],
    ],
  );
  // Metadata still reports each subsource's own feature count.
  assert.deepEqual(
    res.body.metadata.sources.map(({ id, count }) => [id, count]),
    [
      ['alpha', 2],
      ['beta', 1],
    ],
  );
});

test('combine runs on what is served: one failing subsource still combines the rest', async () => {
  const request = install({
    now: () => 0,
    combine: (features) => features.map((f) => ({ ...f, id: `c:${f.id}` })),
    subsources: [
      { id: 'alpha', fetchSnapshot: async () => fc(point('x')) },
      {
        id: 'beta',
        fetchSnapshot: async () => {
          throw invalidPayload('broken');
        },
      },
    ],
  });
  const res = await request();
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.features.map((f) => f.id),
    ['c:alpha:x'],
  );
  assert.equal(res.body.metadata.partial, true);
});

test('a combine result that breaks the contract answers a sanitized 502', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const combine of [
      // Duplicate ids.
      (features) => [features[0], features[0]],
      // Wrong layer.
      (features) => [
        {
          ...features[0],
          properties: { ...features[0].properties, layer: 'x' },
        },
      ],
      // Not a list.
      () => null,
      // Throws.
      () => {
        throw new Error('private detail');
      },
    ]) {
      const request = install({
        combine,
        subsources: [
          { id: 'alpha', fetchSnapshot: async () => fc(point('x')) },
        ],
      });
      const res = await request();
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, { error: 'test_layer_unavailable' });
    }
  } finally {
    console.warn = warn;
  }
  assert.throws(
    () =>
      createKeylessFeedProxy({
        name: 'x',
        layerId: 'x',
        combine: 'nope',
        subsources: [{ id: 'a', fetchSnapshot: async () => fc() }],
      }),
    TypeError,
  );
});

test('a request can override the kit User-Agent for one upstream', async () => {
  const agents = [];
  const request = install({
    fetchImpl: async (url, init) => {
      agents.push(init.headers['User-Agent']);
      return Response.json(fc(point('x')));
    },
    subsources: [
      {
        id: 'alpha',
        fetchSnapshot: async ({ fetchJson }) => {
          await fetchJson('https://a.example/default');
          return fetchJson('https://a.example/override', {
            headers: { 'User-Agent': 'Bare/1' },
          });
        },
      },
    ],
  });
  assert.equal((await request()).status, 200);
  assert.deepEqual(agents, [KEYLESS_FEED_USER_AGENT, 'Bare/1']);
});
