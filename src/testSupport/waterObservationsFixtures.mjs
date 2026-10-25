// Hand-written fixtures for the Buoys & River Gauges layer, modeled on real
// NOAA NDBC latest_obs.txt and NWPS /nwps/v1/gauges payloads. Not a test file:
// the unit runner only collects *.test.mjs.

/** 2026-10-25T11:00:00.000Z, the "now" of every test. */
export const NOW_MS = Date.UTC(2026, 9, 25, 11, 0, 0);

export const NDBC_HEADER = [
  '#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE',
  '#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft',
];

/** NDBC text: the two header lines, then the given rows. */
export const ndbcText = (...rows) =>
  [...NDBC_HEADER, ...rows].join('\n') + '\n';

/** The rows that must become features, in file order. */
export const GOOD_BUOY_ROWS = Object.freeze([
  // Wind 13.0 m/s gusting 16.0, 2.4 m waves, pressure and air/dew temperature;
  // no water temperature (MM) and no pressure tendency.
  '41008    31.400  -80.866 2026 10 25 10 50  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  // Gulf of Guinea buoy at 0.000 N: a real position even with latitude 0.
  '15009     0.000   -3.051 2026 10 25 06 00 160   5.0    MM   MM  MM   MM  MM 1011.3    MM  26.6  27.4    MM   MM     MM',
  // Calm: 0.0 m/s is a reading, not a missing value. East longitude.
  '22108    36.250  125.750 2026 10 25 10 00  20   0.0    MM  0.5   0   MM  MM     MM    MM  18.8  19.8    MM   MM     MM',
  // No anemometer reading at all; waves, tendency and a tide gauge instead.
  '41004    32.502  -79.099 2026 10 25 10 40  MM    MM    MM  2.8   7  5.6  64 1024.8  +0.0  21.0    MM  17.4  1.6   0.57',
  // Falling pressure.
  'BURL1    28.905  -89.428 2026 10 25 10 30 350  21.0  26.0  1.2   5  4.1 330  998.4  -1.8  24.3  26.1  23.9  8.7     MM',
]);

/** Rows each skipped for a different reason; none may become a feature. */
export const BAD_BUOY_ROWS = Object.freeze({
  shortId:
    'AB       31.400  -80.866 2026 10 25 10 50  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  badLat:
    '41111    95.000  -80.866 2026 10 25 10 50  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  badLon:
    '41112    31.400  181.500 2026 10 25 10 50  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  nanLat:
    '41113      abc  -80.866 2026 10 25 10 50  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  nullIsland:
    '41114     0.000    0.000 2026 10 25 10 50  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  badMonth:
    '41115    31.400  -80.866 2026 13 25 10 50  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  feb31:
    '41116    31.400  -80.866 2026 02 31 10 50  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  tooOld:
    '41117    31.400  -80.866 2026 10 25 04 00  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  future:
    '41118    31.400  -80.866 2026 10 25 13 30  30  13.0  16.0  2.4   7  5.4  76 1023.2    MM  21.0    MM  19.4   MM     MM',
  allMissing:
    '41119    31.400  -80.866 2026 10 25 10 50  MM    MM    MM   MM  MM   MM  MM     MM    MM    MM    MM    MM   MM     MM',
  shortRow: '41120    31.400  -80.866 2026 10 25 10 50  30  13.0',
});

/** An NWPS gauge as the list endpoint serves it. */
function gauge({
  lid,
  name,
  state = 'FL',
  lat,
  lon,
  observed = {},
  forecast = {},
}) {
  return {
    lid,
    name,
    rfc: { abbreviation: 'SERFC', name: 'Southeast River Forecast Center' },
    wfo: { abbreviation: 'JAX', name: 'Jacksonville' },
    state: { abbreviation: state, name: 'State' },
    latitude: lat,
    longitude: lon,
    pedts: { observed: 'HGIRG', forecast: 'HGIFF' },
    status: {
      observed: {
        primary: -999,
        primaryUnit: 'ft',
        secondary: -999,
        secondaryUnit: 'kcfs',
        floodCategory: 'no_flooding',
        validTime: '2026-10-25T10:30:00Z',
        ...observed,
      },
      forecast: {
        primary: -999,
        primaryUnit: '',
        secondary: -999,
        secondaryUnit: '',
        floodCategory: 'fcst_not_current',
        validTime: '0001-01-01T00:00:00Z',
        ...forecast,
      },
    },
  };
}

