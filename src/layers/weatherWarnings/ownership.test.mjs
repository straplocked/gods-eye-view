import assert from 'node:assert/strict';
import test from 'node:test';
import { createWeatherWarningsLayer } from './index.js';

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
  const layer = createWeatherWarningsLayer({
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

const flood = {
  type: 'Feature',
  id: 'nws:urn:oid:2.49.0.1.840.0.abc.001.1',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-104.85, 32],
        [-104.35, 32],
        [-104.35, 32.5],
        [-104.85, 32.5],
        [-104.85, 32],
      ],
    ],
  },
  properties: {
    layer: 'weather-warnings',
    source: 'nws',
    event: 'Flash Flood Warning',
    severity: 'Severe',
    urgency: 'Immediate',
    certainty: 'Likely',
    headline: 'Flash Flood Warning issued October 25 at 2:01AM MDT',
    areaDesc: 'Eddy, NM',
    senderName: 'NWS Midland/Odessa TX',
    onset: '2026-10-25T08:01:00.000Z',
    expires: '2099-10-25T09:30:00.000Z',
    url: 'https://www.weather.gov/',
    timestamp: '2026-10-25T08:01:00.000Z',
  },
};
const bonin = {
  type: 'Feature',
  id: 'tsunami:PAAQ-890504a1',
  geometry: { type: 'Point', coordinates: [139.9, 28] },
  properties: {
    layer: 'weather-warnings',
    source: 'tsunami',
    title: 'in the Bonin Islands, Japan region',
    level: 'warning',
    center: 'PAAQ',
    magnitude: 7,
    magnitudeType: 'Mwp',
    url: 'https://www.tsunami.gov/events/PAAQ/WEAK53.txt',
    timestamp: '2026-10-25T02:26:53.000Z',
  },
};
const metadata = (sources = []) => ({
  layer: 'weather-warnings',
  fetchedAt: '2026-10-25T09:00:00.000Z',
  stale: false,
  partial: sources.some((entry) => !entry.ok),
  sources,
});
const snapshot = (features = [flood, bonin], sources) => ({
  features,
  metadata: metadata(
    sources ?? [
      { id: 'nws', ok: true, stale: false, count: 1, pendingZones: 0 },
      { id: 'tsunami', ok: true, stale: false, count: 1 },
    ],
  ),
});

test('areas render as filled polygons with an outline, tsunami as clamped points', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.deepEqual(
    entities.map((entity) => entity.id),
    [
      'weather-warnings:nws:urn:oid:2.49.0.1.840.0.abc.001.1:0',
      'weather-warnings:tsunami:PAAQ-890504a1:0',
    ],
  );
  assert.ok(entities[0].polygon, 'alert area missing');
  assert.ok(entities[0].polyline, 'alert outline missing');
  assert.ok(entities[1].point, 'tsunami point missing');
  assert.equal(h.layer.getStats().count, 2);
  // Only points are claimed in the pick registry, so a large alert area
  // cannot make sibling layers' cards inert.
  const owns = h.owners.get('weather-warnings');
  assert.equal(owns('weather-warnings:tsunami:PAAQ-890504a1:0'), true);
  assert.equal(
    owns('weather-warnings:nws:urn:oid:2.49.0.1.840.0.abc.001.1:0'),
    false,
  );
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

test('clicking an alert area shows its card; the card opens the source; empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'weather-warnings:nws:urn:oid:2.49.0.1.840.0.abc.001.1:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('weather-warnings');
  assert.equal(
    card.id,
    'weather-warnings-card:nws:urn:oid:2.49.0.1.840.0.abc.001.1',
  );
  assert.equal(card.title, 'Flash Flood Warning');
  assert.equal(card.details[0], 'Severe · Immediate');
  assert.equal(card.details[1], 'Eddy, NM');
  assert.equal(card.accent, '#ff1744');
  assert.equal(card.interactive, true);
  assert.ok(card.position, 'card has no world position');
  assert.equal(card.details.at(-1), 'NWS ↗ · click card to open');
  // A click on the card itself opens the NWS page.
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, [flood.properties.url]);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('weather-warnings').length, 1);
  // Empty space clears it.
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('weather-warnings'), []);
});

test('tsunami point picks select their bulletin', async () => {
  let picked = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'weather-warnings:tsunami:PAAQ-890504a1:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('weather-warnings');
  assert.equal(card.title, 'in the Bonin Islands, Japan region');
  assert.equal(card.details[0], 'Tsunami warning · M 7.0 Mwp');
  assert.equal(card.details.at(-1), 'NOAA tsunami ↗ · click card to open');
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
      ['source-nws', 'NWS alerts', true],
      ['source-tsunami', 'NOAA tsunami', true],
    ],
  );
  chips()[0].onClick();
  assert.equal(chips()[0].active, false);
  assert.deepEqual(
    h.sources[0].entities.values.map((entity) => entity.id),
    ['weather-warnings:tsunami:PAAQ-890504a1:0'],
  );
  assert.equal(h.layer.getStats().count, 1);
  assert.deepEqual(
    h.layer.getRowControls().legend.map(({ label, count }) => [label, count]),
    [['Tsunami warning', 1]],
  );
  chips()[0].onClick();
  assert.equal(h.sources[0].entities.values.length, 2);
  assert.equal(fetches, 1);
  assert.ok(notified >= 3);
});

test('a partial snapshot reports the missing feed; an unchanged one is not rebuilt', async () => {
  let current = snapshot(
    [flood],
    [
      { id: 'nws', ok: true, stale: false, count: 1, pendingZones: 0 },
      { id: 'tsunami', ok: false, stale: false, count: 0, error: 'timeout' },
    ],
  );
  const h = harness({ getSnapshot: async () => current });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'NOAA tsunami feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
  const before = h.sources[0].entities.values[0];
  current = snapshot([flood]);
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.sources[0].entities.values[0], before);
});

test('a failed refresh keeps the displayed warnings and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Weather & Tsunami Warnings HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 2);
  assert.equal(h.layer.getStats().error, 'Weather & Tsunami Warnings HTTP 502');
});

test('the layer refreshes every two minutes, matching the server NWS cache', () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(h.layer.id, 'weather-warnings');
  assert.equal(h.layer.name, 'Weather & Tsunami Warnings');
  assert.equal(h.layer.updateInterval, 120_000);
  h.layer.destroy();
});

test('analyst records carry warning facts at the card anchor', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  await h.layer.update(h.viewer);
  const [area, point] = h.layer.getAnalystRecords();
  assert.equal(area.id, 'nws:urn:oid:2.49.0.1.840.0.abc.001.1');
  assert.equal(area.kind, 'weather');
  assert.equal(area.event, 'Flash Flood Warning');
  assert.equal(area.severity, 'Severe');
  assert.equal(area.area, 'Eddy, NM');
  assert.ok(Math.abs(area.lat - 32.25) < 1e-9);
  assert.ok(Math.abs(area.lon - -104.6) < 1e-9);
  assert.deepEqual(point, {
    id: 'tsunami:PAAQ-890504a1',
    lat: 28,
    lon: 139.9,
    kind: 'tsunami',
    event: 'in the Bonin Islands, Japan region',
    severity: 'warning',
    area: null,
    timeMs: Date.parse('2026-10-25T02:26:53.000Z'),
  });
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
