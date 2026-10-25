import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpaceWeatherLayer } from './index.js';
import { normalizeAurora } from './records.js';
import { ovation } from '../../testSupport/spaceWeatherFixtures.mjs';

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
  const layer = createSpaceWeatherLayer({
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

// Two real bands from the normalizer (cells -10 and -9 at lat 65, 25-27 %, and a
// faint cell at lat 66), plus one hand-written feature with two separate parts.
const normalized = normalizeAurora(
  ovation([
    [350, 65, 25],
    [351, 65, 27],
    [350, 66, 12],
    [100, 60, 15],
    [101, 61, 15],
  ]),
);
const stamp = (feature) => ({
  ...feature,
  id: `aurora:${feature.id}`,
  properties: {
    ...feature.properties,
    layer: 'space-weather',
    source: 'aurora',
  },
});
const bands = normalized.features.map(stamp);
const bandById = (id) => bands.find((feature) => feature.id === id);

const metadata = (kp = {}, aurora = {}) => ({
  layer: 'space-weather',
  fetchedAt: '2026-10-25T08:40:00.000Z',
  stale: false,
  partial: [kp, aurora].some((entry) => entry.ok === false),
  sources: [
    { id: 'aurora', ok: true, stale: false, count: bands.length, ...aurora },
    {
      id: 'kp',
      ok: true,
      stale: false,
      count: 0,
      kp: 7.33,
      kpTime: '2026-10-25T06:00:00.000Z',
      gScale: 3,
      kpMax24h: 7.33,
      ...kp,
    },
  ],
});
const snapshot = (features = bands, meta = metadata()) => ({
  features,
  metadata: meta,
});

test('bands render as clamped fills without outlines; none is pick-owned', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.deepEqual(
    entities.map((entity) => entity.id),
    [
      'space-weather:aurora:north-10-1:0',
      'space-weather:aurora:north-10-3:0',
      'space-weather:aurora:north-10-3:1',
      'space-weather:aurora:north-20-1:0',
    ],
  );
  for (const entity of entities) {
    assert.ok(entity.polygon, 'band polygon missing');
    assert.equal(entity.polyline, undefined, 'a band was outlined');
    assert.equal(entity.point, undefined);
  }
  // Two parts of one MultiPolygon feature share its id and card.
  assert.equal(h.layer.getStats().count, 3);
  const owns = h.owners.get('space-weather');
  assert.equal(owns('space-weather:aurora:north-20-1:0'), false);
  assert.equal(owns('other-layer:plane'), false);
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
    assert.equal(h.layer.getRowControls().info, undefined);
    h.layer.destroy(h.viewer);
  }
});

test('two displays own separate data sources and destruction', async () => {
  const a = harness({ getSnapshot: async () => snapshot() });
  const b = harness({ getSnapshot: async () => snapshot([]) });
  await a.layer.update(a.viewer);
  await b.layer.update(b.viewer);
  assert.equal(a.layer.getStats().count, 3);
  assert.equal(b.layer.getStats().count, 0);
  a.layer.destroy();
  assert.equal(a.sources.length, 0);
  assert.equal(b.sources.length, 1);
  assert.equal(a.clicks.destroyed, 1);
  b.layer.destroy();
});

test('clicking a band shows its card with the Kp line; the card opens the SWPC page; empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'space-weather:aurora:north-20-1:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('space-weather');
  assert.equal(card.id, 'space-weather-card:aurora:north-20-1');
  assert.equal(card.title, 'Aurora chance 20–40%');
  assert.equal(card.details[0], 'Peak 27% in this area');
  assert.equal(card.details[2], 'Kp 7.33 · G3 strong geomagnetic storm');
  assert.equal(card.accent, '#76ff03');
  assert.equal(card.interactive, true);
  assert.ok(card.position, 'card has no world position');
  // The card sits over the band, near -9.5, 65.
  const { x, y, z } = card.position;
  assert.ok(Math.hypot(x, y, z) > 6_000_000);
  // A click on the card itself opens the SWPC aurora page.
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, [
    'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast',
  ]);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('space-weather').length, 1);
  // Empty space clears it.
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('space-weather'), []);
});

