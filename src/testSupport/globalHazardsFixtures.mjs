// Hand-written GDACS and NASA EONET payloads for the Global Hazards tests,
// modeled on real responses (GDACS geteventlist/MAP per type and SEARCH,
// EONET v3 events/geojson, October 2026) and trimmed to the fields used.

const gdacsUrls = (type, eventId, episodeId) => ({
  geometry: `https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=${type}&eventid=${eventId}&episodeid=${episodeId}`,
  report: `https://www.gdacs.org/report.aspx?eventid=${eventId}&episodeid=${episodeId}&eventtype=${type}`,
  details: `https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=${type}&eventid=${eventId}`,
});

const gdacsFeature = (geometry, properties) => ({
  type: 'Feature',
  bbox: null,
  geometry,
  properties,
});

const square = (lon, lat) => [
  [
    [lon, lat],
    [lon + 1, lat],
    [lon + 1, lat + 1],
    [lon, lat + 1],
    [lon, lat],
  ],
];

/** GDACS MAP, eventtype=EQ: centroid point plus its Poly_Circle. */
export const gdacsEarthquakes = {
  type: 'FeatureCollection',
  features: [
    gdacsFeature(
      { type: 'Point', coordinates: [-165.019, 53.44] },
      {
        eventtype: 'EQ',
        eventid: 1573748,
        episodeid: 1742551,
        eventname: '',
        name: 'Earthquake in United States',
        alertlevel: 'Green',
        country: 'United States',
        fromdate: '2026-10-25T07:45:45',
        todate: '2026-10-25T07:45:45',
        Class: 'Point_Centroid',
        iscurrent: 'true',
        url: gdacsUrls('EQ', 1573748, 1742551),
        severitydata: {
          severity: 4.5,
          severitytext: 'Magnitude 4.5M, Depth:19.7km',
          severityunit: 'M',
        },
      },
    ),
    gdacsFeature(
      { type: 'Polygon', coordinates: square(-165.5, 53) },
      {
        eventtype: 'EQ',
        eventid: 1573748,
        episodeid: 1742551,
        name: 'Earthquake in United States',
        alertlevel: 'Green',
        Class: 'Poly_Circle',
      },
    ),
  ],
};

/** GDACS MAP, eventtype=TC: centroid, wind buffer polygon and track line. */
export const gdacsCyclones = {
  type: 'FeatureCollection',
  features: [
    gdacsFeature(
      { type: 'Polygon', coordinates: square(-66, 39.5) },
      {
        eventtype: 'TC',
        eventid: 1001338,
        episodeid: 35,
        name: 'Tropical Cyclone CHAMPI-26',
        alertlevel: 'Red',
        Class: 'Poly_Red',
      },
    ),
    gdacsFeature(
      { type: 'Point', coordinates: [141.2, 27.6] },
      {
        eventtype: 'TC',
        eventid: 1001338,
        episodeid: 35,
        eventname: 'CHAMPI-26',
        name: 'Tropical Cyclone CHAMPI-26',
        alertlevel: 'Red',
        country: 'Japan',
        fromdate: '2026-10-14T12:00:00',
        todate: '2026-10-23T00:00:00',
        Class: 'Point_Centroid',
        iscurrent: 'true',
        url: gdacsUrls('TC', 1001338, 35),
        severitydata: {
          severity: 296,
          severitytext:
            'Hurricane/Typhoon > 74 mph (maximum wind speed of 296 km/h)',
          severityunit: 'km/h',
        },
      },
    ),
    gdacsFeature(
      {
        type: 'LineString',
        coordinates: [
          [150.1, 15.2],
          [141.2, 27.6],
        ],
      },
      {
        eventtype: 'TC',
        eventid: 1001338,
        episodeid: 35,
        name: 'Tropical Cyclone CHAMPI-26',
        alertlevel: 'Red',
        Class: 'Line_Line_0',
      },
    ),
  ],
};

