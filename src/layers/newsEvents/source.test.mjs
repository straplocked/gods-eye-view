import assert from 'node:assert/strict';
import test from 'node:test';
import { createNewsEventsSource } from './source.js';

const body = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 'gdelt:-1044367',
      geometry: { type: 'Point', coordinates: [30.5167, 50.4333] },
      properties: {
        layer: 'news-events',
        source: 'gdelt',
        name: "Kyiv, Kyyivs'ka Oblast', Ukraine",
        articleCount: 3,
        tone: null,
        conflict: true,
        articles: [
          {
            url: null,
            source: 'wire.example',
            title: null,
            tone: null,
            date: '2026-10-25T08:15:00.000Z',
          },
        ],
        timestamp: '2026-10-25T08:15:00.000Z',
      },
    },
  ],
  metadata: {
    layer: 'news-events',
    fetchedAt: '2026-10-25T09:00:00.000Z',
    stale: false,
    partial: false,
    sources: [
      {
        id: 'gdelt',
        ok: true,
        stale: false,
        count: 1,
        truncated: false,
        batch: '2026-10-25T08:45:00.000Z',
        records: 6,
        locations: 1,
      },
    ],
  },
};

test('requests the same-origin keyless route and returns features with metadata', async () => {
  const urls = [];
  const source = createNewsEventsSource({
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(body);
    },
  });
  const snapshot = await source.getSnapshot({
    signal: new AbortController().signal,
  });
  assert.deepEqual(urls, ['/api/v1/layers/news-events']);
  assert.deepEqual(snapshot, {
    features: body.features,
    metadata: body.metadata,
  });
  // Nulls survive the round trip.
  assert.equal(snapshot.features[0].properties.tone, null);
  assert.equal(snapshot.features[0].properties.articles[0].url, null);
});

test('a snapshot with no features is valid', async () => {
  const source = createNewsEventsSource({
    fetchImpl: async () => Response.json({ ...body, features: [] }),
  });
  assert.deepEqual((await source.getSnapshot()).features, []);
});

test('HTTP failures carry a status the Layers panel can translate', async () => {
  const source = createNewsEventsSource({
    fetchImpl: async () =>
      Response.json({ error: 'news_events_unavailable' }, { status: 502 }),
  });
  await assert.rejects(source.getSnapshot(), {
    message: 'Geolocated News (GDELT) HTTP 502',
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
        { ...first, geometry: { type: 'Point', coordinates: [30, 95] } },
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
    const source = createNewsEventsSource({
      fetchImpl: async () => Response.json(payload),
    });
    await assert.rejects(source.getSnapshot(), {
      message: 'Malformed Geolocated News (GDELT) response',
    });
  }
  const garbage = createNewsEventsSource({
    fetchImpl: async () => new Response('<html>'),
  });
  await assert.rejects(garbage.getSnapshot(), {
    message: 'Malformed Geolocated News (GDELT) response',
  });
});

test('a body over the 8 MiB cap is refused; a 4 MiB one is read', async () => {
  const big = createNewsEventsSource({
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
          note: 'x'.repeat(4 * 1024 * 1024),
        },
      },
    ],
  };
  const ok = createNewsEventsSource({
    fetchImpl: async () => Response.json(padded),
  });
  assert.equal((await ok.getSnapshot()).features.length, 1);
});

test('an aborted request rejects even when the transport ignores the signal', async () => {
  const abort = new AbortController();
  const source = createNewsEventsSource({
    fetchImpl: async () => {
      abort.abort();
      return Response.json(body);
    },
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});