test('the row shows the latest Kp and G-scale; a new Kp updates it and an open card while the band entities stay', async () => {
  let picked = null;
  let current = snapshot();
  let notified = 0;
  const h = harness(
    { getSnapshot: async () => current },
    { pick: () => picked },
  );
  h.layer.setRowControlsListener(() => notified++);
  assert.equal(h.layer.getRowControls().info, undefined);
  await h.layer.update(h.viewer);
  assert.deepEqual(
    (({ info, infoTitle }) => ({ info, infoTitle }))(h.layer.getRowControls()),
    {
      info: 'Kp 7.33 · G3 strong geomagnetic storm',
      infoTitle:
        'Planetary K-index for the 3-hour interval starting 06:00 UTC; highest of the last 24 hours: 7.33',
    },
  );
  picked = { id: 'space-weather:aurora:north-20-1:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.equal(
    h.overlay.entries.get('space-weather')[0].details[2],
    'Kp 7.33 · G3 strong geomagnetic storm',
  );
  // Same bands, calmer Kp: the entities stay, the row and the open card change.
  const before = h.sources[0].entities.values[0];
  const notifiedBefore = notified;
  current = snapshot(
    bands,
    metadata({ kp: 3.67, gScale: 0, kpTime: '2026-10-25T09:00:00.000Z' }),
  );
  await h.layer.update(h.viewer);
  assert.equal(h.sources[0].entities.values[0], before);
  assert.equal(h.layer.getRowControls().info, 'Kp 3.67 · no geomagnetic storm');
  assert.equal(
    h.overlay.entries.get('space-weather')[0].details[2],
    'Kp 3.67 · no geomagnetic storm',
  );
  assert.ok(notified > notifiedBefore);
});

test('a quiet sky still reports Kp; there are no feed chips, only the legend of drawn bands', async () => {
  const h = harness({ getSnapshot: async () => snapshot([]) });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().count, 0);
  assert.equal(h.layer.getStats().error, null);
  const controls = h.layer.getRowControls();
  assert.equal(controls.info, 'Kp 7.33 · G3 strong geomagnetic storm');
  assert.deepEqual(controls.chips, []);
  assert.deepEqual(controls.legend, []);
  const drawn = harness({ getSnapshot: async () => snapshot() });
  await drawn.layer.update(drawn.viewer);
  assert.deepEqual(
    drawn.layer
      .getRowControls()
      .legend.map(({ label, color, count }) => [label, color, count]),
    [
      ['Aurora chance 10–20%', '#00e676', null],
      ['Aurora chance 20–40%', '#76ff03', null],
    ],
  );
});

test('a feed that failed is named in the status; a Kp outage hides the readout, an aurora outage keeps it', async () => {
  const kpDown = harness({
    getSnapshot: async () =>
      snapshot(
        bands,
        metadata({
          ok: false,
          kp: undefined,
          kpTime: undefined,
          gScale: undefined,
          kpMax24h: undefined,
          count: 0,
          error: 'timeout',
        }),
      ),
  });
  await kpDown.layer.update(kpDown.viewer);
  assert.equal(kpDown.layer.getStats().error, 'NOAA Kp index feed unavailable');
  assert.equal(kpDown.layer.getStats().degraded, true);
  assert.equal(kpDown.layer.getRowControls().info, undefined);
  assert.equal(kpDown.layer.getStats().count, 3);

  const auroraDown = harness({
    getSnapshot: async () =>
      snapshot([], metadata({}, { ok: false, count: 0, error: 'timeout' })),
  });
  await auroraDown.layer.update(auroraDown.viewer);
  assert.equal(
    auroraDown.layer.getStats().error,
    'NOAA aurora feed unavailable',
  );
  assert.equal(
    auroraDown.layer.getRowControls().info,
    'Kp 7.33 · G3 strong geomagnetic storm',
  );
});

test('a failed refresh keeps the displayed bands and Kp and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Aurora & Space Weather HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 3);
  assert.equal(h.layer.getStats().error, 'Aurora & Space Weather HTTP 502');
  assert.equal(
    h.layer.getRowControls().info,
    'Kp 7.33 · G3 strong geomagnetic storm',
  );
});

test('analyst records are plain positions of the drawn bands; none while disabled', async () => {
  const h = harness({
    getSnapshot: async () => snapshot([bandById('aurora:north-20-1')]),
  });
  await h.layer.update(h.viewer);
  const [first] = h.layer.getAnalystRecords();
  assert.equal(first.id, 'aurora:north-20-1');
  // The anchor is the band's vertex mean: between -10.5 and -8.5, 64.5 and 65.5.
  assert.ok(first.lon > -10.5 && first.lon < -8.5, `lon ${first.lon}`);
  assert.ok(first.lat > 64.5 && first.lat < 65.5, `lat ${first.lat}`);
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
