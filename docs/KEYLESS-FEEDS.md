# Keyless feed layers

This fork adds live layers that need no paid or registered key. They share one
kit so each new layer is mostly configuration: a normalizer per upstream, a
style function, a card function and a list of subsources. The kit is the
codebase's version of a fetch → parse → normalize → export ingestor.

Every keyless layer serves one same-origin route, `/api/v1/layers/<layer-id>`,
whose body is a GeoJSON FeatureCollection (RFC 7946) with a `metadata` foreign
member. The browser never talks to the upstream.

## The kit

| Piece           | File                                     | Role                                                                                                        |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Proxy factory   | `server/providers/common/keylessFeed.js` | `createKeylessFeedProxy()` builds the Vite plugin for one layer route                                       |
| Upstream client | same file                                | `createUpstreamClient()`: User-Agent, timeout signal, `redirect: 'error'`, byte-capped JSON/text/gzip reads |
| Validator       | `src/layers/common/geojson.js`           | `validateFeatureCollection()`, `validateKeylessLayerCollection()`, `isValidGeometry()`, `toIsoTimestamp()`  |
| Test helpers    | `src/testSupport/geojson.mjs`            | `assertValidFeatureCollection()`, `assertValidKeylessLayerCollection()`                                     |
| Client source   | `src/layers/common/featureSource.js`     | `createKeylessFeatureSource({layerId, label})`: portable, capped, contract-checked                          |
| Client layer    | `src/layers/common/featureLayer.js`      | `createKeylessFeatureLayer({...})`: points/lines/areas, click card, subsource chips                         |
| Pure helpers    | `src/layers/common/featureModel.js`      | anchors, chip descriptors, partial-feed status, safe links                                                  |

### Server: `createKeylessFeedProxy(options)`

```js
createKeylessFeedProxy({
  name: 'global-hazards', // Vite plugin name
  layerId: 'global-hazards', // route /api/v1/layers/global-hazards
  subsources: [
    { id: 'gdacs', ttlMs: 15 * 60_000, fetchSnapshot: fetchGdacs },
    { id: 'eonet', ttlMs: 30 * 60_000, fetchSnapshot: fetchEonet },
  ],
  // Optional, with defaults:
  ttlMs: 900_000, // default per-subsource TTL
  failureBackoffMs: 60_000, // no retry of a failed subsource before this
  timeoutMs: 30_000, // per-subsource refresh timeout
  maxBytes: 16 * 1024 * 1024, // default cap per upstream body
  maxFeatures: 10_000, // per-subsource cap; excess dropped, `truncated: true`
  rateLimit: { windowMs: 60_000, max: 60, globalMax: 1200 }, // per client
  errorCode: 'global_hazards_unavailable', // 502 body
  fetchImpl,
  now,
});
```

Each subsource's `fetchSnapshot(context)` receives:

- `fetchJson(url, {maxBytes?, emptyStatuses?})`: GET and parse JSON under the
  byte cap. A status listed in `emptyStatuses` (an upstream that answers
  "nothing current" with 204 or 404) resolves `null`; any other non-2xx throws
  `upstream_status`; unparseable JSON throws `invalid_payload`.
- `fetchText(url, {maxBytes?, gzip?, maxDecodedBytes?})`: CSV, XML or TXT under
  the cap. `gzip: true` gunzips a `.gz` file (fetch already decodes
  `Content-Encoding`), `'auto'` only when the body starts with the gzip magic
  bytes; the decoded size is capped too (default 8x `maxBytes`).
- `fetchImpl(url, init)`: the raw wrapped fetch for anything else (headers must
  be a plain object).
- `signal`, `now`.

It resolves a FeatureCollection whose features have a non-empty string `id`
unique within the subsource, and throws on a corrupt payload. The collection
may also carry `details`, an object of flat scalars (booleans, finite numbers,
strings up to 64 characters, at most 8 keys) that the kit copies into that
subsource's `metadata.sources[]` entry; keys that clash with the kit's own
(`id`, `ok`, `stale`, `count`, `fetchedAt`, `truncated`, `error`) and structured
values are dropped. Weather & Tsunami Warnings reports `pendingZones` this way. Normalizers live
in `src/layers/<family>/records.js` (pure, portable) and mark a corrupt payload
with `Object.assign(new Error(detail), {code: 'invalid_payload'})`, because a
portable module cannot import the server kit.

