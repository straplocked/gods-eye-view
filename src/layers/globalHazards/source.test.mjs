import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlobalHazardsSource } from './source.js';

const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'gdacs:EQ-1573748',
      geometry: { type: 'Point', coordinates: [-165.019, 53.44] },
      properties: {
        layer: 'global-hazards',
        source: 'gdacs',
        hazard: 'earthquake',
        timestamp: '2026-10-25T07:45:45.000Z',
      },
    },
  ],
  metadata: {
    layer: 'global-hazards',
    fetchedAt: '2026-10-25T08:00:00.000Z',
    stale: false,
    partial: false,
    sources: [{ id: 'gdacs', ok: true, stale: false, count: 1 }],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createGlobalHazardsSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/global-hazards']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createGlobalHazardsSource({
    fetchImpl: async () =>
      Response.json({ error: 'global_hazards_unavailable' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Global Hazards HTTP 502',
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
    const source = createGlobalHazardsSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Global Hazards response',
    });
  }
  const garbage = createGlobalHazardsSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Global Hazards response',
  });
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createGlobalHazardsSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
