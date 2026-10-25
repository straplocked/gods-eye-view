// Hand-written fixtures modeled on the AWC METAR cache CSV and the AWC
// SIGMET / AIRMET GeoJSON, shared by the Aviation Weather tests. Not a test
// file: the unit runner only collects *.test.mjs. Expected values live in the
// tests, never here.

/** The 44-column header of metars.cache.csv.gz (sky_cover/cloud_base repeat four times). */
export const METAR_HEADER =
  'raw_text,station_id,observation_time,latitude,longitude,temp_c,dewpoint_c,wind_dir_degrees,wind_speed_kt,wind_gust_kt,visibility_statute_mi,altim_in_hg,sea_level_pressure_mb,corrected,auto,auto_station,maintenance_indicator_on,no_signal,lightning_sensor_off,freezing_rain_sensor_off,present_weather_sensor_off,wx_string,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,sky_cover,cloud_base_ft_agl,flight_category,three_hr_pressure_tendency_mb,maxT_c,minT_c,maxT24hr_c,minT24hr_c,precip_in,pcp3hr_in,pcp6hr_in,pcp24hr_in,snow_in,vert_vis_ft,metar_type,elevation_m';

const COLUMNS = METAR_HEADER.split(',');

/** Quote a CSV field when it needs it. */
const quote = (value) =>
  /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

/**
 * One CSV line. `fields` maps a column name to its text; `sky` is up to four
 * [cover, base] pairs for the repeated sky_cover / cloud_base_ft_agl columns.
 */
export function metarRow(fields, sky = []) {
  const cells = COLUMNS.map(() => '');
  const put = (name, value) => {
    const index = COLUMNS.indexOf(name);
    if (index < 0) throw new Error(`unknown METAR column ${name}`);
    cells[index] = String(value);
  };
  for (const [name, value] of Object.entries(fields)) put(name, value);
  const coverAt = COLUMNS.map((name, i) =>
    name === 'sky_cover' ? i : -1,
  ).filter((i) => i >= 0);
  sky.forEach(([cover, base], i) => {
    cells[coverAt[i]] = cover;
    cells[coverAt[i] + 1] = String(base);
  });
  return cells.map(quote).join(',');
}

/** A cache file: header, then rows. */
export const metarCsv = (...rows) => [METAR_HEADER, ...rows].join('\n') + '\n';

/** The reference "now" of the fixtures: 11:00 UTC on 2026-10-25. */
export const NOW_MS = Date.parse('2026-10-25T11:00:00Z');

