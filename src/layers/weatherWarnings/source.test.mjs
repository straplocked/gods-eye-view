import assert from 'node:assert/strict';
import test from 'node:test';
import { createWeatherWarningsSource } from './source.js';

const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'nws:urn:oid:2.49.0.1.840.0.abc.001.1',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-104.85, 32],
            [-104.35, 32],
            [-104.35, 32.5],
            [-104.85, 32],
          ],
        ],
      },
      properties: {
        layer: 'weather-warnings',
        source: 'nws',
        event: 'Flash Flood Warning',
        severity: 'Severe',
        timestamp: '2026-10-25T08:01:00.000Z',
      },
    },
  ],
  metadata: {
    layer: 'weather-warnings',
    fetchedAt: '2026-10-25T09:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      { id: 'nws', ok: true, stale: false, count: 1, pendingZones: 0 },
      { id: 'tsunami', ok: true, stale: false, count: 0 },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createWeatherWarningsSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/weather-warnings']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createWeatherWarningsSource({
    fetchImpl: async () =>
      Response.json({ error: 'weather_warnings_unavailable' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Weather & Tsunami Warnings HTTP 502',
    status: 502,
    retryable: true,
  });
});

test('a body that breaks the layer contract is refused', async () => {
  for (const payload of [
    { type: 'FeatureCollection', features: [] },
    { ...body, features: [{ ...body.features[0], id: undefined }] },
    {
      ...body,
      // An open polygon ring.
      features: [
        {
          ...body.features[0],
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
              ],
            ],
          },
        },
      ],
    },
    {
      ...body,
      features: [
        {
          ...body.features[0],
          properties: { ...body.features[0].properties, layer: 'other' },
        },
      ],
    },
    { error: 'nope' },
  ]) {
    const source = createWeatherWarningsSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Weather & Tsunami Warnings response',
    });
  }
  const garbage = createWeatherWarningsSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Weather & Tsunami Warnings response',
  });
});

test('an oversized body is refused by the 8 MiB cap', async () => {
  const source = createWeatherWarningsSource({
    fetchImpl: async () =>
      new Response('{}', {
        headers: { 'Content-Length': String(9 * 1024 * 1024) },
      }),
  });
  await assert.rejects(source.getSnapshot(), { code: 'RESPONSE_TOO_LARGE' });
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createWeatherWarningsSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
