import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceSources } from './reference.js';
import { createStandaloneReferenceSources } from '../standalone/layerSources.js';

test('reference factories retain compatibility without starting acquisition or sharing instances', (t) => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', () => {
    requests++;
    throw new Error('unexpected acquisition');
  });
  assert.equal(createReferenceSources, createStandaloneReferenceSources);
  const first = createReferenceSources();
  const second = createReferenceSources();
  assert.deepEqual(Object.keys(first), [
    'earthquakes',
    'air-quality',
    'fire-perimeters',
    'cables',
    'gnss-integrity',
    'global-hazards',
    'weather-warnings',
    'volcanoes',
    'space-weather',
    'aviation-weather',
    'airspace',
  ]);
  assert.notEqual(first.earthquakes, second.earthquakes);
  assert.notEqual(first['air-quality'], second['air-quality']);
  assert.notEqual(first['fire-perimeters'], second['fire-perimeters']);
  assert.notEqual(first.cables, second.cables);
  assert.notEqual(first['gnss-integrity'], second['gnss-integrity']);
  assert.notEqual(first['global-hazards'], second['global-hazards']);
  assert.notEqual(first['weather-warnings'], second['weather-warnings']);
  assert.notEqual(first.volcanoes, second.volcanoes);
  assert.notEqual(first['space-weather'], second['space-weather']);
  assert.notEqual(first['aviation-weather'], second['aviation-weather']);
  assert.notEqual(first.airspace, second.airspace);
  assert.equal(typeof first.earthquakes.getSnapshot, 'function');
  assert.equal(typeof first['air-quality'].getSnapshot, 'function');
  assert.equal(typeof first['fire-perimeters'].getSnapshot, 'function');
  assert.equal(typeof first.cables.fetch, 'function');
  assert.equal(typeof first['gnss-integrity'].getSnapshot, 'function');
  assert.equal(typeof first['global-hazards'].getSnapshot, 'function');
  assert.equal(typeof first['weather-warnings'].getSnapshot, 'function');
  assert.equal(typeof first.volcanoes.getSnapshot, 'function');
  assert.equal(typeof first['space-weather'].getSnapshot, 'function');
  assert.equal(typeof first['aviation-weather'].getSnapshot, 'function');
  assert.equal(typeof first.airspace.getSnapshot, 'function');
  assert.equal(requests, 0);
});