The kit then:

1. prefixes ids (`<subsource>:<id>`) and stamps `properties.layer`,
   `properties.source` and `properties.timestamp` (default `null`);
2. validates the result with `validateKeylessLayerCollection()`; a collection
   that fails is rejected like a corrupt payload;
3. caches it per subsource for its TTL, with single-flight refresh.

Conventions enforced for every route: non-GET → 405 (`Allow: GET`); the client
query string is ignored (upstream URLs are fixed); per-client limiter → 429 with
`Retry-After: 60`; `Cache-Control: no-store`; `X-Data-Stale: true` when any
served subsource is stale; error details stay in server logs.

Failure semantics:

| Situation                                       | Response                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| All subsources fresh                            | 200, `metadata.stale: false`, `partial: false`                            |
| A refresh fails, earlier snapshot cached        | 200 with the cached features, that source `ok: false, stale: true, error` |
| A subsource fails with nothing cached           | 200 with the other subsources, that source `ok: false, count: 0, error`   |
| Every subsource failed, nothing cached          | 502 `{error: '<layer_id>_unavailable'}`                                   |
| Legitimately empty upstream (no current events) | 200, cached like any snapshot                                             |

A thrown refresh is never cached, so a corrupt payload can never become an
empty snapshot. Error codes are fixed: `invalid_payload`, `upstream_status`,
`upstream_unavailable`, `response_too_large`, `timeout`.