/** GDACS MAP, eventtype=FL: centroid, affected and global points. */
export const gdacsFloods = {
  type: 'FeatureCollection',
  features: [
    gdacsFeature(
      { type: 'Point', coordinates: [4.125863381009295, 43.68777307778225] },
      {
        eventtype: 'FL',
        eventid: 1104243,
        episodeid: 2,
        name: 'Flood in France',
        alertlevel: 'Green',
        country: 'France',
        fromdate: '2026-10-19T01:00:00',
        todate: '2026-10-22T01:00:00',
        Class: 'Point_Affected',
        url: gdacsUrls('FL', 1104243, 2),
        severitydata: { severitytext: 'Magnitude 0 ' },
      },
    ),
    gdacsFeature(
      { type: 'Point', coordinates: [4.1146915, 43.6989653] },
      {
        eventtype: 'FL',
        eventid: 1104243,
        episodeid: 2,
        eventname: '',
        name: 'Flood in France',
        alertlevel: 'Green',
        country: 'France',
        fromdate: '2026-10-19T01:00:00',
        todate: '2026-10-22T01:00:00',
        Class: 'Point_Centroid',
        iscurrent: 'true',
        url: gdacsUrls('FL', 1104243, 2),
        severitydata: { severity: 0, severitytext: 'Magnitude 0 ' },
      },
    ),
    gdacsFeature(
      { type: 'Point', coordinates: [8.053224938715614, 42.550481795680064] },
      {
        eventtype: 'FL',
        eventid: 1104243,
        episodeid: 2,
        name: 'Flood in France',
        alertlevel: 'Green',
        Class: 'Point_Global',
      },
    ),
  ],
};

/** GDACS SEARCH, eventlist=VO (the MAP list 404s while no eruption is current). */
export const gdacsVolcanoes = {
  type: 'FeatureCollection',
  features: [
    gdacsFeature(
      { type: 'Point', coordinates: [123.132, 10.412] },
      {
        eventtype: 'VO',
        eventid: 1000152,
        episodeid: 1,
        eventname: 'Kanlaon',
        name: 'Eruption  Kanlaon',
        alertlevel: 'Orange',
        country: 'Philippines',
        fromdate: '2026-10-10T05:58:00',
        todate: '2026-10-10T05:58:00',
        Class: 'Point_Centroid',
        iscurrent: 'false',
        url: gdacsUrls('VO', 1000152, 1),
        severitydata: { severity: 0, severitytext: '', severityunit: '' },
      },
    ),
  ],
};

/** GDACS MAP, eventtype=DR: centroid plus a MultiPolygon area. */
export const gdacsDroughts = {
  type: 'FeatureCollection',
  features: [
    gdacsFeature(
      { type: 'Point', coordinates: [29.9, -3.4] },
      {
        eventtype: 'DR',
        eventid: 1027465,
        episodeid: 9,
        name: 'Drought in Burundi, Democratic Republic of Congo',
        alertlevel: 'Orange',
        country: 'Burundi, Democratic Republic of Congo',
        fromdate: '2026-05-21T00:00:00',
        todate: '2026-10-23T00:00:00',
        Class: 'Point_Centroid',
        iscurrent: 'false',
        url: gdacsUrls('DR', 1027465, 9),
        severitydata: {
          severitytext: 'Medium impact for agricultural drought in 172173 km2',
        },
      },
    ),
    gdacsFeature(
      { type: 'MultiPolygon', coordinates: [square(29, -4)] },
      {
        eventtype: 'DR',
        eventid: 1027465,
        episodeid: 9,
        alertlevel: 'Orange',
        Class: 'Poly_area',
      },
    ),
  ],
};

/** GDACS MAP, eventtype=WF with one usable fire and four broken rows. */
export const gdacsWildfires = {
  type: 'FeatureCollection',
  features: [
    gdacsFeature(
      { type: 'Point', coordinates: [35.1, -14.2] },
      {
        eventtype: 'WF',
        eventid: 1033119,
        episodeid: 2,
        name: 'Forest fires in Malawi',
        alertlevel: 'Green',
        country: 'Malawi',
        fromdate: '2026-10-17T00:00:00',
        todate: '2026-10-24T00:00:00',
        Class: 'Point_Centroid',
        url: { report: 'http://www.gdacs.org/report.aspx?eventid=1033119' },
        severitydata: {
          severitytext: 'Green impact for forestfire in 11117 ha',
        },
      },
    ),
    // Longitude out of range.
    gdacsFeature(
      { type: 'Point', coordinates: [195, 10] },
      { eventtype: 'WF', eventid: 1033200, Class: 'Point_Centroid' },
    ),
    // NaN latitude (serialized payloads cannot carry NaN; normalizers can still see it).
    gdacsFeature(
      { type: 'Point', coordinates: [10, Number.NaN] },
      { eventtype: 'WF', eventid: 1033201, Class: 'Point_Centroid' },
    ),
    // Missing event id.
    gdacsFeature(
      { type: 'Point', coordinates: [10, 10] },
      { eventtype: 'WF', name: 'No id', Class: 'Point_Centroid' },
    ),
    // Unknown event type.
    gdacsFeature(
      { type: 'Point', coordinates: [10, 10] },
      { eventtype: 'XX', eventid: 1, Class: 'Point_Centroid' },
    ),
  ],
};

const eonetFeature = (properties, geometry) => ({
  type: 'Feature',
  properties: {
    link: `https://eonet.gsfc.nasa.gov/api/v3/events/${properties.id}/geojson`,
    closed: null,
    description: null,
    ...properties,
  },
  geometry,
});

