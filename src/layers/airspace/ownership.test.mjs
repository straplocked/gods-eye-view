import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createAirspaceLayer } from './index.js';
import {
  buildDelayFeatures,
  normalizeAirportLookup,
  normalizeFaaStatus,
  normalizeTfrDetail,
  normalizeTfrList,
  tfrExpired,
} from './records.js';
import {
  AWC_AIRPORTS,
  FAA_STATUS_XML,
  NOW_MS,
  TFR_DETAILS,
  TFR_LIST,
} from '../../testSupport/airspaceFixtures.mjs';

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
  const layer = createAirspaceLayer({
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
const stamp = (features, source) =>
  features.map((feature) => ({
    ...feature,
    id: `${source}:${feature.id}`,
    properties: { ...feature.properties, layer: 'airspace', source },
  }));
const entries = normalizeTfrList(TFR_LIST);
const tfrs = stamp(
  entries
    .flatMap(
      (entry) => normalizeTfrDetail(TFR_DETAILS[entry.notamId], entry).features,
    )
    .filter(({ properties }) => !tfrExpired(properties, NOW_MS)),
  'tfr',
);
const faaIds = {
  KEWR: 'EWR',
  KJFK: 'JFK',
  KORD: 'ORD',
  KASE: 'ASE',
  PHNL: 'HNL',
};
const delays = stamp(
  buildDelayFeatures(
    normalizeFaaStatus(FAA_STATUS_XML, { nowMs: NOW_MS }),
    new Map(
      normalizeAirportLookup(Object.values(AWC_AIRPORTS))
        .filter(({ icao }) => faaIds[icao])
        .map((place) => [faaIds[place.icao], place]),
    ),
  ).features,
  'delays',
);
const all = [...tfrs, ...delays];

const metadata = (overrides = {}) => ({
  layer: 'airspace',
  fetchedAt: '2026-10-25T11:00:00.000Z',
  stale: false,
  partial: Object.values(overrides).some((entry) => entry.ok === false),
  sources: ['tfr', 'delays'].map((id) => ({
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

test('fixtures: seven live TFR areas (one expired, one without geometry dropped) and five airports', () => {
  assert.equal(tfrs.length, 7);
  assert.equal(delays.length, 5);
});

test('TFRs are filled areas with outlines, delays are unclamped dots; only the dots are pick-owned', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 7 + 5);
  const ewr = entities.find((e) => e.id === 'airspace:delays:EWR:0');
  assert.ok(ewr.point, 'delay point missing');
  assert.equal(
    ewr.point.heightReference.getValue(),
    Cesium.HeightReference.NONE,
  );
  // EWR's only program is a ground delay program: orange, 12 px.
  assert.equal(ewr.point.color.getValue().toCssHexString(), '#ff9100');
  assert.equal(ewr.point.pixelSize.getValue(), 12);
  const jfk = entities.find((e) => e.id === 'airspace:delays:JFK:0');
  assert.equal(jfk.point.color.getValue().toCssHexString(), '#ff1744');
  assert.equal(jfk.point.pixelSize.getValue(), 13);
  const area = entities.find((e) => e.id === 'airspace:tfr:6/2117#1:0');
  assert.ok(area.polygon && area.polyline, 'TFR fill and outline');
  assert.equal(area.point, undefined);
  const owns = h.owners.get('airspace');
  assert.equal(owns('airspace:delays:EWR:0'), true);
  assert.equal(owns(area.id), false);
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

test('clicking an airport shows its delay card, the card opens the NAS Status page, empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'airspace:delays:JFK:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('airspace');
  assert.equal(card.id, 'airspace-card:delays:JFK');
  assert.equal(card.title, 'JFK · Ground stop');
  assert.equal(card.accent, '#ff1744');
  assert.equal(card.interactive, true);
  assert.ok(
    card.details.includes('Ground stop until 3:15 pm EDT · low ceilings & fog'),
  );
  const { x, y, z } = card.position;
  assert.ok(Math.hypot(x, y, z) > 6_000_000);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, ['https://nasstatus.faa.gov/']);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('airspace').length, 1);
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('airspace'), []);
});

test('clicking a TFR area shows its card over the polygon and opens the FAA TFR page', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'airspace:tfr:6/0100#1:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('airspace');
  assert.equal(card.title, 'TFR 6/0100 · Security');
  assert.equal(card.accent, '#ff9100');
  // Anchored at the circle's center (26.07N, 97.16W), not elsewhere.
  const { longitude, latitude } = Cesium.Cartographic.fromCartesian(
    card.position,
  );
  assert.ok(Math.abs(Cesium.Math.toDegrees(longitude) + 97.16361) < 0.01);
  assert.ok(Math.abs(Cesium.Math.toDegrees(latitude) - 26.07194) < 0.01);
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, ['https://tfr.faa.gov/tfr3/?page=detail_6_0100']);
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
      ['source-tfr', 'TFRs', true],
      ['source-delays', 'Airport delays', true],
    ],
  );
  assert.match(chips()[0].title, /TFRs: 7 loaded/);
  const labels = () =>
    h.layer.getRowControls().legend.map(({ label }) => label);
  assert.ok(labels().includes('Ground stop'));
  assert.ok(labels().includes('Security'));
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 7);
  assert.equal(labels().includes('Ground stop'), false);
  assert.equal(labels().includes('Security'), true);
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 12);
  chips()[0].onClick();
  assert.equal(h.layer.getStats().count, 5);
  assert.equal(labels().includes('Security'), false);
  assert.equal(labels().includes('Ground stop'), true);
  chips()[1].onClick();
  assert.equal(h.layer.getStats().count, 0);
  assert.deepEqual(labels(), []);
  assert.equal(fetches, 1);
});

test('a feed that failed is named in the status; the rest stays drawn', async () => {
  const h = harness({
    getSnapshot: async () =>
      snapshot(
        all.filter((entry) => entry.properties.source !== 'delays'),
        metadata({ delays: { ok: false, count: 0, error: 'timeout' } }),
      ),
  });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'Airport delays feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
  assert.equal(h.layer.getStats().count, 7);
});

test('a failed refresh keeps the displayed map and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Airspace HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 12);
  assert.equal(h.layer.getStats().error, 'Airspace HTTP 502');
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
  const ewr = records.find((record) => record.id === 'delays:EWR');
  assert.deepEqual(ewr, { id: 'delays:EWR', lat: 40.6925, lon: -74.1687 });
  assert.equal(h.layer.getAnalystRecords(3).length, 3);
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
