// Hand-written Smithsonian GVP and USGS Volcano Hazards payloads for the
// Volcanoes tests, modeled on real responses (GVP-VOTW WFS
// E3WebApp_Eruptions1960 with CQL_FILTER ContinuingEruption='True', and the
// USGS volcanoApi/vhpstatus list, October 2026) and trimmed to the fields used.
// Kilauea and Great Sitkin are in both feeds; Shishaldin and Ahyi Seamount are
// USGS-only; Nyamulagira, Langila and Yasur are GVP-only; Akutan is a USGS
// NORMAL volcano and Adagdak an unmonitored one.

const gvpFeature = (properties, coordinates) => ({
  type: 'Feature',
  id: `E3WebApp_Eruptions1960.fid-test_${properties.Activity_ID}`,
  geometry: { type: 'Point', coordinates },
  geometry_name: 'GeoLocation',
  properties: {
    EndDate: '20260325',
    EndDateYear: 2026,
    EndDateMonth: 3,
    EndDateDay: 25,
    ContinuingEruption: 'True',
    LatitudeDecimal: coordinates[1],
    LongitudeDecimal: coordinates[0],
    ...properties,
  },
});

/** GVP continuing eruptions (the WFS response, 6 records for 5 volcanoes). */
export const gvpEruptions = {
  type: 'FeatureCollection',
  totalFeatures: 6,
  numberMatched: 6,
  numberReturned: 6,
  timeStamp: '2026-10-25T08:51:07.372Z',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::4326' } },
  features: [
    gvpFeature(
      {
        VolcanoNumber: 332010,
        VolcanoName: 'Kilauea',
        ExplosivityIndexMax: 1,
        StartDate: '20241223',
        StartDateYear: 2024,
        StartDateMonth: 12,
        StartDateDay: 23,
        Activity_ID: 22597,
      },
      [-155.287, 19.421],
    ),
    gvpFeature(
      {
        VolcanoNumber: 311120,
        VolcanoName: 'Great Sitkin',
        ExplosivityIndexMax: 2,
        StartDate: '20210525',
        StartDateYear: 2021,
        StartDateMonth: 5,
        StartDateDay: 25,
        Activity_ID: 22401,
      },
      [-176.13, 52.076],
    ),
    gvpFeature(
      {
        VolcanoNumber: 223020,
        VolcanoName: 'Nyamulagira',
        ExplosivityIndexMax: 0,
        StartDate: '20180414',
        StartDateYear: 2018,
        StartDateMonth: 4,
        StartDateDay: 14,
        Activity_ID: 22315,
      },
      [29.2, -1.408],
    ),
    // A second, earlier open record for the same volcano: the later start wins.
    gvpFeature(
      {
        VolcanoNumber: 223020,
        VolcanoName: 'Nyamulagira',
        ExplosivityIndexMax: 2,
        StartDate: '20100106',
        StartDateYear: 2010,
        StartDateMonth: 1,
        StartDateDay: 6,
        Activity_ID: 20001,
      },
      [29.2, -1.408],
    ),
    gvpFeature(
      {
        VolcanoNumber: 252010,
        VolcanoName: 'Langila',
        ExplosivityIndexMax: 2,
        StartDate: '20151022',
        StartDateYear: 2015,
        StartDateMonth: 10,
        StartDateDay: 22,
        Activity_ID: 22123,
      },
      [148.42, -5.525],
    ),
    // Only a start year is known (a 1270 eruption): no date, no month.
    gvpFeature(
      {
        VolcanoNumber: 257100,
        VolcanoName: 'Yasur',
        ExplosivityIndexMax: 3,
        StartDate: null,
        StartDateYear: 1270,
        StartDateMonth: null,
        StartDateDay: null,
        Activity_ID: 15355,
      },
      [169.447, -19.532],
    ),
  ],
};

const usgsVolcano = (fields) => ({
  vImage: 'https://volcanoes.usgs.gov/vsc/images/test.jpg',
  statusIconUrl: 'https://volcanoes.usgs.gov/images/icons/map/test.png',
  nvewsThreat: 'High Threat',
  ...fields,
});

