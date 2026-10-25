// Hand-written upstream payloads for the Internet Outages & Data Centers
// tests, modeled on the shape of real IODA alert and PeeringDB facility
// responses (docs/KEYLESS-FEEDS.md). Not a test file: the unit runner only
// collects *.test.mjs. Every expectation in the tests is written out by hand;
// the times here are literal epoch seconds with their ISO form in a comment.

/** The test clock: 2026-10-25T12:00:00Z. */
export const NOW_MS = 1792929600000;
export const NOW_S = 1792929600;

/** Epoch seconds the fixtures use, each with the hour it stands for. */
export const T = Object.freeze({
  // 2026-10-17T04:00:00Z (200 h before NOW)
  d8: 1792209600,
  // 2026-10-21T08:00:00Z (100 h before NOW)
  d4: 1792569600,
  // 2026-10-24T06:00:00Z (30 h before NOW)
  h30: 1792821600,
  // 2026-10-24T07:00:00Z (29 h before NOW)
  h29: 1792825200,
  // 2026-10-24T16:00:00Z (20 h before NOW)
  h20: 1792857600,
  // 2026-10-24T16:15:00Z (19.75 h before NOW)
  h1945: 1792858500,
  // 2026-10-25T02:00:00Z (10 h before NOW)
  h10: 1792893600,
  // 2026-10-25T07:00:00Z (5 h before NOW)
  h5: 1792911600,
  // 2026-10-25T08:30:00Z (3.5 h before NOW)
  h35: 1792917000,
  // 2026-10-25T09:00:00Z (3 h before NOW)
  h3: 1792918800,
  // 2026-10-25T10:00:00Z (2 h before NOW)
  h2: 1792922400,
  // 2026-10-25T11:00:00Z (1 h before NOW)
  h1: 1792926000,
});

/** One IODA country alert. */
export function countryAlert(code, name, datasource, level, time, extra = {}) {
  return {
    datasource,
    entity: {
      code,
      name,
      subnames: [],
      type: 'country',
      attrs: { fqid: `geo.netacuity.XX.${code}` },
    },
    time,
    level,
    condition: level === 'normal' ? 'normal' : '< 0.99',
    value: level === 'normal' ? 120 : 90,
    historyValue: 120,
    method: 'median',
    ...extra,
  };
}

/** One IODA region alert (the region's code is IODA's own numeric id). */
export function regionAlert(
  id,
  name,
  countryCode,
  countryName,
  datasource,
  level,
  time,
) {
  return {
    datasource,
    entity: {
      code: String(id),
      name,
      subnames: [],
      type: 'region',
      attrs: {
        fqid: `geo.netacuity.XX.${countryCode}.${id}`,
        country_code: countryCode,
        country_name: countryName,
        ne_region_id: String(id + 1),
      },
    },
    time,
    level,
    condition: level === 'normal' ? 'normal' : '< 0.99',
    value: 50,
    historyValue: 60,
    method: 'median',
  };
}

/** An IODA alert-list response around `data`. */
export function alertsPayload(data, entityType = 'country') {
  return {
    type: 'outages.alerts',
    metadata: {
      requestTime: '2026-10-25T12:00:00+00:00',
      responseTime: '2026-10-25T12:00:01+00:00',
    },
    requestParameters: { entityType, limit: 5000 },
    error: null,
    perf: null,
    data,
  };
}

/**
 * The country alerts (the 14-day list): signals going, recovered, quiet and
 * unusable, in the order IODA lists them (oldest first).
 */
