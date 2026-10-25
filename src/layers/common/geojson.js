/**
 * RFC 7946 GeoJSON checks shared by keyless-feed normalizers, the keyless
 * proxy kit (server/providers/common/keylessFeed.js) and their tests.
 *
 * Pure and portable: no Cesium, DOM or Node imports, so the server, portable
 * sources and tests can all load it. The checks cover what the globe relies
 * on — geometry types, finite WGS84 positions inside their ranges, line and
 * ring lengths, closed rings, object-or-null properties and unique feature
 * ids — not every corner of the RFC (no winding-order or antimeridian rules).
 * @module layers/common/geojson
 */

/** Errors past this many are dropped; a broken feed should not flood logs. */
const MAX_ERRORS = 50;

const GEOMETRY_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
  'GeometryCollection',
]);

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Whether one position is finite, two or three numbers, with longitude in
 * [-180, 180] and latitude in [-90, 90].
 * @param {unknown} position
 * @returns {boolean}
 */
export function isValidPosition(position) {
  if (
    !Array.isArray(position) ||
    position.length < 2 ||
    position.length > 3 ||
    !position.every((value) => typeof value === 'number' && isFinite(value))
  )
    return false;
  const [lon, lat] = position;
  return lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

/**
 * Whether a linear ring is closed (first and last positions equal) with at
 * least four valid positions.
 * @param {unknown} ring
 * @returns {boolean}
 */
export function isClosedRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  if (!ring.every(isValidPosition)) return false;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return (
    first.length === last.length &&
    first.every((value, index) => value === last[index])
  );
}

function checkPositions(list, path, minimum, report) {
  if (!Array.isArray(list)) return report(`${path}: must be an array`);
  if (list.length < minimum)
    return report(`${path}: needs at least ${minimum} positions`);
  list.forEach((position, index) => {
    if (!isValidPosition(position))
      report(`${path}[${index}]: invalid position`);
  });
}

function checkRings(rings, path, report) {
  if (!Array.isArray(rings) || !rings.length)
    return report(`${path}: polygon needs at least one ring`);
  rings.forEach((ring, index) => {
    const ringPath = `${path}[${index}]`;
    if (!Array.isArray(ring) || ring.length < 4)
      return report(`${ringPath}: ring needs at least 4 positions`);
    if (!ring.every(isValidPosition))
      return checkPositions(ring, ringPath, 4, report);
    if (!isClosedRing(ring)) report(`${ringPath}: ring is not closed`);
  });
}

function checkGeometry(geometry, path, report, depth = 0) {
  if (!isPlainObject(geometry)) return report(`${path}: must be an object`);
  if (!GEOMETRY_TYPES.has(geometry.type))
    return report(`${path}.type: unknown geometry type`);
  if (geometry.type === 'GeometryCollection') {
    if (depth > 0)
      return report(`${path}: nested GeometryCollection is not allowed`);
    if (!Array.isArray(geometry.geometries))
      return report(`${path}.geometries: must be an array`);
    geometry.geometries.forEach((child, index) =>
      checkGeometry(child, `${path}.geometries[${index}]`, report, depth + 1),
    );
    return;
  }
  const coordinates = geometry.coordinates;
  const at = `${path}.coordinates`;
  switch (geometry.type) {
    case 'Point':
      if (!isValidPosition(coordinates)) report(`${at}: invalid position`);
      return;
    case 'MultiPoint':
      return checkPositions(coordinates, at, 1, report);
    case 'LineString':
      return checkPositions(coordinates, at, 2, report);
    case 'MultiLineString':
      if (!Array.isArray(coordinates)) return report(`${at}: must be an array`);
      coordinates.forEach((line, index) =>
        checkPositions(line, `${at}[${index}]`, 2, report),
      );
      return;
    case 'Polygon':
      return checkRings(coordinates, at, report);
    case 'MultiPolygon':
      if (!Array.isArray(coordinates)) return report(`${at}: must be an array`);
      coordinates.forEach((rings, index) =>
        checkRings(rings, `${at}[${index}]`, report),
      );
  }
}

/**
 * Check one geometry object (not null). Normalizers use it to skip a bad
 * feature instead of failing the whole collection.
 * @param {unknown} geometry
 * @returns {boolean}
 */
export function isValidGeometry(geometry) {
  let ok = true;
  checkGeometry(geometry, 'geometry', () => {
    ok = false;
  });
  return ok;
}

