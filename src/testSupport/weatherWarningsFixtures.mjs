// Hand-written fixtures modeled on real api.weather.gov alerts/zones and the
// tsunami.gov Atom feeds (trimmed; not raw upstream captures). Not a test
// file: the unit runner only collects *.test.mjs.

export const NWS_ZONE_BASE = 'https://api.weather.gov/zones';
export const zoneUrl = (id, type = 'forecast') =>
  `${NWS_ZONE_BASE}/${type}/${id}`;

/** A closed axis-aligned square ring with its lower-left corner at [lon, lat]. */
export function squareRing(lon, lat, size = 1) {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ];
}

/**
 * The same square with `perSide` extra collinear vertices on every side,
 * like a surveyed county boundary: decimation must collapse them.
 */
export function noisySquareRing(lon, lat, size = 1, perSide = 20) {
  const ring = [];
  const side = (from, to) => {
    for (let i = 0; i < perSide; i++)
      ring.push([
        from[0] + ((to[0] - from[0]) * i) / perSide,
        from[1] + ((to[1] - from[1]) * i) / perSide,
      ]);
  };
  const a = [lon, lat];
  const b = [lon + size, lat];
  const c = [lon + size, lat + size];
  const d = [lon, lat + size];
  side(a, b);
  side(b, c);
  side(c, d);
  side(d, a);
  ring.push([lon, lat]);
  return ring;
}

/** `GET /zones/<type>/<id>` response (GeoJSON Feature). */
export function zoneFeature(id, geometry, type = 'forecast') {
  return {
    id: zoneUrl(id, type),
    type: 'Feature',
    geometry,
    properties: { id, type: 'public', name: `Zone ${id}` },
  };
}

export const polygonGeometry = (ring) => ({
  type: 'Polygon',
  coordinates: [ring],
});

let alertCounter = 0;
/** One feature of `GET /alerts/active`. */
export function nwsAlert({
  id = `urn:oid:2.49.0.1.840.0.fixture${++alertCounter}.001.1`,
  geometry = null,
  zones = [],
  severity = 'Moderate',
  event = 'Wind Advisory',
  expires = '2026-10-25T12:00:00-04:00',
  onset = '2026-10-25T04:00:00-04:00',
  sent = '2026-10-25T03:45:00-04:00',
  areaDesc = 'Coastal Franklin',
  senderName = 'NWS Tallahassee FL',
  web = 'http://www.weather.gov',
  status = 'Actual',
  ...rest
} = {}) {
  return {
    id: `https://api.weather.gov/alerts/${id}`,
    type: 'Feature',
    geometry,
    properties: {
      '@id': `https://api.weather.gov/alerts/${id}`,
      '@type': 'wx:Alert',
      id,
      areaDesc,
      affectedZones: zones,
      sent,
      effective: sent,
      onset,
      expires,
      ends: expires,
      status,
      messageType: 'Alert',
      category: 'Met',
      severity,
      certainty: 'Likely',
      urgency: 'Expected',
      event,
      sender: 'sender@example.invalid',
      senderName,
      headline: `${event} issued October 25 at 3:45AM EDT by ${senderName}`,
      description: 'Long free text that the layer never carries.',
      web,
      ...rest,
    },
  };
}

export const nwsCollection = (...features) => ({
  '@context': [],
  type: 'FeatureCollection',
  features,
  title: 'Current watches, warnings, and advisories',
  updated: '2026-10-25T08:45:05+00:00',
});

/** tsunami.gov NTWC feed: one Information statement (modeled on PAAQAtom.xml). */
export const tsunamiPaaq = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:georss="http://www.georss.org/georss">
    <id>urn:uuid:0a237c30-2100-4561-8dc4-ec1c5d0f9d30</id><title>Tsunami Information Statement Number 1</title>
    <updated>2026-10-25T02:26:53Z</updated>
    <author>
      <name>NWS National Tsunami Warning Center Palmer AK</name>
<uri>https://www.tsunami.gov/</uri>
     <email>center@example.invalid</email>
    </author>
<link type="application/atom+xml" rel="self" title="self" href="https://www.tsunami.gov/events/xml/PAAQAtom.xml"/>
<link rel="related" title="Energy Map" href="https://www.tsunami.gov/events/PAAQ/2026/10/25/tnfxzn/1/WEAK53/energytnfxzn.jpg" type="image/jpeg" />

   <entry>

    <title>in the Bonin Islands, Japan region</title><updated>2026-10-25T02:26:53Z</updated>