Response shape:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": "gdacs:TC-1001338",
      "geometry": { "type": "Point", "coordinates": [141.2, 27.6] },
      "properties": {
        "layer": "global-hazards",
        "source": "gdacs",
        "timestamp": "2026-10-23T00:00:00.000Z",
        "...": "layer-specific fields"
      }
    }
  ],
  "metadata": {
    "layer": "global-hazards",
    "fetchedAt": "2026-10-25T08:00:00.000Z",
    "stale": false,
    "partial": false,
    "sources": [
      {
        "id": "gdacs",
        "ok": true,
        "stale": false,
        "count": 38,
        "fetchedAt": "2026-10-25T08:00:00.000Z",
        "truncated": false
      }
    ]
  }
}
```

`metadata.fetchedAt` is the oldest served subsource's fetch time. `GET
/api/v1/layers/<id>/status` reports each subsource's cache state without
touching any upstream (the preview-serving test uses it).

### Client: `createKeylessFeatureLayer(options)`

```js
createKeylessFeatureLayer({
  id: 'global-hazards',
  name: 'Global Hazards', // English; LAYER_NAME_KEYS translates it
  icon: '⚠️',
  sourceName: 'GDACS · NASA EONET', // each part must be in the catalog
  updateInterval: 15 * 60_000,
  subsources: [{ id: 'gdacs', label: msg('GDACS') }, ...], // row chips
  style: (feature) => ({ color, outlineColor, pixelSize, outlineWidth, fillAlpha, lineWidth }),
  card: (feature, nowMs) => ({ title, details: [...], accent, link }),
  legend: (visibleFeatures) => [{ label, color, count, blurb? }],
  analystRecord: (feature, anchor) => ({ id, lat, lon, ... }),
  source, overlayHost, screenSpaceEventHandlerFactory, picking, pointer, openExternal,
});
```

- Points are clamped `PointGraphics`; lines are clamped polylines; polygons
  are a translucent fill plus a clamped outline. Entities are rebuilt in one
  suspended batch and only when the snapshot changed; nothing runs per frame,
  so the render governor needs no hold.
- One click card at a time goes through the world-overlay host (Cesium text
  labels are forbidden). The card's click-through opens `link` only if it is a
  credential-free `https:` URL.
- Only point picks are registered in `src/data/pickRegistry.js`; areas and
  lines stay unowned so a large polygon cannot make sibling cards inert.
- Each subsource gets a row chip; toggling re-renders from the last snapshot
  without refetching. A partial snapshot sets `getStats().error` to
  "`<feed>` feed unavailable" (translated by the Layers panel) and `degraded`.
- Lifecycle copies the earthquake layer: one `AbortController` per update,
  aborted by disable/destroy; late results never publish.

## Add a keyless layer: checklist

Read the Global Hazards files as the worked example.

1. **Normalizer** `src/layers/<family>/records.js`: pure functions from the
   upstream payload to a FeatureCollection. Skip bad features (non-finite or
   out-of-range coordinates, missing ids, open rings: use `isValidGeometry()`),
   throw `{code: 'invalid_payload'}` for a corrupt or non-collection payload,
   convert times with `toIsoTimestamp()` into `properties.timestamp`, and pass
   on only `https:` links.
2. **Provider** `server/providers/<family>.js`: `createKeylessFeedProxy()` with
   one subsource per upstream; register it in `localProviderPlugins()` in
   `server/providers/local.js`. Respect each upstream's cadence (TTL at least
   its update interval).
3. **Client** `src/layers/<family>/`: `source.js` wraps
   `createKeylessFeatureSource()` (label through `msg()` from
   `src/i18n/marker.js`); `cards.js` holds style, card and legend (strings via
   `t()`/`msg()`); `index.js` wraps `createKeylessFeatureLayer()`.
4. **Application wiring**: `src/app/layers/<family>.js`
   (`createApplication<Name>`, copy `globalHazards.js`), the array in
   `src/app/constructCatalog.js`, `CATALOG_SOURCE_CONTRACTS` in
   `src/app/sourceComposition.js`, and `createReferenceSources()` in
   `src/sources/reference.js`.
5. **Layer state**: get a token with `npm run layer-token:next -- <layer-id>`
   (never reuse or change a published one), add `{id, token, disposition:
'enabled-only'}` to `LAYER_STATE_REGISTRY` in `src/data/layerState.js`
   (alphabetical by id) and to `src/data/layerStateTokenReservations.json`.
6. **UI and voice**: `LAYER_NAME_KEYS` in `src/ui/layerNames.js`, a
   `PANEL_GROUPS` entry in `src/ui/layerPanel.js`, and a
   `src/voice/layerManifest.js` entry (aliases must not collide; `query` fields
   match `analystRecord`).
7. **Credits**: a `DATA_CREDITS` entry in `src/data/dataCredits.js` and a row
   in the DATA_SOURCES.md "Live sources" table (license or terms, attribution).
8. **Package boundaries**: `package.json` exports `./layers/<id>` and
   `./layers/<id>/source`, and matching groups in
   `scripts/package-boundaries.json` (copy the `global-hazards` and
   `global-hazards-source` groups; add the new modules to
   `application-components`, `application-layer-construction` and
   `reference-sources`).
9. **i18n**: every new English string in `src/i18n/locales/{es,ru,zh-CN}.json`
   (`npm run i18n` lists what is missing); proper nouns and acronyms go in
   `src/i18n/same-as-english.json`.
10. **Pinned tests**: bump the layer counts in `src/data/layerState.test.mjs`,
    `src/data/layerStateTokenLedger.test.mjs` (count and id → token map),
    `src/app/constructCatalog.test.mjs` and `src/app/sourceComposition.test.mjs`;
    add the key to `src/sources/reference.test.mjs`; add the plugin name and a
    `/api/v1/layers/<id>/status` row to `src/tooling/previewServing.test.mjs`.
    The token tests also pin the ledger frontier: after taking token `N`, the
    "next free token" values, retired-digit fixtures and the `l` field length
    in `layerState.test.mjs` and `layerStateTokenLedger.test.mjs` move up by
    one (each new one-character layer adds two `l` characters). A voice
    manifest entry changes the Realtime tool payload, so re-derive the pins in
    `src/firstRunExperience.test.mjs` (length and hash) and
    `src/voice/actionSchemas.test.mjs` (digest) with a comment line.
    `src/voice/pointAndAsk.test.mjs` caps instructions plus tools at 52,200
    characters; Global Hazards left about 90 spare, so the next layer needs a
    decision (voice-off in `VOICE_OFF_LAYERS`, `noQuery`, trimming elsewhere,
    or a deliberate new budget), not a silent raise. Weather & Tsunami Warnings
    chose a toggle-only entry (`noQuery`, two aliases), which fits under the
    existing ceiling with seven characters to spare (52,193 of 52,200), so the next layer is in
    the same position.
11. **Tests**: `records.test.mjs` on hand-written fixtures (valid output via
    `assertValidFeatureCollection`), a proxy test (both hooks, TTL, stale on
    error, byte cap, sanitized 502, no cached empty snapshot, single flight,
    405, one subsource failing while others serve), `source.test.mjs` and an
    ownership test. List new non-runtime files in `scripts/format-scope.json`.
12. **Docs**: a row in docs/CURRENT-STATE.md and README.md "What's on the
    Globe" (leave the pinned "Twenty layers …" sentence alone), and a section
    below.

## Keyless layers

| Layer id           | Name                       | Subsources (TTL)                   | Route                             | Notes                              |
| ------------------ | -------------------------- | ---------------------------------- | --------------------------------- | ---------------------------------- |
| `global-hazards`   | Global Hazards             | `gdacs` (15 min), `eonet` (30 min) | `/api/v1/layers/global-hazards`   | First layer on the kit             |
| `weather-warnings` | Weather & Tsunami Warnings | `nws` (2 min), `tsunami` (5 min)   | `/api/v1/layers/weather-warnings` | NWS zone cache fills progressively |

### Global Hazards (`global-hazards`, token `5`)

- **GDACS** — `https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP?eventtype=<type>`,
  one request per type (`EQ`, `TC`, `FL`, `VO`, `DR`, `WF`). The MAP list takes
  exactly one event type and lists the events GDACS currently maps; a type with
  nothing current answers 404 (`application/problem+json`), which is read as
  empty. The SEARCH list was rejected: it stops at 100 events, which earthquakes
  and forest fires fill on their own, so cyclones, floods, volcanoes and
  droughts never appeared. MAP lists carry several features per event
  (centroid, affected-area polygons, cyclone tracks and wind buffers); only the
  `Point_Centroid` (else the event's first point) is kept, as feature
  `<eventtype>-<eventid>`. Properties: `hazard`, `eventtype`, `eventid`,
  `episodeid`, `alertlevel` (`green`/`orange`/`red`), `name`, `country`,
  `fromdate`, `todate` (zone-less upstream times read as UTC), `severity`
  (GDACS severity text), `url` (the `www.gdacs.org` report page, https only),
  `timestamp` (= `todate`, the latest episode). One failing type fails the
  GDACS subsource (the last good snapshot is served stale) rather than serving
  a list silently missing a hazard type; every type empty is treated as a
  broken feed. Droughts' MAP list is about 3 MB because of its area polygons,
  under the 12 MB per-type cap; the six parallel reads took about 20 s in
  testing, so the GDACS refresh timeout is 60 s.
- **NASA EONET** — `https://eonet.gsfc.nasa.gov/api/v3/events/geojson?status=open&days=30`.
  EONET emits one feature per observation (a storm track is dozens of dated
  points; an iceberg drift is a LineString dated by `geometryDates`), so
  features are grouped by event id and the latest Point or Polygon wins; a
  LineString contributes its last vertex. Closed events are skipped. Properties:
  `hazard` (from the first category), `category`, `categoryTitle`,
  `alertlevel: null`, `name`, `description`, `magnitudeValue`,
  `magnitudeUnit`, `url` (the first https source link), `timestamp`.
