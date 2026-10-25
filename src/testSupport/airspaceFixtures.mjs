// Hand-written fixtures modeled on the FAA TFR list (exportTfrList), the
// per-NOTAM XNOTAM download (/download/detail_<notam>.xml), the FAA NAS Status
// airport-status XML and the AWC airport lookup, shared by the Airspace tests.
// Not a test file: the unit runner only collects *.test.mjs. Expected values
// live in the tests, never here.
//
// The NAS Status samples are written from the feed's published DTD
// (nasstatus.faa.gov/AirportStatus.dtd): the live feed answered only with
// airport closures on the day the layer was built, so ground stops, ground
// delay programs and arrival/departure delays have no captured live payload.

/** The reference "now" of the fixtures: 11:00 UTC on 2026-10-25. */
export const NOW_MS = Date.parse('2026-10-25T11:00:00Z');

/** One `<Avx>` vertex: a position. */
export const grc = (lat, lon) =>
  `<Avx><codeDatum>WGE</codeDatum><codeType>GRC</codeType><geoLat>${lat}</geoLat><geoLong>${lon}</geoLong></Avx>`;

/** One `<Avx>` circle about a center with a radius in nautical miles. */
export const cir = (lat, lon, radiusNm) =>
  `<Avx><codeType>CIR</codeType><geoLat>${lat}</geoLat><geoLong>${lon}</geoLong><codeDatum>WGE</codeDatum><valRadiusArc>${radiusNm}</valRadiusArc><uomRadiusArc>NM</uomRadiusArc></Avx>`;

/** One `<Avx>` arc (CWA clockwise / CCA counter-clockwise) about a center. */
export const arc = (kind, centerLat, centerLon, radiusNm) =>
  `<Avx><codeDatum>WGE</codeDatum><codeType>${kind}</codeType><geoLatArc>${centerLat}</geoLatArc><geoLongArc>${centerLon}</geoLongArc><valRadiusArc>${radiusNm}</valRadiusArc><uomRadiusArc>NM</uomRadiusArc></Avx>`;

/**
 * One `<TFRAreaGroup>`: altitude limits on the `aseTFRArea`, the FAA's merged
 * polygon (`merged`: Avx strings) and the original shapes (`shapes`: Avx
 * strings, one `<Abd>` each).
 */
export function area({
  name,
  upper = 1000,
  lower = 0,
  upperCode = 'HEI',
  lowerCode = 'HEI',
  upperUnit = 'FT',
  lowerUnit = 'FT',
  scheduled = false,
  merged = null,
  shapes = [],
}) {
  return `<TFRAreaGroup>
  <aseTFRArea>
    <AseUid><codeType>RAS</codeType><codeId>1</codeId></AseUid>
    ${name ? `<txtName>${name}</txtName>` : ''}
    <codeDistVerUpper>${upperCode}</codeDistVerUpper>
    <valDistVerUpper>${upper}</valDistVerUpper>
    <uomDistVerUpper>${upperUnit}</uomDistVerUpper>
    <codeDistVerLower>${lowerCode}</codeDistVerLower>
    <valDistVerLower>${lower}</valDistVerLower>
    <uomDistVerLower>${lowerUnit}</uomDistVerLower>
    <isScheduledTfrArea>${scheduled ? 'TRUE' : 'FALSE'}</isScheduledTfrArea>
  </aseTFRArea>
  ${merged ? `<abdMergedArea><AbdUid/>${merged.join('')}</abdMergedArea>` : ''}
  ${shapes
    .map(
      (vertices) =>
        `<aseShapes><Abd><AbdUid/>${vertices.join('')}</Abd></aseShapes>`,
    )
    .join('\n')}
  <InstructionsGroup><txtInstr>NO PERSON MAY OPERATE</txtInstr></InstructionsGroup>
</TFRAreaGroup>`;
}

