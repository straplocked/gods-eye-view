import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCitizenSensorsLayer } from './index.js';
import { normalizeAirPm, normalizeRadiation } from './records.js';
import {
  AIR_READINGS,
  NOW_MS,
  RADIATION_ROWS,
} from '../../testSupport/citizenSensorsFixtures.mjs';

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
  const layer = createCitizenSensorsLayer({
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
      layer: 'citizen-sensors',
      source,
    },
  }));
const air = stamp(normalizeAirPm(AIR_READINGS, { nowMs: NOW_MS }), 'airpm');
const radiation = stamp(
  normalizeRadiation(RADIATION_ROWS, { nowMs: NOW_MS }),
  'radiation',
);
const all = [...air, ...radiation];

const metadata = (overrides = {}) => ({
  layer: 'citizen-sensors',
  fetchedAt: '2026-10-25T09:00:00.000Z',
  stale: false,
  partial: Object.values(overrides).some((entry) => entry.ok === false),
  sources: ['airpm', 'radiation'].map((id) => ({
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
  assert.equal(entities.length, 6 + 7);
  assert.ok(entities.every((entity) => entity.point && !entity.polygon));
  const find = (id) => entities.find((e) => e.id === `citizen-sensors:${id}:0`);
  const cell = find('airpm:1891_1385');
  // Thousands of points: on the ellipsoid, not tracking terrain.
  assert.equal(
    cell.point.heightReference.getValue(),
    Cesium.HeightReference.NONE,
  );
  assert.equal(cell.point.pixelSize.getValue(), 7);
  assert.equal(cell.point.color.getValue().toCssHexString(), '#ffff00');
  assert.equal(cell.point.outlineColor.getValue().toCssHexString(), '#000000');
  const smoke = find('airpm:2964_1299');
  assert.equal(smoke.point.pixelSize.getValue(), 6);
  assert.equal(smoke.point.color.getValue().toCssHexString(), '#8f3f97');
  const device = find('radiation:d65002');
  assert.equal(device.point.pixelSize.getValue(), 9);
  assert.equal(device.point.color.getValue().toCssHexString(), '#26c6da');
  assert.equal(
    device.point.outlineColor.getValue().toCssHexString(),
    '#ffffff',
  );
  const owns = h.owners.get('citizen-sensors');
  assert.equal(owns(cell.id), true);
  assert.equal(owns(device.id), true);
  assert.equal(owns('other-layer:plane'), false);
  assert.equal(h.layer.getStats().count, 13);
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
  assert.equal(a.layer.getStats().count, 13);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  assert.equal(a.clicks.destroyed, 1);
  b.layer.destroy();
});

test('layer identity and refresh cadence', () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(h.layer.id, 'citizen-sensors');
  assert.equal(h.layer.name, 'Citizen Air & Radiation Sensors');
  assert.equal(h.layer.updateInterval, 10 * 60_000);
});

test('clicking a PM cell shows its card, the card opens the sensor map, empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'citizen-sensors:airpm:1891_1385:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('citizen-sensors');
  assert.equal(card.id, 'citizen-sensors-card:airpm:1891_1385');
  assert.equal(card.title, 'Air quality: Moderate');
  assert.equal(card.accent, '#ffff00');
  assert.equal(card.interactive, true);
  const { x, y, z } = card.position;
  assert.ok(Math.hypot(x, y, z) > 6_000_000);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, ['https://maps.sensor.community/']);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('citizen-sensors').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('citizen-sensors'), []);
});

test('clicking a radiation reading shows its dose card and opens the Safecast map', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'citizen-sensors:radiation:d65002:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('citizen-sensors');
  assert.equal(card.title, 'Radiation ≈ 0.15 µSv/h');
  assert.equal(card.accent, '#26c6da');
  assert.equal(card.details[0], '50 counts per minute');
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, ['https://map.safecast.org/']);
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
      ['source-airpm', 'Particulate sensors', true],
      ['source-radiation', 'Radiation sensors', true],
    ],
  );
  assert.match(chips()[0].title, /Particulate sensors: 6 loaded/);
  assert.match(chips()[1].title, /Radiation sensors: 7 loaded/);
  const labels = () =>
    h.layer.getRowControls().legend.map(({ label }) => label);
  assert.ok(labels().includes('Air quality: Hazardous'));
  assert.ok(labels().includes('Radiation 1–9.9 µSv/h'));
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 6);
  assert.equal(labels().includes('Radiation 1–9.9 µSv/h'), false);
  assert.equal(labels().includes('Air quality: Hazardous'), true);
  chips()[0].onClick();
  assert.equal(h.layer.getStats().count, 0);
  assert.deepEqual(h.layer.getRowControls().legend, []);
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 7);
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
        all.filter((entry) => entry.properties.source !== 'radiation'),
        metadata({ radiation: { ok: false, count: 0, error: 'timeout' } }),
      ),
  });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'Radiation sensors feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
  assert.equal(h.layer.getStats().count, 6);
});

test('a failed refresh keeps the displayed map and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Citizen Air & Radiation Sensors HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 13);
  assert.equal(
    h.layer.getStats().error,
    'Citizen Air & Radiation Sensors HTTP 502',
  );
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
  assert.equal(records.length, 13);
  const cell = records.find((record) => record.id === 'airpm:1891_1385');
  assert.deepEqual(cell, { id: 'airpm:1891_1385', lat: 48.55, lon: 9.15 });
  assert.equal(h.layer.getAnalystRecords(3).length, 3);
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