/**
 * Validate a FeatureCollection against the RFC 7946 basics.
 *
 * Checks: `type`, a `features` array, each feature's `type`, geometry (or
 * null), positions (finite; lon in [-180, 180], lat in [-90, 90]), LineString
 * length (>= 2), Polygon rings (closed, >= 4 positions), properties (object or
 * null), id (string or number) and that ids are unique across the collection.
 * With `requireIds`, every feature must carry a non-empty string id.
 * @param {unknown} collection
 * @param {{requireIds?: boolean}} [options]
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateFeatureCollection(
  collection,
  { requireIds = false } = {},
) {
  const errors = [];
  const report = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };
  if (!isPlainObject(collection)) {
    report('collection: must be an object');
    return { ok: false, errors };
  }
  if (collection.type !== 'FeatureCollection')
    report('type: must be "FeatureCollection"');
  if (!Array.isArray(collection.features)) {
    report('features: must be an array');
    return { ok: false, errors };
  }
  const ids = new Set();
  collection.features.forEach((feature, index) => {
    const path = `features[${index}]`;
    if (!isPlainObject(feature)) return report(`${path}: must be an object`);
    if (feature.type !== 'Feature') report(`${path}.type: must be "Feature"`);
    if (feature.geometry !== null)
      checkGeometry(feature.geometry, `${path}.geometry`, report);
    if (feature.properties !== null && !isPlainObject(feature.properties))
      report(`${path}.properties: must be an object or null`);
    const { id } = feature;
    if (id === undefined) {
      if (requireIds) report(`${path}.id: missing`);
      return;
    }
    if (
      !(typeof id === 'string' && id !== '') &&
      !(typeof id === 'number' && isFinite(id))
    )
      return report(`${path}.id: must be a non-empty string or a number`);
    if (requireIds && typeof id !== 'string')
      report(`${path}.id: must be a string`);
    const key = `${typeof id}:${id}`;
    if (ids.has(key)) report(`${path}.id: duplicate id ${JSON.stringify(id)}`);
    ids.add(key);
  });
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a keyless layer collection: the RFC 7946 basics plus the layer
 * contract every keyless proxy serves (docs/KEYLESS-FEEDS.md). Each feature
 * has a string id, `properties.layer` equal to `layerId`, a string
 * `properties.source`, and `properties.timestamp` that is null/absent or an
 * ISO-8601 string. With `requireMetadata`, the top-level `metadata` member
 * must name the layer and list its sources.
 * @param {unknown} collection
 * @param {{layerId: string, requireMetadata?: boolean}} options
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateKeylessLayerCollection(
  collection,
  { layerId, requireMetadata = false } = {},
) {
  const { errors } = validateFeatureCollection(collection, {
    requireIds: true,
  });
  const report = (message) => {
    if (errors.length < MAX_ERRORS) errors.push(message);
  };
  if (Array.isArray(collection?.features)) {
    collection.features.forEach((feature, index) => {
      const properties = feature?.properties;
      const path = `features[${index}].properties`;
      if (!isPlainObject(properties)) return report(`${path}: missing`);
      if (properties.layer !== layerId)
        report(`${path}.layer: must be ${JSON.stringify(layerId)}`);
      if (typeof properties.source !== 'string' || !properties.source)
        report(`${path}.source: must be a non-empty string`);
      if (properties.timestamp != null && !isIsoTimestamp(properties.timestamp))
        report(`${path}.timestamp: must be an ISO-8601 string or null`);
    });
  }
  if (requireMetadata) {
    const metadata = collection?.metadata;
    if (!isPlainObject(metadata)) report('metadata: missing');
    else {
      if (metadata.layer !== layerId)
        report(`metadata.layer: must be ${JSON.stringify(layerId)}`);
      if (typeof metadata.stale !== 'boolean')
        report('metadata.stale: must be a boolean');
      if (!Array.isArray(metadata.sources))
        report('metadata.sources: must be an array');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Whether a value is an ISO-8601 date-time string with a zone (`Z` or ±hh:mm). */
export function isIsoTimestamp(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * Upstream time to ISO-8601 UTC, or null. Accepts epoch milliseconds, ISO
 * strings with a zone, and zone-less "YYYY-MM-DDTHH:MM:SS" / "YYYY-MM-DD
 * HH:MM:SS" strings, which are read as UTC (GDACS and EONET publish UTC
 * without a designator).
 * @param {unknown} value
 * @returns {string|null}
 */
export function toIsoTimestamp(value) {
  if (typeof value === 'number')
    return Number.isFinite(value) && Math.abs(value) <= 8.64e15
      ? new Date(value).toISOString()
      : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const zoneless =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(text);
  const candidate = zoneless ? `${zoneless[1]}T${zoneless[2]}Z` : text;
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(candidate)) return null;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