/** A whole XNOTAM document with one `Add/Not`. */
export function xnotam({
  seq,
  year = 2026,
  issued = '2026-10-25T02:46:47',
  effective,
  expire,
  zone = 'UTC',
  expireZone = zone,
  city = 'PAGOSA SPRINGS',
  state = 'COLORADO',
  facility = 'ZDV',
  regulation = '91.137(a)(2)',
  areas = [],
  text = '!FDC 6/2117 ZDV CO..AIRSPACE PAGOSA SPRINGS, CO..TEMPORARY FLIGHT RESTRICTIONS.',
}) {
  return `﻿<XNOTAM-Update xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" version="0.1" origin="" created="2026-10-24T21:56:21">
  <Group>
    <Add>
      <Not>
        <NotUid>
          <txtNameAcctFac>FDC</txtNameAcctFac>
          <dateIndexYear>${year}</dateIndexYear>
          <noSeqNo>${seq}</noSeqNo>
          <dateIssued>${issued}</dateIssued>
          <txtLocalName>6/${seq}</txtLocalName>
        </NotUid>
        <codeDailyOper>true</codeDailyOper>
        <dateEffective>${effective}</dateEffective>
        ${expire ? `<dateExpire>${expire}</dateExpire>` : ''}
        <codeTimeZone>${zone}</codeTimeZone>
        <codeExpirationTimeZone>${expireZone}</codeExpirationTimeZone>
        <AffLocGroup>
          <txtNameCity>${city}</txtNameCity>
          <txtNameUSState>${state}</txtNameUSState>
        </AffLocGroup>
        <codeFacility>${facility}</codeFacility>
        <TfrNot>
          <codeType>${regulation}</codeType>
          ${areas.join('\n')}
        </TfrNot>
        <txtDescrUSNS>${text}</txtDescrUSNS>
      </Not>
    </Add>
  </Group>
</XNOTAM-Update>`;
}

/** The list rows (as the FAA serves them), in list order. */
export const TFR_LIST = [
  {
    notam_id: '6/2117',
    type: 'HAZARDS',
    facility: 'ZDV',
    state: 'CO',
    description:
      'PAGOSA SPRINGS, CO, Sunday, October 25, 2026 through Sunday, November 1, 2026 UTC',
    creation_date: '10/25/2026',
  },
  {
    notam_id: '6/0100',
    type: 'SECURITY',
    facility: 'ZHU',
    state: 'TX',
    description: 'SOUTH PADRE ISLAND, TX, Saturday, October 24, 2026 Local',
    creation_date: '10/20/2026',
  },
  {
    notam_id: '6/1751',
    type: 'VIP',
    facility: 'ZAB',
    state: 'AZ',
    description: 'NOGALES, AZ, Sunday, October 25, 2026 Local',
    creation_date: '10/23/2026',
  },
  {
    notam_id: '6/2102',
    type: 'SECURITY',
    facility: 'ZTL',
    state: 'GA',
    description: 'ATLANTA, GA, Saturday, October 31, 2026 Local',
    creation_date: '10/24/2026',
  },
  {
    notam_id: '6/9954',
    type: 'SECURITY',
    facility: 'ZLA',
    state: 'AZ',
    description:
      'U.S. MEXICO BORDER, AZ, Tuesday, October 20, 2026 through Tuesday, October 19, 2027 UTC',
    creation_date: '10/16/2026',
  },
  {
    notam_id: '6/1500',
    type: 'AIR SHOWS/SPORTS',
    facility: 'ZKC',
    state: 'MO',
    description: 'KANSAS CITY, MO, Sunday, October 25, 2026 Local',
    creation_date: '10/22/2026',
  },
  {
    notam_id: '6/0001',
    type: 'HAZARDS',
    facility: 'ZOA',
    state: 'CA',
    description: 'SANTA ROSA, CA, Friday, October 23, 2026 Local',
    creation_date: '10/22/2026',
  },
  {
    notam_id: '6/0002',
    type: 'SPACE OPERATIONS',
    facility: 'ZJX',
    state: 'FL',
    description: 'CAPE CANAVERAL, FL, Monday, October 26, 2026 UTC',
    creation_date: '10/24/2026',
  },
];

/** Rows a list may carry that must be skipped. */
export const BAD_LIST_ROWS = [
  null,
  'text',
  { type: 'SECURITY' },
  { notam_id: '../../etc/passwd', type: 'SECURITY' },
  { notam_id: '6/2117', type: 'DUPLICATE OF THE FIRST ROW' },
  { notam_id: 'FDC 6/9999', type: 'SECURITY' },
];