/** USGS vhpstatus list (a JSON array served as text/html), 6 volcanoes. */
export const usgsStatus = [
  usgsVolcano({
    vName: 'Kilauea',
    lat: 19.421,
    long: -155.287,
    vnum: '332010',
    volcanoCd: 'hi3',
    vUrl: 'https://www.usgs.gov/volcanoes/kilauea',
    obs: 'hvo',
    region: 'Hawaii',
    noticeId: 'DOI-USGS-HVO-2026-10-24T18:15:36+00:00',
    noticeSynopsis:
      "HVO Kilauea YELLOW/ADVISORY - The Halema'uma'u eruption of Kīlauea is currently paused after episode 55 fountaining ended on October 17. Summit reinflation continues today.",
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    alertDate: '2026-10-24 18:37:53',
    colorDate: '2026-10-24 18:37:53',
  }),
  usgsVolcano({
    vName: 'Great Sitkin',
    lat: 52.0765,
    long: -176.1109,
    vnum: '311120',
    volcanoCd: 'ak111',
    vUrl: 'https://www.avo.alaska.edu/activity/GreatSitkin.php',
    obs: 'avo',
    region: 'Aleutians',
    noticeId: 'DOI-USGS-AVO-2026-10-24T17:32:14+00:00',
    noticeSynopsis:
      'AVO Great Sitkin ORANGE/WATCH - Slow eruption of lava within the summit crater continues.',
    alertLevel: 'WATCH',
    colorCode: 'ORANGE',
    alertDate: '2026-10-24 18:28:00',
    colorDate: '2026-10-24 18:28:00',
  }),
  usgsVolcano({
    vName: 'Shishaldin',
    lat: 54.7554,
    long: -163.9711,
    vnum: '311360',
    volcanoCd: 'ak252',
    vUrl: 'https://avo.alaska.edu/activity/Shishaldin.php',
    obs: 'avo',
    region: 'Aleutians',
    noticeId: 'DOI-USGS-AVO-2026-10-24T17:32:14+00:00',
    noticeSynopsis:
      'AVO Shishaldin YELLOW/ADVISORY - Low-level unrest continues.',
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    alertDate: '2026-10-24 18:28:00',
    colorDate: '2026-10-24 18:28:00',
  }),
  usgsVolcano({
    vName: 'Ahyi Seamount',
    lat: 20.437,
    long: 145.03,
    vnum: '284141',
    volcanoCd: 'nmi2',
    vUrl: 'https://www.usgs.gov/volcanoes/ahyi-seamount',
    obs: 'nmi',
    region: 'Northern Mariana Islands',
    noticeId: 'DOI-USGS-NMI-2026-10-22T23:13:02+00:00',
    noticeSynopsis:
      'NMI Ahyi Seamount YELLOW/ADVISORY - Plumes of discolored water seen in satellite imagery; no significant geophysical signals.',
    alertLevel: 'ADVISORY',
    colorCode: 'YELLOW',
    alertDate: '2026-10-22 23:16:38',
    colorDate: '2026-10-22 23:16:38',
  }),
  // NORMAL / GREEN: monitored, nothing elevated. Excluded by default.
  usgsVolcano({
    vName: 'Akutan',
    lat: 54.13308,
    long: -165.98555,
    vnum: '311320',
    volcanoCd: 'ak6',
    vUrl: 'https://avo.alaska.edu/volcanoes/volcinfo.php?volcname=Akutan',
    obs: 'avo',
    region: 'Aleutians',
    noticeId: 'DOI-USGS-AVO-2019-09-04T15:47:55-08:00',
    noticeSynopsis:
      'AVO Akutan GREEN/NORMAL - Existing digital equipment refurbished with more robust digital installation',
    alertLevel: 'NORMAL',
    colorCode: 'GREEN',
    alertDate: '2019-09-06 18:29:39',
    colorDate: '2019-09-06 18:29:39',
  }),
  // UNASSIGNED: not monitored by an observatory. Always excluded.
  usgsVolcano({
    vName: 'Adagdak',
    lat: 51.9905,
    long: -176.5852,
    vnum: '311800',
    volcanoCd: 'ak3',
    vUrl: 'https://avo.alaska.edu/volcanoes/volcinfo.php?volcname=Adagdak',
    obs: 'avo',
    region: 'Aleutians',
    noticeId: null,
    noticeSynopsis: null,
    alertLevel: 'UNASSIGNED',
    colorCode: 'UNASSIGNED',
    alertDate: null,
    colorDate: null,
  }),
];
