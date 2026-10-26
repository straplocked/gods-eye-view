import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createKeylessFeatureLayer, cullHorizonParts } from './featureLayer.js';

const EARTH_VIEW_M = 20_000_000;

/** A viewer double with a real Cesium preRender event and a movable camera. */
function cullHarness(features) {
  const sources = [];
  let renders = 0;
  const viewer = {
    camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, EARTH_VIEW_M) },
    scene: {
      pick: () => null,
      preRender: new Cesium.Event(),
      requestRender: () => {
        renders += 1;
      },
    },
    dataSources: {
      add: (value) => sources.push(value),
      remove: (value) => sources.splice(sources.indexOf(value), 1),
    },
  };
  const layer = createKeylessFeatureLayer({
    id: 'cull-test',
    name: 'Cull Test',
    source: {
      getSnapshot: async () => ({ type: 'FeatureCollection', features }),
    },
    card: (feature) => ({ title: feature.id, details: [] }),
  });
  layer.init(viewer);
  layer.enable(viewer);
  const show = (featureId) =>
    sources[0].entities.getById(`cull-test:${featureId}:0`).show;
  const frame = () => viewer.scene.preRender.raiseEvent(viewer.scene);
  const lookFrom = (lon, lat) => {
    viewer.camera.positionWC = Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      EARTH_VIEW_M,
    );
  };
  return {
    layer,
    viewer,
    sources,
    show,
    frame,
    lookFrom,
    renders: () => renders,
  };
}

const point = (id, lon, lat) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { layer: 'cull-test', source: 'test' },
});

const square = (id, lon, lat, half = 2) => ({
  type: 'Feature',
  id,
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [lon - half, lat - half],
        [lon + half, lat - half],
        [lon + half, lat + half],
        [lon - half, lat + half],
        [lon - half, lat - half],
      ],
    ],
  },
  properties: { layer: 'cull-test', source: 'test' },
});

test('cullHorizonParts writes show only when it flips and reports a change', () => {
  const a = { entity: { show: true }, position: 'a' };
  const b = { entity: { show: true }, sphere: 'b' };
  const points = { isPointVisible: (p) => p !== 'a' };
  const spheres = { isBoundingSphereVisible: () => true };
  assert.equal(cullHorizonParts([a, b], points, spheres), true);
  assert.equal(a.entity.show, false);
  assert.equal(b.entity.show, true);
  assert.equal(cullHorizonParts([a, b], points, spheres), false);
});

test('markers on the far side of the Earth are hidden, near-side ones shown (GUARD)', async () => {
  const h = cullHarness([
    point('near', 10, 5),
    point('antipode', 180, 0),
    point('far-asia', 120, 30),
    square('near-area', -5, 0),
    square('far-area', 170, -10),
  ]);
  await h.layer.update();
  h.frame();
  // Camera 20,000 km above 0°, 0°: the Pacific is behind the planet.
  assert.equal(h.show('near'), true);
  assert.equal(h.show('near-area'), true);
  assert.equal(h.show('antipode'), false);
  assert.equal(h.show('far-asia'), false);
  assert.equal(h.show('far-area'), false);
  // Orbit to the other side: the visibility swaps.
  h.lookFrom(180, 0);
  h.frame();
  assert.equal(h.show('near'), false);
  assert.equal(h.show('near-area'), false);
  assert.equal(h.show('antipode'), true);
  assert.equal(h.show('far-asia'), true);
  assert.equal(h.show('far-area'), true);
  h.layer.destroy();
});

test('new snapshots are culled before their first frame, and a still camera skips the pass', async () => {
  const h = cullHarness([point('antipode', 180, 0)]);
  await h.layer.update();
  // No frame raised yet: render() culled the fresh entities itself.
  assert.equal(h.show('antipode'), false);
  const before = h.renders();
  h.frame();
  h.frame();
  assert.equal(h.renders(), before);
  h.layer.destroy();
});

test('disable and destroy remove the preRender cull listener', async () => {
  const h = cullHarness([point('near', 0, 0)]);
  await h.layer.update();
  assert.equal(h.viewer.scene.preRender.numberOfListeners, 1);
  h.layer.disable();
  assert.equal(h.viewer.scene.preRender.numberOfListeners, 0);
  h.layer.enable(h.viewer);
  assert.equal(h.viewer.scene.preRender.numberOfListeners, 1);
  h.layer.destroy();
  assert.equal(h.viewer.scene.preRender.numberOfListeners, 0);
});