// Real 6/2117 square (Pagosa Springs hazard area), 0 to 1,000 ft AGL.
const PAGOSA_SQUARE = [
  grc('37.45527778N', '107.39166667W'),
  grc('37.45527778N', '107.12472222W'),
  grc('37.00138889N', '107.13W'),
  grc('37.00138889N', '107.43638889W'),
  grc('37.45527778N', '107.39166667W'),
];

/** The XNOTAM downloads by NOTAM id. */
export const TFR_DETAILS = {
  // Merged polygon, UTC times, scheduled daily.
  '6/2117': xnotam({
    seq: 2117,
    effective: '2026-10-25T13:00:00',
    expire: '2026-11-01T01:00:00',
    areas: [
      area({
        name: 'Hazard Area1',
        scheduled: true,
        merged: PAGOSA_SQUARE,
        shapes: [PAGOSA_SQUARE],
      }),
    ],
  }),
  // A circle with a 1 NM radius and no merged polygon: built from the shape.
  '6/0100': xnotam({
    seq: 100,
    year: 2025,
    effective: '2026-10-24T23:30:00',
    zone: 'CDT',
    expire: '2026-10-26T04:00:00',
    expireZone: 'CDT',
    city: 'South Padre Island',
    state: 'TEXAS',
    facility: 'ZHU',
    regulation: '99.7',
    areas: [
      area({
        name: 'Area A',
        upper: 6000,
        shapes: [[cir('26.07194444N', '097.16361111W', '1.0')]],
      }),
    ],
  }),
  // A clockwise arc of 8 NM about (31.5775N, 110.34944W) from B to A, no merged polygon.
  '6/1751': xnotam({
    seq: 1751,
    effective: '2026-10-25T00:00:00',
    expire: '2026-10-26T00:00:00',
    zone: 'MST',
    expireZone: 'MST',
    city: 'NOGALES',
    state: 'ARIZONA',
    facility: 'ZAB',
    regulation: '91.141',
    areas: [
      area({
        upper: 17999,
        upperCode: 'ALT',
        lowerCode: 'ALT',
        shapes: [
          [
            grc('31.56805556N', '110.19333333W'),
            grc('31.58694444N', '110.50555556W'),
            arc('CWA', '31.5775N', '110.34944444W', '8.0'),
            grc('31.56805556N', '110.19333333W'),
          ],
        ],
      }),
    ],
  }),
  // EDT times; the merged polygon wins over a (different) circle shape.
  '6/2102': xnotam({
    seq: 2102,
    effective: '2026-10-31T21:00:00',
    expire: '2026-11-01T01:00:00',
    zone: 'EDT',
    expireZone: 'EDT',
    city: 'ATLANTA',
    state: 'GEORGIA',
    facility: 'ZTL',
    regulation: '99.7',
    areas: [
      area({
        upper: 3000,
        upperCode: 'ALT',
        merged: [
          grc('33.78N', '084.40W'),
          grc('33.78N', '084.36W'),
          grc('33.74N', '084.36W'),
          grc('33.74N', '084.40W'),
          grc('33.78N', '084.40W'),
        ],
        shapes: [[cir('40.0N', '100.0W', '30')]],
      }),
    ],
  }),
  // No geometry at all: a nationwide notice.
  '6/9954': xnotam({
    seq: 9954,
    effective: '2026-10-20T00:00:00',
    expire: '2027-10-19T23:59:00',
    city: 'U.S. MEXICO BORDER',
    state: 'ARIZONA',
    facility: 'ZLA',
    regulation: '99.7',
    areas: [
      `<TFRAreaGroup><aseTFRArea><codeDistVerUpper>HEI</codeDistVerUpper><valDistVerUpper>0</valDistVerUpper><uomDistVerUpper>FT</uomDistVerUpper></aseTFRArea><InstructionsGroup /></TFRAreaGroup>`,
    ],
  }),
  // Two areas: A has a merged polygon with MSL limits, B is a 5 NM circle with flight levels.
  '6/1500': xnotam({
    seq: 1500,
    effective: '2026-10-25T17:00:00',
    expire: '2026-10-25T23:00:00',
    city: 'KANSAS CITY',
    state: 'MISSOURI',
    facility: 'ZKC',
    regulation: '91.145',
    areas: [
      area({
        name: 'Area A',
        upper: 3500,
        upperCode: 'ALT',
        lower: 1000,
        lowerCode: 'ALT',
        merged: [
          grc('39.10N', '094.60W'),
          grc('39.10N', '094.50W'),
          grc('39.00N', '094.50W'),
          grc('39.00N', '094.60W'),
          grc('39.10N', '094.60W'),
        ],
      }),
      area({
        name: 'Area B',
        upper: 180,
        upperCode: 'ALT',
        upperUnit: 'FL',
        lower: 35,
        lowerCode: 'ALT',
        lowerUnit: 'FL',
        shapes: [[cir('39.30N', '094.55W', '5')]],
      }),
    ],
  }),
  // Expired two days ago.
  '6/0001': xnotam({
    seq: 1,
    effective: '2026-10-22T00:00:00',
    expire: '2026-10-23T06:00:00',
    areas: [
      area({
        merged: [
          grc('38.5N', '122.8W'),
          grc('38.5N', '122.7W'),
          grc('38.4N', '122.7W'),
          grc('38.4N', '122.8W'),
          grc('38.5N', '122.8W'),
        ],
      }),
    ],
  }),
  // A zone the table does not know: the times are unknown, the area is kept.
  '6/0002': xnotam({
    seq: 2,
    effective: '2026-10-26T01:00:00',
    expire: '2026-10-26T03:00:00',
    zone: 'ATLANTIS',
    regulation: '91.137(a)(1)',
    areas: [
      area({
        merged: [
          grc('28.5N', '080.7W'),
          grc('28.5N', '080.5W'),
          grc('28.3N', '080.5W'),
          grc('28.3N', '080.7W'),
          grc('28.5N', '080.7W'),
        ],
      }),
    ],
  }),
};

