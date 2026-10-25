import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeEonetEvents,
  normalizeGdacsEvents,
  gdacsMapUrl,
} from './records.js';
import {
  eonetEvents,
  gdacsCyclones,
  gdacsDroughts,
  gdacsEarthquakes,
  gdacsFloods,
  gdacsVolcanoes,
  gdacsWildfires,
} from '../../testSupport/globalHazardsFixtures.mjs';
import { assertValidFeatureCollection } from '../../testSupport/geojson.mjs';

const allGdacs = [
  gdacsEarthquakes,
  gdacsCyclones,
  gdacsFloods,
  gdacsVolcanoes,
  gdacsDroughts,
  gdacsWildfires,
];

test('GDACS MAP URLs ask for exactly one event type', () => {
  assert.equal(
    gdacsMapUrl('TC'),
    'https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=TC',
  );
});

test('GDACS lists of all six types reduce to one centroid per event', () => {
  const collection = normalizeGdacsEvents(allGdacs);
  assertValidFeatureCollection(collection, { requireIds: true });
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    [
      'EQ-1573748',
      'TC-1001338',
      'FL-1104243',
      'VO-1000152',
      'DR-1027465',
      'WF-1033119',
    ],
  );
  const byId = new Map(collection.features.map((f) => [f.id, f]));
  assert.deepEqual(byId.get('TC-1001338'), {
    type: 'Feature',
    id: 'TC-1001338',
    geometry: { type: 'Point', coordinates: [141.2, 27.6] },
    properties: {
      hazard: 'cyclone',
      eventtype: 'TC',
      eventid: 1001338,
      episodeid: 35,
      alertlevel: 'red',
      name: 'Tropical Cyclone CHAMPI-26',
      country: 'Japan',
      fromdate: '2026-10-14T12:00:00.000Z',
      todate: '2026-10-23T00:00:00.000Z',
      severity: 'Hurricane/Typhoon > 74 mph (maximum wind speed of 296 km/h)',
      url: 'https://www.gdacs.org/report.aspx?eventid=1001338&episodeid=35&eventtype=TC',
      timestamp: '2026-10-23T00:00:00.000Z',
    },
  });
  // The flood keeps its centroid, not the earlier "Point_Affected" row.
  assert.deepEqual(
    byId.get('FL-1104243').geometry.coordinates,
    [4.1146915, 43.6989653],
  );
  assert.equal(byId.get('FL-1104243').properties.severity, 'Magnitude 0');
  const volcano = byId.get('VO-1000152').properties;
  assert.equal(volcano.hazard, 'volcano');
  assert.equal(volcano.alertlevel, 'orange');
  assert.equal(volcano.name, 'Eruption Kanlaon');
  assert.equal(volcano.severity, null);
  assert.equal(byId.get('DR-1027465').properties.hazard, 'drought');
  assert.equal(byId.get('EQ-1573748').properties.alertlevel, 'green');
  // An http:// report link is not passed on as a click-through.
  assert.equal(byId.get('WF-1033119').properties.url, null);
});

test('GDACS types with nothing current (404 -> null) are skipped', () => {
  const collection = normalizeGdacsEvents([
    gdacsEarthquakes,
    null,
    null,
    null,
    null,
    null,
  ]);
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ['EQ-1573748'],
  );
});

test('corrupt GDACS payloads throw instead of becoming an empty snapshot', () => {
  for (const payloads of [
    null,
    [{ error: 'upstream' }],
    [gdacsEarthquakes, { type: 'FeatureCollection', features: 'x' }],
    [null, null, null, null, null, null],
  ])
    assert.throws(() => normalizeGdacsEvents(payloads), {
      code: 'invalid_payload',
    });
});

test('EONET groups observations per event and keeps the latest geometry', () => {
  const collection = normalizeEonetEvents(eonetEvents);
  assertValidFeatureCollection(collection, { requireIds: true });
  assert.deepEqual(
    collection.features.map((feature) => feature.id),
    ['EONET_25590', 'EONET_25589', 'EONET_6474', 'EONET_9001'],
  );
  const byId = new Map(collection.features.map((f) => [f.id, f]));
  assert.deepEqual(byId.get('EONET_25589'), {
    type: 'Feature',
    id: 'EONET_25589',
    geometry: { type: 'Point', coordinates: [-104.1, 14.8] },
    properties: {
      hazard: 'storm',
      category: 'severeStorms',
      categoryTitle: 'Severe Storms',
      alertlevel: null,
      name: 'Hurricane Vance',
      description: null,
      magnitudeValue: 105,
      magnitudeUnit: 'kts',
      url: 'https://www.metoc.navy.mil/jtwc/products/ep2226.tcw',
      timestamp: '2026-10-23T06:00:00.000Z',
    },
  });
  assert.equal(byId.get('EONET_25590').properties.hazard, 'wildfire');
  assert.equal(byId.get('EONET_25590').properties.magnitudeValue, 2060);
  // The drift track becomes its last position, dated by geometryDates.
  assert.deepEqual(byId.get('EONET_6474').geometry, {
    type: 'Point',
    coordinates: [-43.77, -60.14],
  });
  assert.equal(
    byId.get('EONET_6474').properties.timestamp,
    '2026-10-15T00:00:00.000Z',
  );
  assert.equal(byId.get('EONET_6474').properties.hazard, 'ice');
  assert.equal(byId.get('EONET_6474').properties.url, null);
  assert.equal(byId.get('EONET_9001').geometry.type, 'Polygon');
  assert.equal(byId.get('EONET_9001').properties.hazard, 'volcano');
});

test('corrupt EONET payloads throw', () => {
  for (const payload of [null, [], { features: {} }, { title: 'error' }])
    assert.throws(() => normalizeEonetEvents(payload), {
      code: 'invalid_payload',
    });
});

test('an empty EONET collection is a real (empty) snapshot', () => {
  assert.deepEqual(
    normalizeEonetEvents({ type: 'FeatureCollection', features: [] }),
    { type: 'FeatureCollection', features: [] },
  );
});
