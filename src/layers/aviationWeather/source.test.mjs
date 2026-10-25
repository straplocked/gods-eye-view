import assert from 'node:assert/strict';
import test from 'node:test';
import { createAviationWeatherSource } from './source.js';

const polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [-104.5, 14.6],
      [-102.2, 13],
      [-101.9, 14.2],
      [-104.5, 14.6],
    ],
  ],
};
const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'metar:KSEA',
      geometry: { type: 'Point', coordinates: [-122.3138, 47.4444] },
      properties: {
        layer: 'aviation-weather',
        source: 'metar',
        station: 'KSEA',
        category: 'VFR',
        wspd: 8,
        timestamp: '2026-10-25T10:53:00.000Z',
      },
    },
    {
      type: 'Feature',
      id: 'isigmet:sigmet-MMMD-1-TURB-202610251000',
      geometry: polygon,
      properties: {
        layer: 'aviation-weather',
        source: 'isigmet',
        advisory: 'sigmet',
        hazard: 'TURB',
        timestamp: '2026-10-25T10:00:00.000Z',
      },
    },
  ],
  metadata: {
    layer: 'aviation-weather',
    fetchedAt: '2026-10-25T11:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      { id: 'metar', ok: true, stale: false, count: 1 },
      { id: 'sigmet', ok: true, stale: false, count: 0 },
      { id: 'isigmet', ok: true, stale: false, count: 1 },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createAviationWeatherSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/aviation-weather']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
});

test('a snapshot with no features is valid', async () => {
  const source = createAviationWeatherSource({
    fetchImpl: async () => Response.json({ ...body, features: [] }),
  });
  assert.deepEqual((await source.getSnapshot()).features, []);
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createAviationWeatherSource({
    fetchImpl: async () =>
      Response.json({ error: 'aviation_weather_unavailable' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Aviation Weather HTTP 502',
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
          ...body.features[1],
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
    const source = createAviationWeatherSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Aviation Weather response',
    });
  }
  const garbage = createAviationWeatherSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Aviation Weather response',
  });
});

test('a body over the 8 MiB cap is refused; a 3 MiB one is read', async () => {
  const big = createAviationWeatherSource({
    fetchImpl: async () =>
      new Response('{}', {
        headers: { 'Content-Length': String(9 * 1024 * 1024) },
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
          raw: 'x'.repeat(3 * 1024 * 1024),
        },
      },
    ],
  };
  const ok = createAviationWeatherSource({
    fetchImpl: async () => Response.json(padded),
  });
  assert.equal((await ok.getSnapshot()).features.length, 1);
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createAviationWeatherSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