// ---------------------------------------------------------------------------
// NAS Status
// ---------------------------------------------------------------------------

/**
 * A status document modeled on the DTD: a ground delay program (EWR), a
 * ground stop and an arrival/departure delay at the same airport (JFK), a
 * departure-only delay (ORD), an Hawaii closure (HNL), an unresolvable code
 * (ZZZ), a CTOP list (ignored) and two closures at one airport (ASE).
 */
export const FAA_STATUS_XML = `<AIRPORT_STATUS_INFORMATION>
<Update_Time>Sun Oct 25 10:55:03 2026 GMT</Update_Time>
<Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File>
<Delay_type>
  <Name>Ground Delay Programs</Name>
  <Ground_Delay_List>
    <Ground_Delay>
      <ARPT>EWR</ARPT>
      <Reason>thunderstorms</Reason>
      <Avg>1 hour and 30 minutes</Avg>
      <Max>3 hours and 4 minutes</Max>
    </Ground_Delay>
  </Ground_Delay_List>
</Delay_type>
<Delay_type>
  <Name>Ground Stop Programs</Name>
  <Ground_Stop_List>
    <Program>
      <ARPT>JFK</ARPT>
      <Reason>low ceilings &amp; fog</Reason>
      <End_Time>3:15 pm EDT</End_Time>
    </Program>
  </Ground_Stop_List>
</Delay_type>
<Delay_type>
  <Name>Arrival/Departure Delay Info</Name>
  <Arrival_Departure_Delay_List>
    <Delay>
      <ARPT>JFK</ARPT>
      <Reason>WEATHER / LOW CEILINGS</Reason>
      <Arrival_Departure Type="Arrival">
        <Min>31 minutes</Min>
        <Max>45 minutes</Max>
        <Trend>Increasing</Trend>
      </Arrival_Departure>
    </Delay>
    <Delay>
      <ARPT>ORD</ARPT>
      <Reason>TM Initiatives:MIT:VOLUME</Reason>
      <Arrival_Departure Type="Departure">
        <Min>46 minutes</Min>
        <Max>1 hour</Max>
        <Trend>Steady</Trend>
      </Arrival_Departure>
    </Delay>
    <Delay>
      <ARPT>ZZZ</ARPT>
      <Reason>VOLUME</Reason>
      <Arrival_Departure Type="Departure">
        <Min>16 minutes</Min>
        <Max>30 minutes</Max>
        <Trend>Decreasing</Trend>
      </Arrival_Departure>
    </Delay>
  </Arrival_Departure_Delay_List>
</Delay_type>
<Delay_type>
  <Name>Airport Closures</Name>
  <Airport_Closure_List>
    <Airport>
      <ARPT>HNL</ARPT>
      <Reason>!HNL 10/050 HNL RWY 8R/26L CLSD 2610250900-2610251500</Reason>
      <Start>Oct 25 at 09:00 UTC.</Start>
      <Reopen>Oct 25 at 15:00 UTC.</Reopen>
    </Airport>
    <Airport>
      <ARPT>ASE</ARPT>
      <Reason>!ASE 10/220 ASE AD AP CLSD EXC LIFE FLT HEL AND SAR HEL 30MIN PPR 970-379-8406 2610250500-2610251300</Reason>
      <Start>Oct 25 at 05:00 UTC.</Start>
      <Reopen>Oct 25 at 13:00 UTC.</Reopen>
    </Airport>
    <Airport>
      <ARPT>ASE</ARPT>
      <Reason>!ASE 10/221 ASE AD APRON CLSD</Reason>
      <Start>Dec 31 at 23:00 UTC.</Start>
      <Reopen>Jan 02 at 06:00 UTC.</Reopen>
    </Airport>
  </Airport_Closure_List>
</Delay_type>
<Delay_type>
  <Name>Collaborative Trajectory Options Program</Name>
  <CTOP_List>
    <CTOP>
      <Program_Name>CTOP ZNY</Program_Name>
      <Reason>weather</Reason>
      <CTOP_Start_Time>1500</CTOP_Start_Time>
      <CTOP_End_Time>2100</CTOP_End_Time>
      <Avg>20 minutes</Avg>
      <FCA_Data/>
    </CTOP>
  </CTOP_List>
</Delay_type>
</AIRPORT_STATUS_INFORMATION>`;

