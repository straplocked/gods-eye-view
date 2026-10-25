import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createInternetInfrastructureLayer } from './index.js';
import { normalizeFacilities, normalizeOutages } from './records.js';
import {
  NOW_MS,
  countryPayload,
  facilityPayload,
  regionPayload,
} from '../../testSupport/internetInfrastructureFixtures.mjs';

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
  const layer = createInternetInfrastructureLayer({
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
// proxy stamps it, data centers first as the route lists them.
const stamp = (collection, source) =>
  collection.features.map((feature) => ({
    ...feature,
    id: `${source}:${feature.id}`,
    properties: {
      ...feature.properties,
      layer: 'internet-infrastructure',
      source,
    },
  }));
const datacenters = stamp(
  normalizeFacilities(facilityPayload()),
  'datacenters',
);
const outages = stamp(
  normalizeOutages(
    { country: countryPayload(), regions: regionPayload() },
    { nowMs: NOW_MS },
  ),
  'outages',
);
const all = [...datacenters, ...outages];

const metadata = (overrides = {}) => ({
  layer: 'internet-infrastructure',
  fetchedAt: '2026-10-25T11:00:00.000Z',
  stale: false,
  partial: Object.values(overrides).some((entry) => entry.ok === false),
  sources: ['datacenters', 'outages'].map((id) => ({
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
const entityOf = (h, id) =>
  h.sources[0].entities.values.find(
    (e) => e.id === `internet-infrastructure:${id}:0`,
  );

test('every feature is an unclamped, pick-owned point sized and colored by its data', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 5 + 7);
  assert.ok(entities.every((entity) => entity.point && !entity.polygon));
  const timor = entityOf(h, 'outages:TL');
  // Thousands of facility points: on the ellipsoid, not tracking terrain.
  assert.equal(
    timor.point.heightReference.getValue(),
    Cesium.HeightReference.NONE,
  );
  assert.equal(timor.point.pixelSize.getValue(), 14);
  assert.equal(timor.point.color.getValue().toCssHexString(), '#f44336');
  assert.equal(timor.point.outlineColor.getValue().toCssHexString(), '#ffffff');
  // Only regions are down in Nigeria: smaller. Cameroon is a warning.
  assert.equal(entityOf(h, 'outages:NG').point.pixelSize.getValue(), 11);
  assert.equal(
    entityOf(h, 'outages:CM').point.color.getValue().toCssHexString(),
    '#ff9800',
  );
  const recovered = entityOf(h, 'outages:DK');
  assert.equal(recovered.point.color.getValue().toCssHexString(), '#66bb6a');
  assert.equal(
    recovered.point.outlineColor.getValue().toCssHexString(),
    '#000000',
  );
  const hub = entityOf(h, 'datacenters:1');
  assert.equal(hub.point.pixelSize.getValue(), 8);
  assert.equal(hub.point.color.getValue().toCssHexString(), '#26c6da');
  assert.equal(entityOf(h, 'datacenters:4').point.pixelSize.getValue(), 4);
  const owns = h.owners.get('internet-infrastructure');
  assert.equal(owns(timor.id), true);
  assert.equal(owns(hub.id), true);
  assert.equal(owns('other-layer:plane'), false);
  assert.equal(h.layer.getStats().count, 12);
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
  assert.equal(a.layer.getStats().count, 12);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  assert.equal(a.clicks.destroyed, 1);
  b.layer.destroy();
});

test('layer identity and refresh cadence', () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(h.layer.id, 'internet-infrastructure');
  assert.equal(h.layer.name, 'Internet Outages & Data Centers');
  assert.equal(h.layer.source, 'Georgia Tech IODA · PeeringDB');
  assert.equal(h.layer.updateInterval, 10 * 60_000);
});

test('clicking a country marker shows its card, the card opens the IODA page, empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'internet-infrastructure:outages:TL:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('internet-infrastructure');
  assert.equal(card.id, 'internet-infrastructure-card:outages:TL');
  assert.equal(card.title, 'Timor-Leste');
  assert.equal(card.accent, '#f44336');
  assert.equal(card.interactive, true);
  assert.deepEqual(card.details.slice(0, 3), [
    'Critical drop in connectivity',
    'Regions: Baucau, Dili',
    'Detected by BGP routing · Active probing',
  ]);
  // The card sits on the Timor-Leste centroid, on the globe.
  const { x, y, z } = card.position;
  assert.ok(Math.hypot(x, y, z) > 6_000_000);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, [
    'https://ioda.inetintel.cc.gatech.edu/country/TL',
  ]);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('internet-infrastructure').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('internet-infrastructure'), []);
});

test('clicking a data center shows its card and opens the PeeringDB page', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'internet-infrastructure:datacenters:2:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('internet-infrastructure');
  assert.equal(card.title, 'Sample Hosting SYD1');
  assert.equal(card.accent, '#26c6da');
  assert.deepEqual(card.details, [
    'Sample Hosting Ltd · Sydney, AU',
    '44 networks · 2 exchanges',
    'hosting.example',
    'PeeringDB ↗ · click card to open',
  ]);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, ['https://www.peeringdb.com/fac/2']);
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
      ['source-outages', 'Outages', true],
      ['source-datacenters', 'Data centers', true],
    ],
  );
  assert.match(chips()[0].title, /Outages: 7 loaded/);
  assert.match(chips()[1].title, /Data centers: 5 loaded/);
  const labels = () =>
    h.layer.getRowControls().legend.map(({ label }) => label);
  assert.deepEqual(labels(), [
    'Critical outage',
    'Outage warning',
    'Recovered in the last 24 h',
    'Data center or network facility',
  ]);
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 7);
  assert.equal(labels().includes('Data center or network facility'), false);
  assert.equal(labels().includes('Critical outage'), true);
  chips()[0].onClick();
  assert.equal(h.layer.getStats().count, 0);
  assert.deepEqual(h.layer.getRowControls().legend, []);
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 5);
  assert.deepEqual(labels(), ['Data center or network facility']);
  assert.equal(fetches, 1);
});

test('a feed that failed is named in the status; the rest stays drawn', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot(
        all.filter((entry) => entry.properties.source !== 'outages'),
        metadata({ outages: { ok: false, count: 0, error: 'timeout' } }),
      ),
  });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'Outages feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
  assert.equal(h.layer.getStats().count, 5);
});

test('a failed refresh keeps the displayed map and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Internet Outages & Data Centers HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 12);
  assert.equal(
    h.layer.getStats().error,
    'Internet Outages & Data Centers HTTP 502',
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
  assert.equal(records.length, 12);
  const timor = records.find((record) => record.id === 'outages:TL');
  assert.deepEqual(timor, { id: 'outages:TL', lat: -8.8, lon: 125.7 });
  assert.equal(h.layer.getAnalystRecords(3).length, 3);
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
