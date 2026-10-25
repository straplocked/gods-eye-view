import assert from 'node:assert/strict';
import test from 'node:test';
import { createWaterObservationsSource } from './source.js';

const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'buoys:41008',
      geometry: { type: 'Point', coordinates: [-80.866, 31.4] },
      properties: {
        layer: 'water-observations',
        source: 'buoys',
        station: '41008',
        windKt: 25.3,
        waterC: null,
        timestamp: '2026-10-25T10:50:00.000Z',
      },
    },
    {
      type: 'Feature',
      id: 'rivers:ASTF1',
      geometry: { type: 'Point', coordinates: [-81.5222, 29.1667] },
      properties: {
        layer: 'water-observations',
        source: 'rivers',
        gauge: 'ASTF1',
        category: 'moderate',
        timestamp: '2026-10-25T10:30:00.000Z',
      },
    },
  ],
  metadata: {
    layer: 'water-observations',
    fetchedAt: '2026-10-25T11:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      { id: 'buoys', ok: true, stale: false, count: 1 },
      { id: 'rivers', ok: true, stale: false, count: 1 },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createWaterObservationsSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/water-observations']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
  // A null measurement survives the round trip.
  assert.equal(snapshot.features[0].properties.waterC, null);
});

test('a snapshot with no features is valid', async () => {
  const source = createWaterObservationsSource({
    fetchImpl: async () => Response.json({ ...body, features: [] }),
  });
  assert.deepEqual((await source.getSnapshot()).features, []);
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createWaterObservationsSource({
    fetchImpl: async () =>
      Response.json(
        { error: 'water_observations_unavailable' },
        { status: 502 },
      ),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Buoys & River Gauges HTTP 502',
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
    const source = createWaterObservationsSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Buoys & River Gauges response',
    });
  }
  const garbage = createWaterObservationsSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Buoys & River Gauges response',
  });
});

test('a body over the 4 MiB cap is refused; a 2 MiB one is read', async () => {
  const big = createWaterObservationsSource({
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
  const ok = createWaterObservationsSource({
    fetchImpl: async () => Response.json(padded),
  });
  assert.equal((await ok.getSnapshot()).features.length, 1);
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createWaterObservationsSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