/** The real shape of a quiet day: only closures, as captured from the live feed. */
export const FAA_STATUS_CLOSURES_ONLY_XML = `<AIRPORT_STATUS_INFORMATION><Update_Time>Sun Oct 25 08:49:58 2026 GMT</Update_Time><Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File><Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>LAX</ARPT><Reason>!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC ATLANTIC AVIATION 310-258-9884 2605271826-2705281600</Reason><Start>May 27 at 18:26 UTC.</Start><Reopen>May 28 at 16:00 UTC.</Reopen></Airport></Airport_Closure_List></Delay_type></AIRPORT_STATUS_INFORMATION>`;

/** A day with nothing to report. */
export const FAA_STATUS_EMPTY_XML = `<AIRPORT_STATUS_INFORMATION><Update_Time>Sun Oct 25 08:49:58 2026 GMT</Update_Time><Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File></AIRPORT_STATUS_INFORMATION>`;

// ---------------------------------------------------------------------------
// AWC airport lookup
// ---------------------------------------------------------------------------

const airport = (icaoId, faaId, name, lat, lon) => ({
  icaoId,
  iataId: faaId,
  faaId,
  name,
  state: 'XX',
  country: 'US',
  source: 'FAA',
  type: 'ARP',
  lat,
  lon,
  elev: 10,
  runways: [
    { id: '04/22', dimension: '8000x150', surface: 'C', alignment: 40 },
  ],
});

/** The airports the AWC lookup knows, by ICAO id. */
export const AWC_AIRPORTS = {
  KEWR: airport(
    'KEWR',
    'EWR',
    'NEWARK/NEWARK LIBERTY INTL ',
    40.6925,
    -74.1687,
  ),
  KJFK: airport(
    'KJFK',
    'JFK',
    'NEW YORK/JOHN F KENNEDY INTL ',
    40.6399,
    -73.7787,
  ),
  KORD: airport(
    'KORD',
    'ORD',
    "CHICAGO/CHICAGO O'HARE INTL ",
    41.9786,
    -87.9048,
  ),
  KASE: airport(
    'KASE',
    'ASE',
    'ASPEN/ASPEN-PITKIN COUNTY/SARDY FLD ',
    39.2219,
    -106.8682,
  ),
  KLAX: airport(
    'KLAX',
    'LAX',
    'LOS ANGELES/LOS ANGELES INTL ',
    33.9425,
    -118.408,
  ),
  PHNL: airport(
    'PHNL',
    'HNL',
    'HONOLULU/DANIEL K INOUYE INTL ',
    21.3178,
    -157.9203,
  ),
};
