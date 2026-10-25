import assert from 'node:assert/strict';
import test from 'node:test';
import { createVolcanoesSource } from './source.js';

const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'volcano:332010',
      geometry: { type: 'Point', coordinates: [-155.287, 19.421] },
      properties: {
        layer: 'volcanoes',
        source: 'gvp+usgs',
        name: 'Kilauea',
        vnum: 332010,
        alertLevel: 'ADVISORY',
        colorCode: 'YELLOW',
        timestamp: '2026-10-24T18:15:36.000Z',
      },
    },
  ],
  metadata: {
    layer: 'volcanoes',
    fetchedAt: '2026-10-25T08:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      { id: 'gvp', ok: true, stale: false, count: 1 },
      { id: 'usgs', ok: true, stale: false, count: 1 },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createVolcanoesSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/volcanoes']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createVolcanoesSource({
    fetchImpl: async () =>
      Response.json({ error: 'volcanoes_unavailable' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Volcanoes HTTP 502',
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
          geometry: { type: 'Point', coordinates: [0, 91] },
        },
      ],
    },
    { error: 'nope' },
  ]) {
    const source = createVolcanoesSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Volcanoes response',
    });
  }
  const garbage = createVolcanoesSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Volcanoes response',
  });
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createVolcanoesSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
