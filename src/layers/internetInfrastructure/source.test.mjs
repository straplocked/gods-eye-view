import assert from 'node:assert/strict';
import test from 'node:test';
import { createInternetInfrastructureSource } from './source.js';

const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'datacenters:1',
      geometry: { type: 'Point', coordinates: [-77.459, 39.0164] },
      properties: {
        layer: 'internet-infrastructure',
        source: 'datacenters',
        facility: 1,
        name: 'Example Interconnect DC1 - Ashburn',
        org: null,
        netCount: 523,
        timestamp: null,
      },
    },
    {
      type: 'Feature',
      id: 'outages:TL',
      geometry: { type: 'Point', coordinates: [125.7, -8.8] },
      properties: {
        layer: 'internet-infrastructure',
        source: 'outages',
        code: 'TL',
        level: 'critical',
        end: null,
        timestamp: '2026-10-25T10:00:00.000Z',
      },
    },
  ],
  metadata: {
    layer: 'internet-infrastructure',
    fetchedAt: '2026-10-25T11:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      { id: 'datacenters', ok: true, stale: false, count: 1 },
      { id: 'outages', ok: true, stale: false, count: 1, unplaced: 1 },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createInternetInfrastructureSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/internet-infrastructure']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
  // A null survives the round trip.
  assert.equal(snapshot.features[0].properties.org, null);
  assert.equal(snapshot.features[1].properties.end, null);
});

test('a snapshot with no features is valid', async () => {
  const source = createInternetInfrastructureSource({
    fetchImpl: async () => Response.json({ ...body, features: [] }),
  });
  assert.deepEqual((await source.getSnapshot()).features, []);
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createInternetInfrastructureSource({
    fetchImpl: async () =>
      Response.json(
        { error: 'internet_infrastructure_unavailable' },
        { status: 502 },
      ),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Internet Outages & Data Centers HTTP 502',
    status: 502,
    retryable: true,
  });
});

test('a body that breaks the layer contract is refused', async () => {
  const first = body.features[0];
  for (const payload of [
    { type: 'FeatureCollection', features: [] },
    { ...body, features: [{ ...first, id: undefined }] },
    {
      ...body,
      features: [
        { ...first, geometry: { type: 'Point', coordinates: [200, 5] } },
      ],
    },
    {
      ...body,
      features: [
        {
          ...first,
          properties: { ...first.properties, timestamp: 'yesterday' },
        },
      ],
    },
    { error: 'nope' },
  ]) {
    const source = createInternetInfrastructureSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Internet Outages & Data Centers response',
    });
  }
  const garbage = createInternetInfrastructureSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Internet Outages & Data Centers response',
  });
});

test('a body over the 4 MiB cap is refused; a 2 MiB one is read', async () => {
  const big = createInternetInfrastructureSource({
    fetchImpl: async () =>
      new Response('{}', {
        headers: { 'Content-Length': String(5 * 1024 * 1024) },
      }),
  });
  await assert.rejects(big.getSnapshot(), { code: 'RESPONSE_TOO_LARGE' });
  const padded = {
    ...body,
    features: [
      {
        ...body.features[0],
        properties: {
          ...body.features[0].properties,
          note: 'x'.repeat(2 * 1024 * 1024),
        },
      },
    ],
  };
  const ok = createInternetInfrastructureSource({
    fetchImpl: async () => Response.json(padded),
  });
  assert.equal((await ok.getSnapshot()).features.length, 1);
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createInternetInfrastructureSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