/** Gauges that must become features, in lid order of appearance. */
export const FLOOD_GAUGES = Object.freeze([
  // Observed moderate flooding, forecast to stay there.
  gauge({
    lid: 'ASTF1',
    name: 'St. Johns River at Astor',
    lat: 29.166666666667,
    lon: -81.522222222222,
    observed: {
      primary: 3.34,
      floodCategory: 'moderate',
      validTime: '2026-10-25T10:30:00Z',
    },
    forecast: {
      primary: 3.6,
      primaryUnit: 'ft',
      floodCategory: 'moderate',
      validTime: '2026-10-26T12:00:00Z',
    },
  }),
  // Action stage with a flow reading in kcfs.
  gauge({
    lid: 'ATKG1',
    name: 'Satilla River at Atkinson',
    state: 'GA',
    lat: 31.2205555555556,
    lon: -81.8675,
    observed: {
      primary: 12.89,
      secondary: 5.24,
      floodCategory: 'action',
      validTime: '2026-10-25T10:45:00Z',
    },
    forecast: {
      primary: 12.9,
      primaryUnit: 'ft',
      secondary: 5.26,
      secondaryUnit: 'kcfs',
      floodCategory: 'action',
      validTime: '2026-10-25T12:00:00Z',
    },
  }),
  // Not flooding yet; the forecast reaches minor flooding.
  gauge({
    lid: 'HYPO1',
    name: 'Example Creek at Hypothetical',
    state: 'OH',
    lat: 40.5,
    lon: -82.7,
    observed: { primary: 8.1, floodCategory: 'no_flooding' },
    forecast: {
      primary: 11.2,
      primaryUnit: 'ft',
      floodCategory: 'minor',
      validTime: '2026-10-26T06:00:00Z',
    },
  }),
  // A gauge that reports flow as its primary reading.
  gauge({
    lid: 'KCFS2',
    name: 'Flow-first River near Anchorage',
    state: 'AK',
    lat: 61.2,
    lon: -149.9,
    observed: {
      primary: 41.5,
      primaryUnit: 'kcfs',
      secondary: 16.25,
      secondaryUnit: 'ft',
      floodCategory: 'major',
      validTime: '2026-10-25T10:00:00Z',
    },
  }),
  // On a tile boundary (west = -90): the upstream lists it in two tiles.
  gauge({
    lid: 'EDGE1',
    name: 'Boundary River at Edge',
    state: 'IL',
    lat: 40,
    lon: -90,
    observed: { primary: 15, floodCategory: 'minor' },
  }),
  // Hawaii.
  gauge({
    lid: 'HNLH1',
    name: 'Stream at Honolulu',
    state: 'HI',
    lat: 21.3,
    lon: -157.8,
    observed: { primary: 5.5, floodCategory: 'action' },
  }),
]);

/** Gauges that must not become features. */
export const OTHER_GAUGES = Object.freeze([
  gauge({
    lid: 'AACS2',
    name: 'Cheyenne River above Angostura at Hwy 71',
    state: 'SD',
    lat: 43.30577,
    lon: -103.562797,
    observed: { primary: 3199.62, floodCategory: 'no_flooding' },
  }),
  gauge({
    lid: 'LOWL1',
    name: 'Low Water Bayou',
    state: 'LA',
    lat: 30.1,
    lon: -91.2,
    observed: { primary: 0.4, floodCategory: 'low_threshold' },
  }),
  gauge({
    lid: 'STAL1',
    name: 'Stale Gauge',
    state: 'LA',
    lat: 30.3,
    lon: -91.4,
    observed: {
      primary: -999,
      floodCategory: 'obs_not_current',
      validTime: '0001-01-01T00:00:00Z',
    },
  }),
  // Flooding but published at 0,0: no usable position.
  gauge({
    lid: 'ZERO1',
    name: 'Gauge With No Position',
    state: 'MT',
    lat: 0,
    lon: 0,
    observed: { floodCategory: 'action' },
  }),
  // Flooding with an impossible latitude.
  gauge({
    lid: 'BADLA',
    name: 'Gauge With Bad Latitude',
    state: 'MT',
    lat: 123.4,
    lon: -110.2,
    observed: { floodCategory: 'minor' },
  }),
]);

/** `count` gauges that are not flooding, spread over the contiguous US. */
export function fillerGauges(count) {
  return Array.from({ length: count }, (_, index) =>
    gauge({
      lid: `F${String(index).padStart(4, '0')}`,
      name: `Filler ${index}`,
      lat: 30 + (index % 15),
      lon: -120 + (index % 40),
    }),
  );
}

/** Gauges every test "universe" lists: the flooding ones, the rest, and filler. */
export const ALL_GAUGES = Object.freeze([
  ...FLOOD_GAUGES,
  ...OTHER_GAUGES,
  ...fillerGauges(1100),
]);

/**
 * The NWPS answer for one tile URL: the gauges of `universe` whose position
 * lies inside the bbox query (edges included, as the service does).
 */
export function nwpsTilePayload(url, universe = ALL_GAUGES) {
  const query = new URL(url).searchParams;
  const [west, south, east, north] = [
    'bbox.xmin',
    'bbox.ymin',
    'bbox.xmax',
    'bbox.ymax',
  ].map((key) => Number(query.get(key)));
  return {
    gauges: universe.filter(
      (entry) =>
        entry.longitude >= west &&
        entry.longitude <= east &&
        entry.latitude >= south &&
        entry.latitude <= north,
    ),
  };
}

/** The ids the flooding gauges normalize to, in fixture order. */
export const FLOOD_GAUGE_IDS = Object.freeze(FLOOD_GAUGES.map((g) => g.lid));