- **Display** — fill by hazard kind, ring colour and size by GDACS alert level;
  card shows name, type, alert level, country, severity or magnitude, age and
  the source link. Caveats: GDACS and EONET overlap (the same cyclone or fire
  can appear once per feed); GDACS areas and tracks are not drawn; alerts are
  informational and not for life-safety decisions.

### Weather & Tsunami Warnings (`weather-warnings`, token `6`)

- **NWS alerts** — `https://api.weather.gov/alerts/active?status=actual`, sent
  with `Accept: application/geo+json` and the fork's `User-Agent` (the API
  rejects requests without one). A live sample had 356 alerts, 333 of them with
  `geometry: null` and only `affectedZones` (495 distinct zone URLs). An alert
  with its own Polygon/MultiPolygon uses it; otherwise its area is the
  MultiPolygon of its zones' polygons, fetched from
  `https://api.weather.gov/zones/<forecast|county|fire|coastal|offshore>/<id>`.
  Only URLs of that exact shape are ever requested, whatever the alert says.
  Feature id is the CAP alert id (`urn:oid:…`, so `nws:urn:oid:…` on the wire).
  Properties: `event`, `severity` (Extreme, Severe, Moderate, Minor, Unknown),
  `urgency`, `certainty`, `headline`, `areaDesc`, `senderName`, `onset`,
  `expires` (ISO UTC; `ends` wins over `expires`), `url` (the alert's `web`
  link read as https, weather.gov only) and `timestamp` (= `sent`). Skipped:
  non-`Actual` status, already expired, no id, duplicate id.
