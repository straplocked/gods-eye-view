import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpaceWeatherSource } from './source.js';

const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'aurora:north-20-1',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-10.5, 64.5],
            [-8.5, 64.5],
            [-8.5, 65.5],
            [-10.5, 65.5],
            [-10.5, 64.5],
          ],
        ],
      },
      properties: {
        layer: 'space-weather',
        source: 'aurora',
        hemisphere: 'north',
        band: 20,
        bandMax: 40,
        probability: 27,
        cells: 2,
        timestamp: '2026-10-25T08:38:00.000Z',
      },
    },
  ],
  metadata: {
    layer: 'space-weather',
    fetchedAt: '2026-10-25T08:40:00.000Z',
    stale: false,
    partial: false,
    sources: [
      { id: 'aurora', ok: true, stale: false, count: 1 },
      { id: 'kp', ok: true, stale: false, count: 0, kp: 7.33, gScale: 3 },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createSpaceWeatherSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/space-weather']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
});

test('a quiet sky (no features) with its metadata is a valid snapshot', async () => {
  const source = createSpaceWeatherSource({
    fetchImpl: async () => Response.json({ ...body, features: [] }),
  });
  const snapshot = await source.getSnapshot();
  assert.deepEqual(snapshot.features, []);
  assert.equal(snapshot.metadata.sources[1].kp, 7.33);
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createSpaceWeatherSource({
    fetchImpl: async () =>
      Response.json({ error: 'space_weather_unavailable' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Aurora & Space Weather HTTP 502',
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
      features: [
        {
          ...body.features[0],
          geometry: { type: 'Point', coordinates: [350, 65] },
        },
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
            coordinates: [
              [
                [-10.5, 64.5],
                [-8.5, 64.5],
                [-8.5, 65.5],
                [-10.5, 65.5],
              ],
            ],
          },
        },
      ],
    },
    { error: 'nope' },
  ]) {
    const source = createSpaceWeatherSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Aurora & Space Weather response',
    });
  }
  const garbage = createSpaceWeatherSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Aurora & Space Weather response',
  });
});

test('a body over the 2 MiB cap is refused', async () => {
  const source = createSpaceWeatherSource({
    fetchImpl: async () =>
      new Response('{}', {
        headers: { 'Content-Length': String(3 * 1024 * 1024) },
      }),
  });
  await assert.rejects(source.getSnapshot(), { code: 'RESPONSE_TOO_LARGE' });
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createSpaceWeatherSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
