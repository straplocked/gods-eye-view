import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createNewsEventsLayer } from './index.js';
import { normalizeGkg } from './records.js';
import {
  BATCH,
  NOW_MS,
  batchCsv,
} from '../../testSupport/newsEventsFixtures.mjs';

function harness(source, { pick = () => null, cardHit = () => null } = {}) {
  const sources = [];
  const overlay = { entries: new Map(), visible: null };
  const clicks = { handler: null, destroyed: 0 };
  const owners = new Map();
  const opened = [];
  const viewer = {
    scene: { pick },
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createNewsEventsLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        overlay.entries.set(sourceId, entries);
      },
      setVisible(sourceId, visible) {
        overlay.visible = visible;
      },
      clearSource(sourceId) {
        overlay.entries.delete(sourceId);
      },
      hitTest: (x, y, options) => cardHit(x, y, options),
    },
    screenSpaceEventHandlerFactory: () => ({
      setInputAction(callback) {
        clicks.handler = callback;
      },
      destroy() {
        clicks.destroyed += 1;
        clicks.handler = null;
      },
    }),
    picking: {
      resolvePickId: (picked) => picked?.id ?? null,
      isOwnedByOtherLayer: (layerId, pickedId) =>
        String(pickedId).startsWith('other-layer:'),
      registerPickOwner: (layerId, predicate) => owners.set(layerId, predicate),
      unregisterPickOwner: (layerId) => owners.delete(layerId),
    },
    pointer: { isPointerFree: () => true },
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, overlay, clicks, owners, opened };
}

// Real normalizer output for the hand-written batch, stamped the way the
// proxy stamps it.
const all = normalizeGkg(batchCsv(), {
  nowMs: NOW_MS,
  batch: BATCH,
}).features.map((feature) => ({
  ...feature,
  id: `gdelt:${feature.id}`,
  properties: { ...feature.properties, layer: 'news-events', source: 'gdelt' },
}));

const metadata = (overrides = {}) => ({
  layer: 'news-events',
  fetchedAt: '2026-10-25T09:00:00.000Z',
  stale: false,
  partial: overrides.ok === false,
  sources: [
    {
      id: 'gdelt',
      ok: true,
      stale: false,
      count: all.length,
      batch: '2026-10-25T08:45:00.000Z',
      records: 6,
      locations: all.length,
      ...overrides,
    },
  ],
});
const snapshot = (features = all, meta = metadata()) => ({
  features,
  metadata: meta,
});
const entityOf = (h, id) =>
  h.sources[0].entities.values.find((e) => e.id === `news-events:${id}:0`);

test('every place is an unclamped, pick-owned point sized and colored by its data', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 5);
  assert.ok(entities.every((entity) => entity.point && !entity.polygon));
  const lucknow = entityOf(h, 'gdelt:-2102835');
  assert.equal(
    lucknow.point.heightReference.getValue(),
    Cesium.HeightReference.NONE,
  );
  // Two articles, one on conflict: red and a little bigger than a single one.
  assert.equal(lucknow.point.pixelSize.getValue(), 7);
  assert.equal(lucknow.point.color.getValue().toCssHexString(), '#ff5252');
  assert.equal(
    entityOf(h, 'gdelt:-2089956').point.color.getValue().toCssHexString(),
    '#4fc3f7',
  );
  assert.equal(entityOf(h, 'gdelt:-2089956').point.pixelSize.getValue(), 5);
  // A country mention has a white ring.
  assert.equal(
    entityOf(h, 'gdelt:BR').point.outlineColor.getValue().toCssHexString(),
    '#ffffff',
  );
  const owns = h.owners.get('news-events');
  assert.equal(owns(lucknow.id), true);
  assert.equal(owns('other-layer:plane'), false);
  assert.equal(h.layer.getStats().count, 5);
});

test('late refresh cannot publish after disable, re-enable, or destroy', async () => {
  for (const action of ['disable', 'destroy']) {
    let resolve, signal;
    const h = harness({
      getSnapshot(options) {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    });
    const pending = h.layer.update(h.viewer);
    h.layer[action](h.viewer);
    assert.equal(signal.aborted, true);
    if (action === 'disable') h.layer.enable(h.viewer);
    resolve(snapshot());
    assert.equal(await pending, false);
    assert.equal(h.layer.getStats().count, 0);
    h.layer.destroy(h.viewer);
  }
});

test('two displays own separate data sources and destruction', async () => {
  const a = harness({ getSnapshot: async () => snapshot() });
  const b = harness({ getSnapshot: async () => snapshot([]) });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 5);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  assert.equal(a.clicks.destroyed, 1);
  b.layer.destroy();
});

test('layer identity and refresh cadence', () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(h.layer.id, 'news-events');
  assert.equal(h.layer.name, 'Geolocated News (GDELT)');
  assert.equal(h.layer.source, 'GDELT');
  assert.equal(h.layer.updateInterval, 15 * 60_000);
});

test('clicking a place shows its card, the card opens the newest https article, empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'news-events:gdelt:-2102835:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('news-events');
  assert.equal(card.id, 'news-events-card:gdelt:-2102835');
  assert.equal(card.title, 'Lucknow, Uttar Pradesh, India');
  assert.equal(card.accent, '#ff5252');
  assert.equal(card.interactive, true);
  assert.deepEqual(card.details.slice(0, 3), [
    '2 articles · Average tone -3.4',
    '1 article on conflict or unrest',
    'Themes: Armed conflict, Election, Killings, Protest',
  ]);
  const { x, y, z } = card.position;
  assert.ok(Math.hypot(x, y, z) > 6_000_000);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  // The newest article is http only: the click opens the newest https one.
  assert.deepEqual(h.opened, ['https://example-daily.com/politics/poster-war']);
  cardHit = null;
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('news-events').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('news-events'), []);
});

test('a place with no https article has a card that is not clickable', async () => {
  let picked = null;
  const only = all
    .filter((f) => f.id === 'gdelt:-1044367')
    .map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        articles: f.properties.articles.map((a) => ({ ...a, url: null })),
      },
    }));
  const h = harness(
    { getSnapshot: async () => snapshot(only) },
    { pick: () => picked },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'news-events:gdelt:-1044367:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('news-events');
  assert.equal(card.interactive, false);
  assert.equal(h.opened.length, 0);
});

test('the legend follows what is drawn; the row shows the batch age; one feed has no chip', async () => {
  let fetches = 0;
  const h = harness({
    getSnapshot: async () => {
      fetches++;
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  const controls = h.layer.getRowControls();
  assert.deepEqual(controls.chips, []);
  assert.deepEqual(
    controls.legend.map(({ label, count }) => [label, count]),
    [
      ['Conflict, unrest or terror reports', 2],
      ['Other news', 3],
    ],
  );
  assert.match(controls.info, /^GDELT batch from .+ ago$/);
  assert.equal(fetches, 1);
});

test('the feed that failed is named in the status', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot([], metadata({ ok: false, count: 0, error: 'timeout' })),
  });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'GDELT feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
});

test('a failed refresh keeps the displayed map and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Geolocated News (GDELT) HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 5);
  assert.equal(h.layer.getStats().error, 'Geolocated News (GDELT) HTTP 502');
});

test('an unchanged snapshot keeps its entities; a changed one swaps them', async () => {
  let current = snapshot();
  const h = harness({ getSnapshot: async () => current });
  await h.layer.update(h.viewer);
  const before = h.sources[0].entities.values[0];
  await h.layer.update(h.viewer);
  assert.equal(h.sources[0].entities.values[0], before);
  current = snapshot(all.slice(0, 2));
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().count, 2);
});
