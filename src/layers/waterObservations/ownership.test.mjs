import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createWaterObservationsLayer } from './index.js';
import {
  NWPS_TILES,
  normalizeBuoys,
  normalizeGauges,
  nwpsTileUrl,
} from './records.js';
import {
  ALL_GAUGES,
  GOOD_BUOY_ROWS,
  NOW_MS,
  ndbcText,
  nwpsTilePayload,
} from '../../testSupport/waterObservationsFixtures.mjs';

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
  const layer = createWaterObservationsLayer({
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

// Real normalizer output for the hand-written fixtures, stamped the way the
// proxy stamps it.
const stamp = (collection, source) =>
  collection.features.map((feature) => ({
    ...feature,
    id: `${source}:${feature.id}`,
    properties: {
      ...feature.properties,
      layer: 'water-observations',
      source,
    },
  }));
const buoys = stamp(
  normalizeBuoys(ndbcText(...GOOD_BUOY_ROWS), { nowMs: NOW_MS }),
  'buoys',
);
const rivers = stamp(
  normalizeGauges(
    NWPS_TILES.map((tile) => nwpsTilePayload(nwpsTileUrl(tile), ALL_GAUGES)),
  ),
  'rivers',
);
const all = [...buoys, ...rivers];

const metadata = (overrides = {}) => ({
  layer: 'water-observations',
  fetchedAt: '2026-10-25T11:00:00.000Z',
  stale: false,
  partial: Object.values(overrides).some((entry) => entry.ok === false),
  sources: ['buoys', 'rivers'].map((id) => ({
    id,
    ok: true,
    stale: false,
    count: all.filter((entry) => entry.properties.source === id).length,
    ...overrides[id],
  })),
});
const snapshot = (features = all, meta = metadata()) => ({
  features,
  metadata: meta,
});

test('every feature is an unclamped, pick-owned point sized and colored by its data', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 5 + 6);
  assert.ok(entities.every((entity) => entity.point && !entity.polygon));
  const find = (id) =>
    entities.find((e) => e.id === `water-observations:${id}:0`);
  const station = find('buoys:41008');
  // Hundreds of points: on the ellipsoid, not tracking terrain.
  assert.equal(
    station.point.heightReference.getValue(),
    Cesium.HeightReference.NONE,
  );
  assert.equal(station.point.pixelSize.getValue(), 6);
  assert.equal(station.point.color.getValue().toCssHexString(), '#1e88e5');
  const alaska = find('rivers:KCFS2');
  assert.equal(alaska.point.pixelSize.getValue(), 12);
  assert.equal(alaska.point.color.getValue().toCssHexString(), '#d500f9');
  assert.equal(
    alaska.point.outlineColor.getValue().toCssHexString(),
    '#ffffff',
  );
  const forecastOnly = find('rivers:HYPO1');
  assert.equal(forecastOnly.point.color.getValue().toCssHexString(), '#ff9800');
  const owns = h.owners.get('water-observations');
  assert.equal(owns(station.id), true);
  assert.equal(owns(alaska.id), true);
  assert.equal(owns('other-layer:plane'), false);
  assert.equal(h.layer.getStats().count, 11);
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
  assert.equal(a.layer.getStats().count, 11);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  assert.equal(a.clicks.destroyed, 1);
  b.layer.destroy();
});

test('layer identity and refresh cadence', () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(h.layer.id, 'water-observations');
  assert.equal(h.layer.name, 'Buoys & River Gauges');
  assert.equal(h.layer.updateInterval, 15 * 60_000);
});

test('clicking a buoy shows its card, the card opens the NDBC page, empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'water-observations:buoys:BURL1:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('water-observations');
  assert.equal(card.id, 'water-observations-card:buoys:BURL1');
  assert.equal(card.title, 'NDBC station BURL1');
  // 21 m/s is 40.8 kt: gale class.
  assert.equal(card.accent, '#5e35b1');
  assert.equal(card.interactive, true);
  const { x, y, z } = card.position;
  assert.ok(Math.hypot(x, y, z) > 6_000_000);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, [
    'https://www.ndbc.noaa.gov/station_page.php?station=BURL1',
  ]);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('water-observations').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('water-observations'), []);
});

test('clicking a river gauge shows its flood card and opens the NWPS page', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'water-observations:rivers:HYPO1:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('water-observations');
  assert.equal(card.title, 'Example Creek at Hypothetical');
  assert.equal(card.accent, '#ff9800');
  assert.deepEqual(card.details.slice(0, 4), [
    'HYPO1 · OH',
    'Now: below action stage',
    'Stage 8.1 ft',
    'Forecast: Minor flooding · Stage 11.2 ft',
  ]);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, ['https://water.noaa.gov/gauges/hypo1']);
});

test('chips hide a feed without refetching; the legend follows what is drawn', async () => {
  let fetches = 0;
  const h = harness({
    getSnapshot: async () => {
      fetches++;
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  const chips = () => h.layer.getRowControls().chips;
  assert.deepEqual(
    chips().map(({ id, label, active }) => [id, label, active]),
    [
      ['source-buoys', 'Buoys', true],
      ['source-rivers', 'River gauges', true],
    ],
  );
  assert.match(chips()[0].title, /Buoys: 5 loaded/);
  assert.match(chips()[1].title, /River gauges: 6 loaded/);
  const labels = () =>
    h.layer.getRowControls().legend.map(({ label }) => label);
  assert.ok(labels().includes('Major flooding'));
  assert.ok(labels().includes('Wind 22–33 kt'));
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 5);
  assert.equal(labels().includes('Major flooding'), false);
  assert.equal(labels().includes('Wind 22–33 kt'), true);
  chips()[0].onClick();
  assert.equal(h.layer.getStats().count, 0);
  assert.deepEqual(h.layer.getRowControls().legend, []);
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 6);
  assert.equal(
    h.layer.getRowControls().legend.every((row) => row.count >= 1),
    true,
  );
  assert.equal(fetches, 1);
});

test('a feed that failed is named in the status; the rest stays drawn', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot(
        all.filter((entry) => entry.properties.source !== 'rivers'),
        metadata({ rivers: { ok: false, count: 0, error: 'timeout' } }),
      ),
  });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'River gauges feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
  assert.equal(h.layer.getStats().count, 5);
});

test('a failed refresh keeps the displayed map and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Buoys & River Gauges HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 11);
  assert.equal(h.layer.getStats().error, 'Buoys & River Gauges HTTP 502');
});

test('an unchanged snapshot keeps its entities; a changed one swaps them', async () => {
  let current = snapshot();
  const h = harness({ getSnapshot: async () => current });
  await h.layer.update(h.viewer);
  const before = h.sources[0].entities.values[0];
  await h.layer.update(h.viewer);
  assert.equal(h.sources[0].entities.values[0], before);
  current = snapshot(all.slice(0, 3));
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().count, 3);
});

test('analyst records are plain positions; none while disabled; the limit applies', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  await h.layer.update(h.viewer);
  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 11);
  const station = records.find((record) => record.id === 'buoys:41008');
  assert.deepEqual(station, { id: 'buoys:41008', lat: 31.4, lon: -80.866 });
  assert.equal(h.layer.getAnalystRecords(3).length, 3);
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
