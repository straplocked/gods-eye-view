import assert from 'node:assert/strict';
import test from 'node:test';
import { createCitizenSensorsSource } from './source.js';

const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'airpm:1891_1385',
      geometry: { type: 'Point', coordinates: [9.15, 48.55] },
      properties: {
        layer: 'citizen-sensors',
        source: 'airpm',
        pm25: 28,
        pm10: null,
        sensors: 4,
        aqi: 86,
        category: 'moderate',
        timestamp: '2026-10-25T08:55:00.000Z',
      },
    },
    {
      type: 'Feature',
      id: 'radiation:d65002',
      geometry: { type: 'Point', coordinates: [136.163, 34.483] },
      properties: {
        layer: 'citizen-sensors',
        source: 'radiation',
        device: 65002,
        unit: 'cpm',
        cpm: 50,
        usv: 0.15,
        usvEstimated: true,
        timestamp: '2026-10-25T08:58:00.000Z',
      },
    },
  ],
  metadata: {
    layer: 'citizen-sensors',
    fetchedAt: '2026-10-25T09:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      { id: 'airpm', ok: true, stale: false, count: 1, sensors: 4 },
      { id: 'radiation', ok: true, stale: false, count: 1, rows: 12 },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createCitizenSensorsSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/citizen-sensors']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
  // A null PM10 survives the round trip.
  assert.equal(snapshot.features[0].properties.pm10, null);
});

test('a snapshot with no features is valid', async () => {
  const source = createCitizenSensorsSource({
    fetchImpl: async () => Response.json({ ...body, features: [] }),
  });
  assert.deepEqual((await source.getSnapshot()).features, []);
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createCitizenSensorsSource({
    fetchImpl: async () =>
      Response.json({ error: 'citizen_sensors_unavailable' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Citizen Air & Radiation Sensors HTTP 502',
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
    {
      ...body,
      features: [
        { ...first, properties: { ...first.properties, layer: 'other' } },
      ],
    },
    { error: 'nope' },
  ]) {
    const source = createCitizenSensorsSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Citizen Air & Radiation Sensors response',
    });
  }
  const garbage = createCitizenSensorsSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Citizen Air & Radiation Sensors response',
  });
});

test('a body over the 4 MiB cap is refused; a 2 MiB one is read', async () => {
  const big = createCitizenSensorsSource({
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
  const ok = createCitizenSensorsSource({
    fetchImpl: async () => Response.json(padded),
  });
  assert.equal((await ok.getSnapshot()).features.length, 1);
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createCitizenSensorsSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