<geo:lat>28.000</geo:lat>
<geo:long>139.900</geo:long>
<summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
     <strong>Category:</strong> Information<br/><strong>Bulletin Issue Time: </strong> 2026.10.25 02:26:53 UTC <br/><strong>Preliminary Magnitude: </strong>7.0(Mwp)<br/><strong>Lat/Lon: </strong>28.000 / 139.900<br/><strong>Affected Region: </strong>in the Bonin Islands, Japan region<br/><b>Note:</b>  * There is no tsunami danger for the U.S. West Coast.<br/><a href="https://www.tsunami.gov/events/PAAQ/2026/10/25/tnfxzn/1/WEAK53/WEAK53.txt">View bulletin</a>
</div></summary>
    <id>urn:uuid:890504a1-0c59-4a3d-b6be-7bee3e3bebc3</id><link rel="related" title="CapXML document" href="https://www.tsunami.gov/events/PAAQ/2026/10/25/tnfxzn/1/WEAK53/PAAQCAP.xml" type="application/cap+xml" />
<link rel="alternate" title="Bulletin" href="https://www.tsunami.gov/events/PAAQ/2026/10/25/tnfxzn/1/WEAK53/WEAK53.txt" type="application/xml" />
</entry>
</feed>
`;

/** tsunami.gov PTWC feed (modeled on PHEBAtom.xml): "28." degrees, padded title. */
export const tsunamiPheb = `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:georss="http://www.georss.org/georss">
    <id>urn:uuid:30325835-4990-4b8f-8461-ab5b0a72c8bd</id><title>        TSUNAMI INFORMATION STATEMENT NUMBER   1        </title>
    <updated>2026-10-25T02:27:01Z</updated>
   <entry>

    <title>BONIN ISLANDS  JAPAN REGION</title><updated>2026-10-25T02:27:01Z</updated>
<geo:lat>28.</geo:lat>
<geo:long>139.9</geo:long>
<summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">
     <strong>Category:</strong> Information<br/><strong>Preliminary Magnitude: </strong>7.0(Mwp)<br/><strong>Affected Region: </strong>BONIN ISLANDS  JAPAN REGION<br/><b>Note:</b>  <br/><strong>Definition: </strong><a href="https://www.tsunami.gov/events/PHEB/2026/10/24/26297050/1/WEGM42/WEGM42.txt">View bulletin</a>
 </div></summary>
    <id>urn:uuid:ba64bc82-07f7-45fb-ab6c-25420fca6851</id><link rel="related" title="CapXML document" href="https://www.tsunami.gov/events/PHEB/2026/10/24/26297050/1/WEGM42/PHEBCAP.xml" type="application/cap+xml" />
<link rel="alternate" title="Bulletin" href="https://www.tsunami.gov/events/PHEB/2026/10/24/26297050/1/WEGM42/WEGM42.txt " type="application/xml" />
</entry>
</feed>
`;

/** One extra Atom entry for the variants a quiet day does not show. */
export function tsunamiEntry({
  title = 'Gulf of Alaska',
  updated = '2026-10-25T06:00:00Z',
  category = 'Warning',
  lat = '55.5',
  lon = '-155.25',
  id = 'urn:uuid:11111111-2222-3333-4444-555555555555',
  magnitude = '8.1(Mw)',
  href = 'https://www.tsunami.gov/events/PAAQ/2026/10/25/x/1/WEAK51/WEAK51.txt',
  geo = null,
} = {}) {
  return `<entry>
    <title>${title}</title><updated>${updated}</updated>
${geo ?? `<geo:lat>${lat}</geo:lat>\n<geo:long>${lon}</geo:long>`}
<summary type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><strong>Category:</strong> ${category}<br/><strong>Preliminary Magnitude: </strong>${magnitude}<br/></div></summary>
<id>${id}</id>
<link rel="alternate" title="Bulletin" href="${href}" type="application/xml" />
</entry>`;
}

export const tsunamiFeedOf = (...entries) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:georss="http://www.georss.org/georss">
<id>urn:uuid:feed</id><title>Fixture</title><updated>2026-10-25T06:00:00Z</updated>
${entries.join('\n')}
</feed>
`;