- **Zone cache** (`server/providers/nwsZones.js`) — in memory, per server
  process. Zones are static boundaries, so each is fetched once and kept for 7
  days (an expired copy is served while it refreshes). Per refresh: at most 150
  new zone requests (the budget counts failures), four in flight, none started
  after 30 s, most severe alerts first and, within a severity, alerts with the
  fewest missing zones first. A zone that answers 404, has no polygon or is over
  the 2 MiB cap is remembered as "gone" for a day (the alert is drawn from its
  other zones); any other failure is retried after 5 minutes. The cache is
  bounded to 6,000 zones. Cold start: with the sample's 495 zones the first
  request fetches 150, so roughly four refreshes (about eight minutes at the
  2-minute TTL) are needed before every alert is drawn; the live fetch of all
  495 took about 3 s from this machine, so refreshes are quick in practice.
- **Pending alerts** — an alert whose zones are not all resolved is omitted
  (a partial area would mislead). `metadata.sources[nws]` carries `alerts`,
  `pendingAlerts`, `pendingZones`, `unmappedAlerts` (alerts left with no area at
  all) and `tolerance` (the simplification in degrees actually used).
- **Decimation** — zone rings are simplified (Douglas–Peucker, 0.01°, about
  1 km) and rounded to 3 decimals before caching; specks smaller than the
  tolerance and collapsed holes go. The sample's 356 alerts serialized to about
  1.0 MB (from 90 MB of raw zone JSON). If features exceed 3 MB the tolerance
  steps to 0.025°, 0.05°, 0.1° (about 11 km, still keeping county-sized zones),
  and as a last resort the least severe alerts are dropped.
- **NOAA tsunami** — `https://www.tsunami.gov/events/xml/PAAQAtom.xml` (NTWC,
  Alaska and the US/Canada coasts) and `PHEBAtom.xml` (PTWC, Pacific and
  Caribbean). Each feed holds its center's latest bulletin, so bulletins older
  than three days are dropped rather than shown forever. Parsed with small
  tag/attribute regexes (no XML dependency); `geo:lat`/`geo:long` (with
  `georss:point` as a fallback; PHEB writes "28." for 28 degrees). Properties:
  `title` (the region), `level` (`warning`, `advisory`, `watch`,
  `information`, from the summary's Category; a PTWC "threat" message reads as
  `watch`), `center`, `magnitude` and `magnitudeType`, `url` (the `alternate`
  bulletin link, https on tsunami.gov), `timestamp`. Feature id is
  `<center>-<entry uuid>`.
- **Display** — NWS areas are translucent fills colored by severity (the more
  severe, the heavier the outline); tsunami bulletins are white-ringed points
  colored by level. Both are clickable; the card shows event or region,
  severity or level and magnitude, area, onset/expiry or age, issuing office,
  and opens the weather.gov or tsunami.gov link.
- **Caveats** — NWS alerts cover the US and its territories only; tsunami
  bulletins cover the Pacific, Alaska/West Coast and Caribbean centers. Both
  centers often publish the same quake, so two points can stack at one place.
  One failing tsunami center fails the whole `tsunami` subsource (the last good
  snapshot is served flagged stale) rather than hiding a center. The layer is
  informational and not for life-safety decisions. Voice: toggle only.
