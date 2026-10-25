import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createAviationWeatherLayer } from './index.js';
import { normalizeMetars, normalizeSigmets } from './records.js';
import {
  GOOD_METAR_ROWS,
  NOW_MS,
  internationalPayload,
  metarCsv,
  usPayload,
} from '../../testSupport/aviationWeatherFixtures.mjs';

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
  const layer = createAviationWeatherLayer({
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
      layer: 'aviation-weather',
      source,
    },
  }));
const metars = stamp(
  normalizeMetars(metarCsv(...GOOD_METAR_ROWS), { nowMs: NOW_MS }),
  'metar',
);
const sigmets = stamp(
  normalizeSigmets(usPayload, { kind: 'us', nowMs: NOW_MS }),
  'sigmet',
);
const isigmets = stamp(
  normalizeSigmets(internationalPayload, {
    kind: 'international',
    nowMs: NOW_MS,
  }),
  'isigmet',
);
const all = [...metars, ...sigmets, ...isigmets];
const feature = (id) => all.find((entry) => entry.id === id);

const metadata = (overrides = {}) => ({
  layer: 'aviation-weather',
  fetchedAt: '2026-10-25T11:00:00.000Z',
  stale: false,
  partial: Object.values(overrides).some((entry) => entry.ok === false),
  sources: ['metar', 'sigmet', 'isigmet'].map((id) => ({
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

test('METARs are unclamped points, advisories are fills with outlines; only points are pick-owned', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 7 + 2 + 2);
  const ksea = entities.find((e) => e.id === 'aviation-weather:metar:KSEA:0');
  assert.ok(ksea.point, 'METAR point missing');
  // Thousands of points: on the ellipsoid, not tracking terrain.
  assert.equal(
    ksea.point.heightReference.getValue(),
    Cesium.HeightReference.NONE,
  );
  assert.equal(ksea.point.pixelSize.getValue(), 5);
  const kcag = entities.find((e) => e.id === 'aviation-weather:metar:KCAG:0');
  assert.equal(kcag.point.pixelSize.getValue(), 8);
  assert.equal(kcag.point.color.getValue().toCssHexString(), '#ff3b30');
  const area = entities.find((e) =>
    e.id.startsWith('aviation-weather:isigmet:sigmet-MMMD'),
  );
  assert.ok(area.polygon && area.polyline, 'advisory fill and outline');
  assert.equal(area.point, undefined);
  const owns = h.owners.get('aviation-weather');
  assert.equal(owns('aviation-weather:metar:KSEA:0'), true);
  assert.equal(owns(area.id), false);
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

test('clicking a station shows its METAR card, the card opens the AWC page, empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'aviation-weather:metar:LFPG:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('aviation-weather');
  assert.equal(card.id, 'aviation-weather-card:metar:LFPG');
  // The CSV left the category out: the card shows the derived IFR.
  assert.equal(card.title, 'LFPG · IFR');
  assert.equal(card.accent, '#ff3b30');
  assert.equal(card.interactive, true);
  const { x, y, z } = card.position;
  assert.ok(Math.hypot(x, y, z) > 6_000_000);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, [
    'https://aviationweather.gov/data/metar/?ids=LFPG',
  ]);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('aviation-weather').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('aviation-weather'), []);
});

test('clicking an advisory area shows its card over the polygon and opens the SIGMET page', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  const id = 'isigmet:sigmet-NZKL-18-VA-202610251000';
  picked = { id: `aviation-weather:${id}:0` };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('aviation-weather');
  assert.equal(card.title, 'Volcanic ash · FUEGO');
  assert.equal(card.accent, '#a1887f');
  // Anchored near the polygon's vertex mean (around -170, -50), not at lon 180+.
  const { longitude, latitude } = Cesium.Cartographic.fromCartesian(
    card.position,
  );
  const lon = Cesium.Math.toDegrees(longitude);
  assert.ok(lon > -180 && lon < -150, `lon ${lon}`);
  assert.ok(Cesium.Math.toDegrees(latitude) < -45);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, ['https://aviationweather.gov/sigmet/']);
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
      ['source-metar', 'METAR', true],
      ['source-sigmet', 'US SIGMET', true],
      ['source-isigmet', 'Intl SIGMET', true],
    ],
  );
  assert.match(chips()[0].title, /METAR: 7 loaded/);
  const labels = () =>
    h.layer.getRowControls().legend.map(({ label }) => label);
  assert.ok(labels().includes('Convective thunderstorms'));
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 9);
  assert.equal(labels().includes('Convective thunderstorms'), false);
  assert.equal(labels().includes('Turbulence'), true);
  chips()[0].onClick();
  assert.equal(h.layer.getStats().count, 2);
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
        all.filter((entry) => entry.properties.source !== 'isigmet'),
        metadata({
          isigmet: { ok: false, count: 0, error: 'timeout' },
        }),
      ),
  });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'Intl SIGMET feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
  assert.equal(h.layer.getStats().count, 9);
});

test('a failed refresh keeps the displayed map and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Aviation Weather HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 11);
  assert.equal(h.layer.getStats().error, 'Aviation Weather HTTP 502');
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
  const ksea = records.find((record) => record.id === 'metar:KSEA');
  assert.deepEqual(ksea, { id: 'metar:KSEA', lat: 47.4444, lon: -122.3138 });
  assert.equal(h.layer.getAnalystRecords(3).length, 3);
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
