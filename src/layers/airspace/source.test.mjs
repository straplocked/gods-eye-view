import assert from 'node:assert/strict';
import test from 'node:test';
import { createAirspaceSource } from './source.js';

const polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-107.39167, 37.45528],
      [-107.43639, 37.00139],
      [-107.13, 37.00139],
      [-107.39167, 37.45528],
    ],
  ],
};
const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'tfr:6/2117#1',
      geometry: polygon,
      properties: {
        layer: 'airspace',
        source: 'tfr',
        notam: '6/2117',
        category: 'hazards',
        timestamp: '2026-10-25T02:46:47.000Z',
      },
    },
    {
      type: 'Feature',
      id: 'delays:EWR',
      geometry: { type: 'Point', coordinates: [-74.1687, 40.6925] },
      properties: {
        layer: 'airspace',
        source: 'delays',
        airport: 'EWR',
        delayType: 'ground-delay',
        timestamp: '2026-10-25T10:55:03.000Z',
      },
    },
  ],
  metadata: {
    layer: 'airspace',
    fetchedAt: '2026-10-25T11:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      { id: 'tfr', ok: true, stale: false, count: 1 },
      { id: 'delays', ok: true, stale: false, count: 1 },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createAirspaceSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/airspace']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
});

test('a snapshot with no features is valid', async () => {
  const source = createAirspaceSource({
    fetchImpl: async () => Response.json({ ...body, features: [] }),
  });
  assert.deepEqual((await source.getSnapshot()).features, []);
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createAirspaceSource({
    fetchImpl: async () =>
      Response.json({ error: 'airspace_unavailable' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Airspace HTTP 502',
    status: 502,
    retryable: true,
  });
});

test('a body that breaks the layer contract is refused', async () => {
  const first = body.features[1];
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
          ...body.features[0],
          // An open ring.
          geometry: {
            type: 'Polygon',
            coordinates: [polygon.coordinates[0].slice(0, 3)],
          },
        },
      ],
    },
    { error: 'nope' },
  ]) {
    const source = createAirspaceSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Airspace response',
    });
  }
  const garbage = createAirspaceSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Airspace response',
  });
});

test('a body over the 4 MiB cap is refused; a 3 MiB one is read', async () => {
  const big = createAirspaceSource({
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
        ...body.features[1],
        properties: {
          ...body.features[1].properties,
          reason: 'x'.repeat(3 * 1024 * 1024),
        },
      },
    ],
  };
  const ok = createAirspaceSource({
    fetchImpl: async () => Response.json(padded),
  });
  assert.equal((await ok.getSnapshot()).features.length, 1);
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createAirspaceSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