export const COUNTRY_ALERTS = Object.freeze([
  // Barbados: a BGP outage that opened 8 days ago and never closed.
  countryAlert('BB', 'Barbados', 'bgp', 'critical', T.d8),
  // Timor-Leste: out 4 days ago, back 30 h ago, out again 5 h ago (the
  // outage started at the LAST run, 07:00Z), plus a probing signal that went
  // critical at 08:30Z and eased to warning at 10:00Z.
  countryAlert('TL', 'Timor-Leste', 'bgp', 'critical', T.d4),
  countryAlert('TL', 'Timor-Leste', 'bgp', 'normal', T.h30),
  countryAlert('TL', 'Timor-Leste', 'ping-slash24', 'critical', T.h35),
  countryAlert('TL', 'Timor-Leste', 'bgp', 'critical', T.h5),
  countryAlert('TL', 'Timor-Leste', 'ping-slash24', 'warning', T.h2),
  // Ethiopia: recovered 29 h ago, outside the 24-hour window.
  countryAlert('ET', 'Ethiopia', 'bgp', 'critical', T.h30),
  countryAlert('ET', 'Ethiopia', 'bgp', 'normal', T.h29),
  // Nigeria: recovered 19.75 h ago.
  countryAlert('NG', 'Nigeria', 'bgp', 'critical', T.h20),
  countryAlert('NG', 'Nigeria', 'bgp', 'normal', T.h1945),
  // Venezuela: only ever normal.
  countryAlert('VE', 'Venezuela', 'bgp', 'normal', T.h10),
  // Norfolk Island: critical 5 h ago, normal 4 h ago, critical again 1 h ago.
  countryAlert('NF', 'Norfolk Island', 'gtr', 'critical', T.h5),
  countryAlert('NF', 'Norfolk Island', 'gtr', 'normal', 1792915200),
  countryAlert('NF', 'Norfolk Island', 'gtr', 'critical', T.h1),
  // Denmark: probing dropped at 08:30Z and recovered at 09:00Z.
  countryAlert('DK', 'Denmark', 'ping-slash24', 'critical', T.h35),
  countryAlert('DK', 'Denmark', 'ping-slash24', 'normal', T.h3),
  // Cameroon: a warning-level BGP drop since 10:00Z.
  countryAlert('CM', 'Cameroon', 'bgp', 'warning', T.h2),
  // IODA's placeholder for addresses it cannot place: no position.
  countryAlert('AP', 'Asia (Unknown Country)', 'bgp', 'critical', T.h1),
]);

/** Country alerts that must each be skipped without hurting the rest. */
export const BAD_COUNTRY_ALERTS = Object.freeze([
  null,
  'alert',
  { datasource: 'bgp', level: 'critical', time: T.h1 },
  // Not an ISO code, and a region entity inside a country list.
  countryAlert('ZZZ', 'Nowhere', 'bgp', 'critical', T.h1),
  countryAlert('xx1', 'Bad', 'bgp', 'critical', T.h1),
  regionAlert(900, 'Somewhere', 'SE', 'Sweden', 'bgp', 'critical', T.h1),
  // Unusable signal, level, or time.
  countryAlert('SE', 'Sweden', 'BGP', 'critical', T.h1),
  countryAlert('SE', 'Sweden', 'bgp', 'severe', T.h1),
  countryAlert('SE', 'Sweden', 'bgp', 'critical', 'soon'),
  countryAlert('SE', 'Sweden', 'bgp', 'critical', 0),
  countryAlert('SE', 'Sweden', 'bgp', 'critical', NaN),
  // Stamped two hours after NOW: a clock error.
  countryAlert('SE', 'Sweden', 'bgp', 'critical', NOW_S + 7200),
]);

/** The country alert list as IODA would answer. */
export const countryPayload = (extra = []) =>
  alertsPayload([...COUNTRY_ALERTS, ...extra], 'country');

/**
 * The region alerts (24 hours): Kano (Nigeria) is down although Nigeria as a
 * whole recovered, Dili and Baucau are down inside Timor-Leste, Liepāja is
 * down in Latvia, which has no country alert at all.
 */
export const REGION_ALERTS = Object.freeze([
  regionAlert(2954, 'Kano', 'NG', 'Nigeria', 'bgp', 'critical', T.h2),
  regionAlert(4047, 'Dili', 'TL', 'Timor-Leste', 'bgp', 'critical', T.h1),
  regionAlert(
    4048,
    'Baucau',
    'TL',
    'Timor-Leste',
    'ping-slash24',
    'warning',
    T.h2,
  ),
  regionAlert(2352, 'Liepāja', 'LV', 'Latvia', 'bgp', 'critical', T.h1),
  // A region that came back is not drawn.
  regionAlert(2400, 'Riga', 'LV', 'Latvia', 'bgp', 'critical', T.h3),
  regionAlert(2400, 'Riga', 'LV', 'Latvia', 'bgp', 'normal', T.h2),
  // Placeholder country: no position.
  regionAlert(7000, 'Unknown Region', 'EU', 'Europe', 'bgp', 'critical', T.h1),
]);

