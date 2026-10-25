import assert from 'node:assert/strict';
import test from 'node:test';
import { createVolcanoesLayer } from './index.js';

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
  const layer = createVolcanoesLayer({
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

const kilauea = {
  type: 'Feature',
  id: 'volcano:332010',
  geometry: { type: 'Point', coordinates: [-155.287, 19.421] },
  properties: {
    layer: 'volcanoes',
    source: 'gvp+usgs',
    name: 'Kilauea',
    vnum: 332010,
    eruption: true,
    vei: 1,
    eruptionStart: '2024-12-23T00:00:00.000Z',
    eruptionStartYear: 2024,
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    observatory: 'HVO',
    region: 'Hawaii',
    synopsis: 'The eruption is paused; reinflation continues.',
    url: 'https://www.usgs.gov/volcanoes/kilauea',
    timestamp: '2026-10-24T18:15:36.000Z',
  },
};
const yasur = {
  type: 'Feature',
  id: 'volcano:257100',
  geometry: { type: 'Point', coordinates: [169.447, -19.532] },
  properties: {
    layer: 'volcanoes',
    source: 'gvp',
    name: 'Yasur',
    vnum: 257100,
    eruption: true,
    vei: 3,
    eruptionStart: null,
    eruptionStartYear: 1270,
    alertLevel: null,
    colorCode: null,
    url: 'https://volcano.si.edu/volcano.cfm?vn=257100',
    timestamp: null,
  },
};
const shishaldin = {
  type: 'Feature',
  id: 'volcano:311360',
  geometry: { type: 'Point', coordinates: [-163.9711, 54.7554] },
  properties: {
    layer: 'volcanoes',
    source: 'usgs',
    name: 'Shishaldin',
    vnum: 311360,
    eruption: false,
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    observatory: 'AVO',
    region: 'Aleutians',
    url: 'https://avo.alaska.edu/activity/Shishaldin.php',
    timestamp: '2026-10-24T17:32:14.000Z',
  },
};
const metadata = (sources = []) => ({
  layer: 'volcanoes',
  fetchedAt: '2026-10-25T08:00:00.000Z',
  stale: false,
  partial: sources.some((entry) => !entry.ok),
  sources,
});
const snapshot = (features = [kilauea, yasur, shishaldin], sources) => ({
  features,
  metadata: metadata(
    sources ?? [
      { id: 'gvp', ok: true, stale: false, count: 2 },
      { id: 'usgs', ok: true, stale: false, count: 2 },
    ],
  ),
});

test('every volcano renders as one clamped point; all points are pick-owned', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.deepEqual(
    entities.map((entity) => entity.id),
    [
      'volcanoes:volcano:332010:0',
      'volcanoes:volcano:257100:0',
      'volcanoes:volcano:311360:0',
    ],
  );
  assert.ok(
    entities.every((entity) => entity.point),
    'volcano point missing',
  );
  assert.equal(h.layer.getStats().count, 3);
  const owns = h.owners.get('volcanoes');
  assert.equal(owns('volcanoes:volcano:332010:0'), true);
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

test('clicking a volcano shows its card; the card opens the USGS page; empty space clears it', async () => {
  let picked = null;
  let cardHit = null;
  const h = harness(
    { getSnapshot: async () => snapshot() },
    { pick: () => picked, cardHit: () => cardHit },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'volcanoes:volcano:332010:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  const [card] = h.overlay.entries.get('volcanoes');
  assert.equal(card.id, 'volcanoes-card:volcano:332010');
  assert.equal(card.title, 'Kilauea');
  assert.equal(card.details[0], 'Eruption ongoing · VEI 1');
  assert.equal(
    card.details[1],
    'Alert level: Advisory · Aviation code: Yellow',
  );
  assert.equal(card.accent, '#fdd835');
  assert.equal(card.interactive, true);
  assert.ok(card.position, 'card has no world position');
  assert.equal(
    card.details.at(-1),
    'Smithsonian GVP · USGS ↗ · click card to open',
  );
  // A click on the card itself opens the USGS page.
  cardHit = { entryId: card.id };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.deepEqual(h.opened, [kilauea.properties.url]);
  cardHit = null;
  // A sibling layer's pick leaves the card alone.
  picked = { id: 'other-layer:plane' };
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.equal(h.overlay.entries.get('volcanoes').length, 1);
  // Empty space clears it.
  picked = null;
  h.clicks.handler({ position: { x: 3, y: 4 } });
  assert.deepEqual(h.overlay.entries.get('volcanoes'), []);
});

test('the open card follows a refresh that changes the volcano under it', async () => {
  let picked = null;
  let current = snapshot();
  const h = harness(
    { getSnapshot: async () => current },
    { pick: () => picked },
  );
  await h.layer.update(h.viewer);
  picked = { id: 'volcanoes:volcano:332010:0' };
  h.clicks.handler({ position: { x: 1, y: 2 } });
  assert.equal(
    h.overlay.entries.get('volcanoes')[0].details[0],
    'Eruption ongoing · VEI 1',
  );
  // GVP drops out: the same id is now USGS-only and the card re-publishes.
  const usgsOnly = {
    ...kilauea,
    properties: {
      ...kilauea.properties,
      source: 'usgs',
      eruption: false,
      vei: null,
    },
  };
  current = snapshot([usgsOnly, yasur, shishaldin]);
  await h.layer.update(h.viewer);
  const [card] = h.overlay.entries.get('volcanoes');
  assert.equal(card.id, 'volcanoes-card:volcano:332010');
  assert.equal(
    card.details[0],
    'Alert level: Advisory · Aviation code: Yellow',
  );
});

test('feed chips: a merged volcano stays until both of its feeds are hidden', async () => {
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
      ['source-gvp', 'Smithsonian GVP', true],
      ['source-usgs', 'USGS', true],
    ],
  );
  // The merged volcano counts for both feeds: gvp 2 (Kilauea, Yasur), usgs 2.
  assert.match(chips()[0].title, /Smithsonian GVP: 2 loaded/);
  assert.match(chips()[1].title, /USGS: 2 loaded/);
  const shown = () => h.sources[0].entities.values.map((e) => e.id);
  chips()[0].onClick();
  assert.deepEqual(shown(), [
    'volcanoes:volcano:332010:0',
    'volcanoes:volcano:311360:0',
  ]);
  chips()[1].onClick();
  assert.deepEqual(shown(), []);
  chips()[0].onClick();
  assert.deepEqual(shown(), [
    'volcanoes:volcano:332010:0',
    'volcanoes:volcano:257100:0',
  ]);
  chips()[1].onClick();
  assert.equal(shown().length, 3);
  assert.equal(fetches, 1);
  assert.ok(notified >= 4);
});

test('a partial snapshot reports the missing feed; an unchanged one is not rebuilt', async () => {
  let current = snapshot(
    [yasur],
    [
      { id: 'gvp', ok: true, stale: false, count: 1 },
      { id: 'usgs', ok: false, stale: false, count: 0, error: 'timeout' },
    ],
  );
  const h = harness({ getSnapshot: async () => current });
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, 'USGS feed unavailable');
  assert.equal(h.layer.getStats().degraded, true);
  const before = h.sources[0].entities.values[0];
  current = snapshot([yasur]);
  await h.layer.update(h.viewer);
  assert.equal(h.layer.getStats().error, null);
  assert.equal(h.sources[0].entities.values[0], before);
});

test('a failed refresh keeps the displayed volcanoes and reports the error', async () => {
  let fail = false;
  const h = harness({
    getSnapshot: async () => {
      if (fail) throw new Error('Volcanoes HTTP 502');
      return snapshot();
    },
  });
  await h.layer.update(h.viewer);
  fail = true;
  assert.equal(await h.layer.update(h.viewer), false);
  assert.equal(h.layer.getStats().count, 3);
  assert.equal(h.layer.getStats().error, 'Volcanoes HTTP 502');
});

test('analyst records carry volcano facts at the point', async () => {
  const h = harness({ getSnapshot: async () => snapshot() });
  await h.layer.update(h.viewer);
  const [first] = h.layer.getAnalystRecords();
  assert.deepEqual(first, {
    id: 'volcano:332010',
    lat: 19.421,
    lon: -155.287,
    name: 'Kilauea',
    vnum: 332010,
    erupting: true,
    vei: 1,
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    source: 'gvp+usgs',
    timeMs: Date.parse('2026-10-24T18:15:36.000Z'),
  });
  h.layer.disable();
  assert.deepEqual(h.layer.getAnalystRecords(), []);
});