/** Seven valid stations (one per category case) in the order they appear in the file. */
export const GOOD_METAR_ROWS = [
  // VFR: the CSV says so.
  metarRow(
    {
      raw_text: 'METAR KSEA 251053Z 18008KT 10SM FEW040 BKN250 12/08 A3012',
      station_id: 'KSEA',
      observation_time: '2026-10-25T10:53:00.000Z',
      latitude: '47.4444',
      longitude: '-122.3138',
      temp_c: '12',
      dewpoint_c: '8',
      wind_dir_degrees: '180',
      wind_speed_kt: '8',
      visibility_statute_mi: '10+',
      altim_in_hg: '30.12',
      flight_category: 'VFR',
      metar_type: 'METAR',
    },
    [
      ['FEW', 4000],
      ['BKN', 25000],
    ],
  ),
  // IFR: the CSV says so (ceiling 600 ft BKN, 2 SM in mist, gusts).
  metarRow(
    {
      raw_text:
        'SPECI KCAG 251050Z AUTO 21005G15KT 2SM BR SCT002 BKN006 OVC100 02/02 A3021',
      station_id: 'KCAG',
      observation_time: '2026-10-25T10:50:00.000Z',
      latitude: '40.4952',
      longitude: '-107.5218',
      temp_c: '1.7',
      dewpoint_c: '1.7',
      wind_dir_degrees: '210',
      wind_speed_kt: '5',
      wind_gust_kt: '15',
      visibility_statute_mi: '2',
      altim_in_hg: '30.21',
      wx_string: 'BR',
      flight_category: 'IFR',
      metar_type: 'SPECI',
    },
    [
      ['SCT', 200],
      ['BKN', 600],
      ['OVC', 10000],
    ],
  ),
  // MVFR with a quoted raw text that contains a comma and a quote.
  metarRow(
    {
      raw_text:
        'METAR EGLL 251050Z 24012KT 6SM BKN025 14/10 Q1012 RMK "TEST", COMMA',
      station_id: 'EGLL',
      observation_time: '2026-10-25T10:50:00.000Z',
      latitude: '51.4775',
      longitude: '-0.4614',
      temp_c: '14',
      dewpoint_c: '10',
      wind_dir_degrees: '240',
      wind_speed_kt: '12',
      visibility_statute_mi: '6+',
      flight_category: 'MVFR',
      metar_type: 'METAR',
    },
    [['BKN', 2500]],
  ),
  // LIFR: vertical visibility (OVX 100 ft) in fog.
  metarRow(
    {
      raw_text: 'METAR KSRR 251035Z AUTO 17010KT 1/2SM FG VV001 09/09 A3027',
      station_id: 'KSRR',
      observation_time: '2026-10-25T10:35:00.000Z',
      latitude: '33.4667',
      longitude: '-105.5278',
      temp_c: '8.7',
      dewpoint_c: '8.7',
      wind_dir_degrees: '170',
      wind_speed_kt: '10',
      visibility_statute_mi: '0.5',
      wx_string: 'FG',
      flight_category: 'LIFR',
      vert_vis_ft: '1',
      metar_type: 'METAR',
    },
    [['OVX', 100]],
  ),
  // GUARD ROW: the CSV category is the literal text "null"; ceiling 800 ft, visibility 2 SM.
  metarRow(
    {
      raw_text: 'METAR LFPG 251030Z 05004KT 2SM BKN008 11/10 Q1015',
      station_id: 'LFPG',
      observation_time: '2026-10-25T10:30:00.000Z',
      latitude: '49.0097',
      longitude: '2.5479',
      temp_c: '11',
      dewpoint_c: '10',
      wind_dir_degrees: '50',
      wind_speed_kt: '4',
      visibility_statute_mi: '2',
      flight_category: 'null',
      metar_type: 'METAR',
    },
    [['BKN', 800]],
  ),
  // Empty category, clear and 10+ SM, calm wind: derived VFR.
  metarRow({
    raw_text: 'METAR PHNL 251053Z 00000KT 10SM CLR 27/20 A3005',
    station_id: 'PHNL',
    observation_time: '2026-10-25T10:53:00.000Z',
    latitude: '21.3245',
    longitude: '-157.9251',
    temp_c: '27',
    dewpoint_c: '20',
    wind_dir_degrees: '0',
    wind_speed_kt: '0',
    visibility_statute_mi: '10+',
    altim_in_hg: '30.05',
    flight_category: '',
    metar_type: 'METAR',
  }),
  // Visibility not reported and category "null": stays unknown.
  metarRow({
    raw_text: 'METAR KJDN 251048Z AUTO 09004KT M04/M07 A3030',
    station_id: 'KJDN',
    observation_time: '2026-10-25T10:48:00.000Z',
    latitude: '47.32591',
    longitude: '-106.94877',
    temp_c: '-4.4',
    dewpoint_c: '-6.7',
    wind_dir_degrees: '90',
    wind_speed_kt: '4',
    altim_in_hg: '30.30',
    flight_category: 'null',
    metar_type: 'METAR',
  }),
];

const polygon = (ring) => ({ type: 'Polygon', coordinates: [ring] });