export const regionPayload = (extra = []) =>
  alertsPayload([...REGION_ALERTS, ...extra], 'region');

/** One PeeringDB facility row with every requested field. */
export function facilityRow(id, extra = {}) {
  return {
    id,
    org_name: 'Example Colo Inc.',
    name: `Example Interconnect DC${id}`,
    website: 'https://colo.example/',
    net_count: 10,
    ix_count: 1,
    status: 'ok',
    city: 'Ashburn',
    country: 'US',
    latitude: 39.0164,
    longitude: -77.459,
    ...extra,
  };
}

/** Facilities the normalizer must keep, in list order. */
export const GOOD_FACILITIES = Object.freeze([
  facilityRow(1, {
    name: 'Example Interconnect DC1 - Ashburn',
    website: 'http://colo.example/',
    net_count: 523,
    ix_count: 9,
  }),
  facilityRow(2, {
    org_name: 'Sample Hosting Ltd',
    name: 'Sample Hosting SYD1',
    city: 'Sydney',
    country: 'AU',
    latitude: -33.9,
    longitude: 151.2,
    website: 'https://hosting.example/path?x=1',
    net_count: 44,
    ix_count: 2,
  }),
  // Latitude 0 is a real position (an equatorial site), not "no answer".
  facilityRow(4, {
    org_name: '',
    name: 'Equator Exchange',
    city: 'Kisangani',
    country: 'CD',
    latitude: 0,
    longitude: 25.5,
    website: '',
    net_count: 3,
    ix_count: 0,
  }),
  // Longitude 0 is the Greenwich meridian.
  facilityRow(7, {
    name: 'Meridian House',
    city: 'London',
    country: 'GB',
    latitude: 51.4779,
    longitude: 0,
    website: 'ftp://colo.example/',
  }),
  facilityRow(9, {
    name: 'Counts Unknown',
    city: null,
    country: 'zz9',
    net_count: null,
    ix_count: -1,
    website: 'javascript:alert(1)',
  }),
]);

/** Facilities the normalizer must skip, each for one reason. */
export const BAD_FACILITIES = Object.freeze([
  // PeeringDB's unplaced facilities: null latitude and longitude. Guard.
  facilityRow(3, { latitude: null, longitude: null }),
  facilityRow(5, { latitude: null }),
  facilityRow(6, { latitude: 0, longitude: 0 }),
  facilityRow(8, { latitude: 91 }),
  facilityRow(10, { longitude: -181 }),
  facilityRow(11, { latitude: '39.0164' }),
  facilityRow(12, { latitude: Number.NaN }),
  facilityRow(13, { status: 'deleted' }),
  facilityRow(14, { name: '  ' }),
  facilityRow(15, { id: undefined, name: 'No id' }),
  facilityRow(16, { id: 0 }),
  facilityRow(17, { id: '17' }),
  null,
  5,
  // A repeated id keeps the first row only.
  facilityRow(1, { name: 'Impostor', latitude: -10, longitude: -10 }),
]);

/** Rows PeeringDB lists but cannot place, so a list passes the size floor. */
export function unplacedFacilities(count, firstId = 5000) {
  return Array.from({ length: count }, (_, index) =>
    facilityRow(firstId + index, { latitude: null, longitude: null }),
  );
}

/** A PeeringDB `/api/fac` response, padded past the size floor. */
export function facilityPayload(rows = GOOD_FACILITIES, pad = 1100) {
  return {
    data: [...rows, ...BAD_FACILITIES, ...unplacedFacilities(pad)],
    meta: { generated: 1792929000.5 },
  };
}