/** EONET v3 events/geojson?status=open&days=30. */
export const eonetEvents = {
  type: 'FeatureCollection',
  features: [
    eonetFeature(
      {
        id: 'EONET_25590',
        title: 'Wildfire BEE HAVEN (2) (24-06), Hamilton, Florida',
        description: '28 Miles NW from LAKE CITY, FL',
        date: '2026-10-22T21:45:00Z',
        magnitudeValue: 2060.0,
        magnitudeUnit: 'acres',
        categories: [{ id: 'wildfires', title: 'Wildfires' }],
        sources: [
          {
            id: 'IRWIN',
            url: 'https://irwin.doi.gov/observer/incidents/2026-FLFLS-260601105',
          },
        ],
      },
      { type: 'Point', coordinates: [-82.8577778, 30.4952778] },
    ),
    // A storm track: three dated points of one event; the latest wins.
    eonetFeature(
      {
        id: 'EONET_25589',
        title: 'Hurricane Vance',
        date: '2026-10-21T18:00:00Z',
        magnitudeValue: 35.0,
        magnitudeUnit: 'kts',
        categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
        sources: [
          {
            id: 'JTWC',
            url: 'https://www.metoc.navy.mil/jtwc/products/ep2226.tcw',
          },
        ],
      },
      { type: 'Point', coordinates: [-99.5, 9.4] },
    ),
    eonetFeature(
      {
        id: 'EONET_25589',
        title: 'Hurricane Vance',
        date: '2026-10-23T06:00:00Z',
        magnitudeValue: 105.0,
        magnitudeUnit: 'kts',
        categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
        sources: [
          {
            id: 'JTWC',
            url: 'https://www.metoc.navy.mil/jtwc/products/ep2226.tcw',
          },
        ],
      },
      { type: 'Point', coordinates: [-104.1, 14.8] },
    ),
    eonetFeature(
      {
        id: 'EONET_25589',
        title: 'Hurricane Vance',
        date: '2026-10-22T12:00:00Z',
        magnitudeValue: 80.0,
        magnitudeUnit: 'kts',
        categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
        sources: [],
      },
      { type: 'Point', coordinates: [-102.0, 12.0] },
    ),
    // An iceberg drift track: the current position is the last vertex.
    eonetFeature(
      {
        id: 'EONET_6474',
        title: 'Iceberg D35',
        categories: [{ id: 'seaLakeIce', title: 'Sea and Lake Ice' }],
        sources: [{ id: 'NATICE', url: 'http://www.natice.noaa.gov/' }],
        geometryDates: [
          '2026-09-18 00:00:00',
          '2026-10-09 00:00:00',
          '2026-10-15 00:00:00',
        ],
      },
      {
        type: 'LineString',
        coordinates: [
          [-41.2, -60.9],
          [-42.5, -60.4],
          [-43.77, -60.14],
        ],
      },
    ),
    // A volcanic area polygon.
    eonetFeature(
      {
        id: 'EONET_9001',
        title: 'Ash plume, Kanlaon Volcano',
        date: '2026-10-20T00:00:00Z',
        categories: [{ id: 'volcanoes', title: 'Volcanoes' }],
        sources: [{ id: 'SIVolcano', url: 'https://volcano.si.edu/' }],
      },
      {
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
    ),
    // Open ring: skipped.
    eonetFeature(
      {
        id: 'EONET_9002',
        title: 'Broken polygon',
        date: '2026-10-20T00:00:00Z',
        categories: [{ id: 'floods', title: 'Floods' }],
        sources: [],
      },
      {
        type: 'Polygon',
        coordinates: [
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 2],
          ],
        ],
      },
    ),
    // Missing id: skipped.
    eonetFeature(
      { id: '', title: 'No id', categories: [], sources: [] },
      { type: 'Point', coordinates: [1, 1] },
    ),
    // Closed event: skipped.
    eonetFeature(
      {
        id: 'EONET_9003',
        title: 'Closed event',
        closed: '2026-10-01T00:00:00Z',
        date: '2026-09-30T00:00:00Z',
        categories: [{ id: 'wildfires', title: 'Wildfires' }],
        sources: [],
      },
      { type: 'Point', coordinates: [5, 5] },
    ),
    // Latitude out of range: skipped.
    eonetFeature(
      {
        id: 'EONET_9004',
        title: 'Bad latitude',
        date: '2026-10-20T00:00:00Z',
        categories: [{ id: 'snow', title: 'Snow' }],
        sources: [],
      },
      { type: 'Point', coordinates: [5, 95] },
    ),
  ],
};