/** A US airsigmet feature, with overrides merged over the properties. */
export function usAdvisory(overrides = {}, geometry) {
  return {
    type: 'Feature',
    properties: {
      icaoId: 'KKCI',
      airSigmetType: 'SIGMET',
      alphaChar: 'W',
      hazard: 'CONVECTIVE',
      seriesId: '15W',
      validTimeFrom: '2026-10-25T10:55:00.000Z',
      validTimeTo: '2026-10-25T12:55:00.000Z',
      severity: 5,
      altitudeHi1: 25000,
      altitudeHi2: 25000,
      altitudeLow1: null,
      altitudeLow2: null,
      movementDir: 190,
      movementSpd: 35,
      rawAirSigmet:
        'WSUS33 KKCI 251055\nMKCW WST 251055\nCONVECTIVE SIGMET 15W\nVALID UNTIL 1255Z\nAZ UT\nFROM 10N HVE-60S HVE-30NNW TBC-50S BCE\nAREA TS MOV LTL. TOPS TO FL250.',
      ...overrides,
    },
    geometry:
      geometry === undefined
        ? polygon([
            [-110.7, 38.586],
            [-110.7, 37.422],
            [-111.513, 36.579],
            [-112.3, 36.858],
            [-110.7, 38.586],
          ])
        : geometry,
  };
}

/** An international isigmet feature, with overrides merged over the properties. */
export function internationalAdvisory(overrides = {}, geometry) {
  return {
    type: 'Feature',
    properties: {
      icaoId: 'MMMD',
      firId: 'MMFR',
      firName: 'MMFO MAZATLAN OCEANICA',
      seriesId: '1',
      hazard: 'TURB',
      qualifier: 'SEV',
      validTimeFrom: '2026-10-25T10:00:00.000Z',
      validTimeTo: '2026-10-25T14:00:00.000Z',
      base: 25000,
      top: 38000,
      dir: 'NNW',
      spd: '4',
      chng: 'WKN',
      rawSigmet:
        'WSMX31 MMMD 251000\nMMID SIGMET 1 VALID 251000/251400 MMMX-\nMMFO MAZATLAN OCEANICA FIR SEV TURB FL250/380\nMOV NNW 04KT WKN.',
      ...overrides,
    },
    geometry:
      geometry === undefined
        ? polygon([
            [-104.5, 14.6],
            [-102.2, 13.0],
            [-101.9, 14.2],
            [-104.5, 14.6],
          ])
        : geometry,
  };
}

export const collection = (...features) => ({
  type: 'FeatureCollection',
  features,
});

/** Two valid US advisories (one convective SIGMET, one AIRMET with two altitude bands). */
export const usPayload = collection(
  usAdvisory(),
  usAdvisory(
    {
      airSigmetType: 'AIRMET',
      alphaChar: null,
      hazard: 'TURB',
      seriesId: 'SFOT',
      severity: null,
      altitudeLow1: 10000,
      altitudeHi1: 18000,
      altitudeLow2: 8000,
      altitudeHi2: 15000,
      rawAirSigmet:
        'WAUS46 KKCI 251045\nSFOT WA 251045\nAIRMET TURB...CA\nMOD TURB BTN FL080 AND FL180.',
    },
    polygon([
      [-123, 40],
      [-121, 40],
      [-121, 38],
      [-123, 38],
      [-123, 40],
    ]),
  ),
);

/** Two valid international advisories: a volcano ash cloud and a turbulence area over the date line. */
export const internationalPayload = collection(
  internationalAdvisory(),
  internationalAdvisory(
    {
      icaoId: 'NZKL',
      firId: 'NZZO',
      firName: 'NZZO AUCKLAND OCEANIC',
      seriesId: '18',
      hazard: 'VA',
      qualifier: 'FUEGO',
      base: 0,
      top: null,
      chng: 'NC',
    },
    // Longitudes past 180 use the 0..360 convention.
    polygon([
      [180.667, -57.5],
      [193.167, -55.167],
      [201.167, -48],
      [185, -45],
      [180.667, -57.5],
    ]),
  ),
);
