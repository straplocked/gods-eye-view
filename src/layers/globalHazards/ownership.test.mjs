import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlobalHazardsLayer } from './index.js';

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
  const layer = createGlobalHazardsLayer({
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

const cyclone = {
  type: 'Feature',
  id: 'gdacs:TC-1001338',
  geometry: { type: 'Point', coordinates: [141.2, 27.6] },
  properties: {
    layer: 'global-hazards',
    source: 'gdacs',
    hazard: 'cyclone',
    eventtype: 'TC',
    alertlevel: 'red',
    name: 'Tropical Cyclone CHAMPI-26',
    country: 'Japan',
    fromdate: '2026-10-14T12:00:00.000Z',
    todate: '2026-10-23T00:00:00.000Z',
    severity: 'Hurricane/Typhoon > 74 mph (maximum wind speed of 296 km/h)',
    url: 'https://www.gdacs.org/report.aspx?eventid=1001338&episodeid=35&eventtype=TC',
    timestamp: '2026-10-23T00:00:00.000Z',
  },
};
const plume = {
  type: 'Feature',
  id: 'eonet:EONET_9001',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [123.0, 10.3],
        [123.3, 10.3],
        [123.3, 10.6],
        [123.0, 10.3],
      ],
    ],
  },
  properties: {
    layer: 'global-hazards',
    source: 'eonet',
    hazard: 'volcano',
    alertlevel: null,
    name: 'Ash plume, Kanlaon Volcano',
    url: 'https://volcano.si.edu/',
    timestamp: '2026-10-20T00:00:00.000Z',
  },
};
const metadata = (sources = []) => ({
  layer: 'global-hazards',
  fetchedAt: '2026-10-25T08:00:00.000Z',
  stale: false,
  partial: sources.some((entry) => !entry.ok),
  sources,
});
const snapshot = (features = [cyclone, plume], sources) => ({
  features,
  metadata: metadata(
    sources ?? [
      { id: 'gdacs', ok: true, stale: false, count: 1 },
      { id: 'eonet', ok: true, stale: false, count: 1 },
    ],
  ),
});

test('points render as clamped points and polygons as filled areas with an outline', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.deepEqual(
    entities.map((entity) => entity.id),
    ['global-hazards:gdacs:TC-1001338:0', 'global-hazards:eonet:EONET_9001:0'],
  );
  assert.ok(entities[0].point, 'hazard point missing');
  assert.ok(entities[1].polygon, 'hazard area missing');
  assert.ok(entities[1].polyline, 'hazard area outline missing');
  assert.equal(h.layer.getStats().count, 2);
  // Only points are claimed in the pick registry.
  const owns = h.owners.get('global-hazards');
  assert.equal(owns('global-hazards:gdacs:TC-1001338:0'), true);
  assert.equal(owns('global-hazards:eonet:EONET_9001:0'), false);
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
  assert.equal(a.layer.getStats().count, 2);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  assert.equal(a.clicks.destroyed, 1);
  b.layer.destroy();
});

test('clicking a hazard shows its card; the card opens the report; empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'global-hazards:gdacs:TC-1001338:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('global-hazards');
  assert.equal(card.id, 'global-hazards-card:gdacs:TC-1001338');
  assert.equal(card.title, 'Tropical Cyclone CHAMPI-26');
  assert.equal(card.details[0], 'Tropical cyclone · Red alert');
  assert.equal(card.details[1], 'Japan');
  assert.equal(card.accent, '#e53935');
  assert.equal(card.interactive, true);
  assert.ok(card.position, 'card has no world position');
  assert.equal(card.details.at(-1), 'GDACS ↗ · click card to open');
  // A click on the card itself opens the GDACS report.
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, [cyclone.properties.url]);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('global-hazards').length, 1);
  // Empty space clears it.
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('global-hazards'), []);
});

test('polygon picks select their event too', async () => {
  let picked = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'global-hazards:eonet:EONET_9001:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('global-hazards');
  assert.equal(card.title, 'Ash plume, Kanlaon Volcano');
  assert.equal(card.details[0], 'Volcano');
  assert.equal(card.details.at(-1), 'NASA EONET ↗ · click card to open');
});

test('feed chips hide and show a subsource without refetching', async () => {
  let fetches = 0;
  let notified = 0;
  const h = harness({
    getSnapshot: async () => {
      fetches++;
      return snapshot();
    },
  });
  h.layer.setRowControlsListener(() => notified++);
  await h.layer.update(h.viewer);
  const chips = () => h.layer.getRowControls().chips;
  assert.deepEqual(
    chips().map(({ id, label, active }) => [id, label, active]),
    [
      ['source-gdacs', 'GDACS', true],
      ['source-eonet', 'NASA EONET', true],
    ],
  );
  chips()[0].onClick();
  assert.equal(chips()[0].active, false);
  assert.deepEqual(
    h.sources[0].entities.values.map((entity) => entity.id),
    ['global-hazards:eonet:EONET_9001:0'],
  );
  assert.equal(h.layer.getStats().count, 1);
  assert.deepEqual(
    h.layer.getRowControls().legend.map(({ label, count }) => [label, count]),
    [['Volcano', 1]],
  );
  chips()[0].onClick();
  assert.equal(h.sources[0].entities.values.length, 2);
  assert.equal(fetches, 1);
  assert.ok(notified >= 3);
});

test('a partial snapshot reports the missing feed; an unchanged one is not rebuilt', async () => {
  let current = snapshot(
    [plume],
    [
      { id: 'gdacs', ok: false, stale: false, count: 0, error: 'timeout' },
      { id: 'eonet', ok: true, stale: false, count: 1 },
    ],
  );
  const h = harness({ getSnapshot: async () => current });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'GDACS feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
  const before = h.sources[0].entities.values[0];
  current = snapshot([plume]);
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.sources[0].entities.values[0], before);
});

test('a failed refresh keeps the displayed hazards and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Global Hazards HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().error, 'Global Hazards HTTP 502');
});

test('analyst records carry hazard facts at the card anchor', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  await h.layer.update(h.viewer);
  const [first, second] = h.layer.getAnalystRecords();
  assert.deepEqual(first, {
    id: 'gdacs:TC-1001338',
    lat: 27.6,
    lon: 141.2,
    hazard: 'cyclone',
    alertLevel: 'red',
    name: 'Tropical Cyclone CHAMPI-26',
    country: 'Japan',
    source: 'gdacs',
    timeMs: Date.parse('2026-10-23T00:00:00.000Z'),
  });
  assert.equal(second.hazard, 'volcano');
  assert.ok(Math.abs(second.lat - 10.4) < 1e-9);
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
