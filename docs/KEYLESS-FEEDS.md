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

A layer whose subsources describe the same things can pass `combine(features)`
to `createKeylessFeedProxy()`. It runs on every response over the stamped,
prefixed features of the subsources that are being served (fresh or stale),
must not change its input, and returns the features to send; its output is held
to the same layer contract again, and a failure (or a throw) answers the
sanitized 502. `metadata.sources[]` still reports each subsource's own count.
Volcanoes uses it to join a volcano reported by both feeds into one feature
(`properties.source: 'gvp+usgs'`); the client treats a `+`-joined source as
belonging to each feed (chip counts, and a chip hides a feature only when every
feed behind it is off). A request can also replace the kit's User-Agent for one
upstream with `fetchJson(url, {headers: {'User-Agent': …}})`.

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
  style: (feature) => ({ color, outlineColor, pixelSize, outlineWidth, fillAlpha, lineWidth, outline }),
  card: (feature, nowMs, metadata) => ({ title, details: [...], accent, link }),
  legend: (visibleFeatures, metadata) => [{ label, color, count, blurb? }],
  rowInfo: (metadata, nowMs) => ({ text, title? }) | null, // line under the panel row
  analystRecord: (feature, anchor) => ({ id, lat, lon, ... }),
  source, overlayHost, screenSpaceEventHandlerFactory, picking, pointer, openExternal,
});
```

- Points are clamped `PointGraphics`; lines are clamped polylines; polygons
  are a translucent fill plus a clamped outline. Entities are rebuilt in one
  suspended batch and only when the snapshot changed; nothing runs per frame,
  so the render governor needs no hold.
- A style with `clampToGround: false` draws points on the ellipsoid instead of
  clamping each one to terrain; Aviation Weather uses it for its ~5,000 METAR
  points (the depth test is already disabled for points, so they still draw
  over terrain).
- Optional hooks for a layer whose second feed carries no geometry (Aurora &
  Space Weather): `rowInfo(metadata, nowMs)` returns a line shown under the
  Layers panel row (`info`/`infoTitle` in the row controls), `card` and `legend`
  receive the latest response `metadata` as an extra argument, a subsource with
  `chip: false` keeps its name for the "`<feed>` feed unavailable" status
  without a toggle chip, and a style with `outline: false` draws an area as a
  fill only (the default outline would draw seams between neighboring blocks).
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
    existing ceiling with seven characters to spare (52,193 of 52,200).
    Volcanoes needed 24 even as a toggle with no alias (52,217), and took the
    "deliberate new budget" route: the ceiling is now 52,250, 33 spare.
    Aurora & Space Weather is a toggle with no alias (52,249, 32 characters);
    the "aurora" alias would have cost 22 more and was dropped rather than
    raising the ceiling again. One character is spare, so the next layer must
    choose: voice-off, trimming elsewhere, or a new budget.
    Aviation Weather is a toggle with no alias and costs 38 (52,287; its long
    id sits in two enums). It also took the "new budget" route: the ceiling is
    now 52,300, 13 spare, rather than making a pilot-facing layer voice-off.
    Token `9` was the last single character; the next layer gets `00`, and the
    frontier values in the token tests move to `00`/`01` (digits are exhausted,
    so the digit fixtures in those tests are empty or removed).
    Airspace is a toggle with no alias and costs 22 (52,309 against 13 spare);
    the ceiling is now 52,350, 41 spare. That is the fourth raise in a row: the
    next layer should trim the prompt or the manifest rather than raise it again.
    Airspace took token `00`, the first two-character token; the next layer gets
    `01`, and the frontier values in the token tests move to `01`/`02`.
11. **Tests**: `records.test.mjs` on hand-written fixtures (valid output via
    `assertValidFeatureCollection`), a proxy test (both hooks, TTL, stale on
    error, byte cap, sanitized 502, no cached empty snapshot, single flight,
    405, one subsource failing while others serve), `source.test.mjs` and an
    ownership test. List new non-runtime files in `scripts/format-scope.json`.
12. **Docs**: a row in docs/CURRENT-STATE.md and README.md "What's on the
    Globe" (leave the pinned "Twenty layers …" sentence alone), and a section
    below.

## Keyless layers

| Layer id             | Name                                   | Subsources (TTL)                          | Route                               | Notes                                     |
| -------------------- | -------------------------------------- | ----------------------------------------- | ----------------------------------- | ----------------------------------------- |
| `global-hazards`     | Global Hazards                         | `gdacs` (15 min), `eonet` (30 min)        | `/api/v1/layers/global-hazards`     | First layer on the kit                    |
| `weather-warnings`   | Weather & Tsunami Warnings             | `nws` (2 min), `tsunami` (5 min)          | `/api/v1/layers/weather-warnings`   | NWS zone cache fills progressively        |
| `volcanoes`          | Volcanoes                              | `gvp` (6 h), `usgs` (10 min)              | `/api/v1/layers/volcanoes`          | Joins a volcano in both feeds             |
| `space-weather`      | Aurora & Space Weather                 | `aurora` (5 min), `kp` (15 min)           | `/api/v1/layers/space-weather`      | Kp rides in metadata, no features         |
| `aviation-weather`   | Aviation Weather                       | `metar`, `sigmet`, `isigmet` (5 min each) | `/api/v1/layers/aviation-weather`   | About 5,100 METAR points, 2 MB            |
| `airspace`           | Airspace Restrictions & Airport Delays | `tfr` (10 min), `delays` (5 min)          | `/api/v1/layers/airspace`           | One XNOTAM download per TFR, cached       |
| `water-observations` | Buoys & River Gauges                   | `buoys`, `rivers` (15 min each)           | `/api/v1/layers/water-observations` | NWPS fetched in 8 bbox tiles, 3 at a time |

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

### Volcanoes (`volcanoes`, token `7`)

- **Smithsonian GVP** — the "Volcanoes of the World" WFS,
  `https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=GVP-VOTW:E3WebApp_Eruptions1960&outputFormat=application/json&CQL_FILTER=ContinuingEruption=%27True%27`
  (38 records in a live sample). A record not flagged `ContinuingEruption:
'True'` is skipped even though the request filters for it, so a server that
  ignores the filter cannot turn the layer into every eruption since 1960. One
  feature per `VolcanoNumber`: with several open records the latest start wins
  (then the higher `Activity_ID`). The start comes from `StartDateYear/Month/
Day` (or the `YYYYMMDD` string, zeroes meaning unknown); `eruptionStart` is an
  ISO time only for a complete real date, otherwise null with
  `eruptionStartYear` kept (Yasur: only 1270). `EndDate` is not used: for
  continuing eruptions it is a review date, not an end. Properties:
  `name`, `vnum`, `eruption: true`, `vei` (0-8 or null), `eruptionStart`,
  `eruptionStartYear`, `url` (`https://volcano.si.edu/volcano.cfm?vn=<vnum>`).
  The volcano.si.edu RSS reports and site pages answer with a bot-verification
  page and are not used; only the WFS (which does not) is. TTL 6 h.
- **USGS Volcano Hazards Program** —
  `https://volcanoes.usgs.gov/vsc/api/volcanoApi/vhpstatus`, a JSON array of
  every US volcano (161 in a live sample) under `Content-Type: text/html`.
  Only volcanoes whose `alertLevel` is not `NORMAL` or `UNASSIGNED` are kept
  (`includeNormal` in the normalizer exists for a future toggle; the route never
  uses it). Properties: `name`, `vnum`, `alertLevel` (ADVISORY, WATCH,
  WARNING), `colorCode` (YELLOW, ORANGE, RED; GREEN only with `includeNormal`),
  `observatory` (the `obs` code upper-cased: AVO, HVO, CVO, YVO, CALVO, NMI),
  `region`, `synopsis` (the "AVO Great Sitkin ORANGE/WATCH - " prefix that
  repeats level and color is removed), `alertDate` and `timestamp` (the notice
  time from `noticeId`, else `alertDate`; `alertDate` has no zone and is read
  as UTC), `url` (https only, usgs.gov, alaska.edu or volcano.si.edu hosts). A
  volcano with no volcano number is identified as `cd-<volcanoCd>`. An empty
  list is treated as a broken feed. TTL 10 min. The service answers **404 to
  the kit's default User-Agent** (`GodsEyeView/fork (+https://…)`, any
  User-Agent carrying a URL) and 200 to the same product token alone, so this
  one request sends `GodsEyeView/fork`.
- **Merge** — `mergeVolcanoFeatures()` in `src/layers/volcanoes/records.js`
  (the kit's `combine`). Key = volcano number. A volcano in both feeds is one
  feature, `source: 'gvp+usgs'`, with the GVP point, the USGS alert fields and
  the GVP eruption fields; `timestamp` is the USGS notice time, else the
  eruption start. The id is `volcano:<key>` for all three cases (gvp, usgs,
  gvp+usgs), so an open card survives a feed dropping out and returning. The
  link is the USGS page, else GVP's. Every feature has the full property set
  (nulls for the feed that is missing): `name`, `vnum`, `eruption`, `vei`,
  `eruptionStart`, `eruptionStartYear`, `alertLevel`, `colorCode`,
  `observatory`, `region`, `synopsis`, `alertDate`, `url`, `gvpUrl`, `usgsUrl`,
  `timestamp`. A NORMAL USGS volcano never reaches the merge, so an erupting
  volcano that USGS rates NORMAL shows as GVP-only (purple).
- **Display** — fill is the USGS aviation color code (green, yellow, orange,
  red) when present, else purple for a GVP-only eruption; a white ring marks a
  continuing eruption, the size follows the VEI (9-16 px) or the alert level
  (advisory 10, watch 13, warning 16). Card: eruption and VEI, alert level and
  aviation code, observatory and region, synopsis, eruption start, notice age,
  source link. Legend: aviation codes from red to green, then eruptions with no
  code. Chips: Smithsonian GVP and USGS.
- **Caveats** — GVP lists eruptions it considers continuing (some for years or
  centuries); it does not report a "last activity" time, so a purple dot does
  not mean activity today. USGS covers US volcanoes only, so most of the world's
  volcanoes have only the GVP view. Informational, not for life-safety or
  flight-planning decisions. Voice: toggle only; reaching it needed a deliberate
  +50 characters on the voice prompt ceiling (now 52,250).

### Aurora & Space Weather (`space-weather`, token `8`)

- **Aurora** — `https://services.swpc.noaa.gov/json/ovation_aurora_latest.json`,
  the NOAA SWPC OVATION nowcast (about 900 KB; the file says `"type":
"MultiPoint"` but is not GeoJSON: `coordinates` is a list of
  `[longitude 0..359, latitude -90..90, probability %]`, 65,160 cells at 1°,
  plus `Observation Time` and `Forecast Time`). Refreshed upstream about every
  5 minutes (TTL 5 min). Longitude wraps into -180..180 (350 → -10, 180 →
  -180); entries that are not integer lon/lat with a probability of 0-100 are
  skipped and counted (`skippedCells`), duplicates keep the first, and a grid
  that is all bad (a changed resolution) or more than half bad is a corrupt
  payload, never a calm sky.
- **Why polygons, not points** — 1° cells drawn as dots would be hundreds to
  thousands of overlapping entities with no sense of area; filled bands read as
  the aurora oval and serialize smaller. Rendered in the dev server with a
  synthetic storm (live route patched in the page), the bands show no seams
  between blocks at either 90° or 30° block widths; the pinched wedge at the
  pole in the screenshots is the Esri imagery, not the layer. Cells at `AURORA_MIN_PROBABILITY` (10 %) or more are
  grouped into four bands (10-20, 20-40, 40-60, 60 %+), hemisphere and 90°
  block of longitude, and each group's cells are traced into polygons with
  holes (`traceCells()` in `records.js`: boundary edges chained into rings, a
  left turn at a corner where two cells meet diagonally, so rings never touch
  themselves; wound counter-clockwise outer, clockwise holes). A cell covers
  its grid point ±0.5°, clipped at ±180° and ±90°; the cell centered on the
  antimeridian is drawn on both sides of it. Every outline vertex is kept
  (one degree apart), so a geodesic edge stays on its parallel; the 90° blocks
  keep each polygon well under a hemisphere, which Cesium triangulates
  reliably, and they have no outline so the shared edges do not show.
- **Size** — the October 2026 samples serialize to 5.7 KB (788 cells, 3
  features) and 7.0 KB (1,059 cells); a solid belt of 22,320 cells is 28 KB
  and a ragged storm of 28,080 cells is 126 KB. A grid needing more than
  `AURORA_MAX_VERTICES` (25,000, about 400 KB) is treated as a corrupt payload.
- **Features** — id `<hemisphere>-<band min>-<block>` (`north-20-1`, so
  `aurora:north-20-1` on the wire). Properties: `hemisphere`, `band` (lower
  bound %), `bandMax` (upper bound, null for the top band), `probability` (peak
  cell in the feature), `cells`, `observationTime`, `forecastTime`, `timestamp`
  (= observation time). `metadata.sources[aurora]` also carries
  `observationTime`, `forecastTime`, `activeCells`, `peakProbability` and
  `skippedCells`.
- **Kp** — `https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json`,
  now an array of objects (`time_tag`, `Kp`, `a_running`, `station_count`; one
  per 3-hour interval, about 59 rows, `time_tag` zone-less UTC); the older
  layout, an array of arrays with a header row and string cells, is read as
  well. The latest interval by time wins (the row for the interval that has
  ended, so it can be up to about 4 hours behind the clock). No features: the
  subsource's `details` become `metadata.sources[kp]` = `{kp, kpTime, gScale,
kpMax24h}` (`kpMax24h` = highest of the 8 latest rows) next to the kit's own
  fields, and `spaceWeatherFromMetadata()` reads them back. TTL 15 min. A Kp
  outside 0-9 or an unreadable row is skipped; no valid row is a corrupt
  payload.
- **G-scale** — NOAA lists whole Kp values (G1 = 5, G2 = 6, G3 = 7, G4 = 8
  including 9-, G5 = 9) and publishes Kp in thirds, so `kpToGScale()` rounds to
  the nearest whole number and keeps 9- (8.67) at G4: 7.33 → G3, 4.67 (5-) →
  G1, 4.33 → none. The NOAA page does not spell out the thirds; this reading
  follows its "8, including a 9-" wording.
- **Display** — fill by band (green, lime, yellow, red; alpha 0.22 to 0.48), no
  outline. The Layers row shows "Kp 7.33 · G3 strong geomagnetic storm" (the
  tooltip names the 3-hour interval and the 24-hour peak) and a legend of the
  bands drawn; a click opens a card with the band, the peak chance, the
  nowcast time and age, the Kp line and a link to SWPC's 30-minute aurora
  forecast page. Kp is global, so there are no feed chips.
- **Caveats** — OVATION is a model nowcast of aurora probability for the next
  hour or so; it says nothing about cloud or light pollution. The two feeds
  update on different clocks, so a card's Kp can be a few hours older than the
  bands. Informational, not for safety-critical use. Voice: toggle only (no
  alias).

### Aviation Weather (`aviation-weather`, token `9`)

- **METAR** — `https://aviationweather.gov/data/cache/metars.cache.csv.gz`, the
  bulk file AWC asks heavy users to read instead of bounding-box queries (about
  250 KB gzip, 1 MB of CSV, 5,121 rows in a live sample; refreshed about every
  minute, our TTL is 5 min). It is served as `application/octet-stream`, so the
  kit's `fetchText(url, {gzip: 'auto'})` gunzips it (2 MiB compressed cap, 16 MiB
  decoded cap, so a small gzip bomb is refused). The CSV has 44 columns with
  `sky_cover`/`cloud_base_ft_agl` repeated four times; the header row is found
  by its `raw_text` first column (notice lines before it are tolerated) and
  fields are parsed per RFC 4180 (3 of 5,121 raw reports contain commas).
  Feature id = ICAO station id (`metar:KSEA` on the wire); a station listed
  twice keeps the newest observation. Skipped: no station id, bad time, an
  observation over 3 hours old, non-finite or out-of-range position, exactly
  0,0, and AWC's missing-position sentinel (-99.99, -99.99; 22 rows in the
  sample). A file with no header, a missing required column or no usable station
  (including one that has gone entirely stale) is a corrupt payload: the last
  good map is served flagged stale instead of an empty one.
- **Flight category** — the CSV `flight_category` when it is VFR, MVFR, IFR or
  LIFR. 388 of 5,121 rows carry the literal text `null` (every one of them has
  no visibility); where a category is missing and visibility is known it is
  derived with the FAA thresholds: the worse of ceiling (lowest BKN/OVC/OVX
  layer, feet AGL) and visibility wins; LIFR below 500 ft or 1 mi, IFR below
  1,000 ft or 3 mi, MVFR up to 3,000 ft or 5 mi, else VFR. Checked against the
  4,733 rows of the sample that have both a category and a visibility: 0
  disagreements. With visibility unknown the category stays `null` (grey)
  rather than guessing from the ceiling alone. `vert_vis_ft` is ignored: the
  sample reports it in hundreds of feet while the sky columns already carry the
  vertical-visibility layer as OVX.
- **METAR properties** — `station`, `category`, `type` (only `SPECI`), `wdir`,
  `wspd`, `wgst` (kt), `vis` (statute miles; `visPlus: true` for "10+"),
  `ceiling` (ft AGL), `temp`, `dew` (°C), `altim` (inHg), `wx`, `raw` (≤ 400
  characters), `timestamp` (= observation time). Optional properties are omitted
  when absent to keep the body small. Measured: 5,047 stations, 1.94 MB of
  features (about 385 bytes each including the kit's `layer`/`source`
  stamps); the whole route 2.1 MB, 291 KB gzipped. The client reads up to 8 MiB.
- **SIGMET / AIRMET** — `https://aviationweather.gov/api/data/airsigmet?format=geojson`
  (US; the live sample had 6 convective SIGMETs and no AIRMETs, `severity` 5,
  `altitudeLow1/2`, `altitudeHi1/2`, `rawAirSigmet`) and
  `https://aviationweather.gov/api/data/isigmet?format=geojson` (international;
  181 in a live sample: TS 76, TURB 55, ICE 21, VA 17, MTW 8, TC 4, with
  `firId`, `firName`, `qualifier`, `base`, `top`, `chng`, `rawSigmet`).
  An empty answer is a 200 with an empty FeatureCollection and is cached like
  any snapshot. Polygon and MultiPolygon only; open rings are closed (the first
  sample had 20) and longitudes above 180 are folded (`193.167` → `-166.833`;
  three FIRs used 0..360 across the date line). Edges are not split at the
  antimeridian (the RFC asks for that; the globe draws great-circle edges in 3D
  and the shared validator does not check it). Unusable rings drop their
  polygon, bad holes are dropped, an advisory past its `validTimeTo` is skipped.
  Properties: `advisory` (`sigmet`/`airmet`), `hazard` (CONVECTIVE, TS, TURB,
  ICE, VA, TC, MTW, IFR, MTN OBSCN, …), `qualifier` (SEV, EMBD, FRQ, or the
  volcano/cyclone name), `severity` (US only), `fir`, `firName`, `base`, `top`
  (feet), `change`, `issuer`, `series`, `validFrom`, `validTo`, `raw` (≤ 1,500
  characters), `timestamp` (= `validFrom`). Movement is not structured: the US
  `movementDir` is a "moving from" bearing while the international `dir` is a
  "moving toward" compass point, so the raw text is shown instead of mixing them.
  Feature ids are `<advisory>-<issuer>-<series>-<hazard>-<validFrom>` with `-2`,
  `-3` for exact repeats (OIII series 03 appears twice in the sample). Size: about
  150 KB for 177 international advisories.
- **Why three subsources** — `metar`, `sigmet` (US) and `isigmet`: a failing
  endpoint does not hide the others, each has its own chip, and the US feed is
  usually empty or tiny while the international one is not.
- **Display** — METARs are small dots on the ellipsoid, larger for IFR/LIFR (5,
  6, 8, 9 px), standard chart colors; advisories are translucent fills with an
  outline in the hazard color (AIRMETs lighter). The Layers row has a chip per
  feed and a legend (flight categories worst first with counts, then the
  hazards present). A click opens a card (METAR: wind, visibility, ceiling,
  temperature, dew point, altimeter, weather, age, raw report; advisory: hazard,
  qualifier, advisory and issuer, FIR, altitude range as FL or feet, validity in
  UTC, trend and the advisory text) that opens aviationweather.gov on click.
- **Caveats** — AWC asks for fewer than 100 requests a minute; the layer makes
  three requests per 5 minutes per server regardless of viewers. Station names
  are not in the CSV (AWC's stations file is a separate download), so cards use
  the ICAO id. Polygons approximate the issued text. Informational only: not an
  official briefing or for flight planning. Voice: toggle only (no alias).

### Airspace Restrictions & Airport Delays (`airspace`, token `00`)

- **TFR list** — `https://tfr.faa.gov/tfrapi/exportTfrList` (JSON array, 76
  entries in the live sample: SECURITY 48, HAZARDS 14, VIP 6, AIR SHOWS/SPORTS
  6, UAS PUBLIC GATHERING 1, SPECIAL 1). Each entry has `notam_id` ("6/2117"),
  `type`, `facility`, `state`, `description` and `creation_date`, and **no
  geometry**. Only `<digits>/<digits>` ids are accepted (the id is spliced into
  the download URL); a repeated id keeps its first row; the list is capped at 300. A list that is not an array is a corrupt payload.
- **TFR geometry** — the keyless per-NOTAM XNOTAM download
  `https://tfr.faa.gov/download/detail_6_2117.xml` (the same file the FAA site
  links as "Sample XML Data Packet"; 10 to 200 KB, 512 KiB cap). One
  `TFRAreaGroup` per restricted area ("Area A", "Area B", …) carries the
  altitude limits (`aseTFRArea`: `HEI` = AGL, `ALT` = MSL, `FL` units in
  hundreds of feet), the FAA's merged outline (`abdMergedArea`: great-circle
  vertices, circles and arcs already flattened to 10-degree steps, in 61 of 76
  samples) and the original shapes (`aseShapes/Abd/Avx`: `GRC` positions, `CIR`
  circles with `valRadiusArc` and `uomRadiusArc`, `CWA`/`CCA` arcs about
  `geoLatArc`/`geoLongArc`). The layer uses the merged outline when it reads,
  else builds a polygon from the shapes: a circle is 36 vertices (every 10
  degrees of bearing) at exactly the radius on the mean sphere (1 NM = 1,852 m);
  an arc runs from the previous vertex to the next about its center, clockwise
  for `CWA` and counter-clockwise for `CCA`, in steps of at most 10 degrees.
  Checked against the FAA's own merged outlines on all 65 circle and arc areas
  in the live sample: the polygon areas agree within 0.8 percent. Rings are rounded to 5 decimals (~1 m), closed, wound
  counter-clockwise; a shape across the antimeridian, a vertex type this layer
  cannot draw (`FNT`, the national border), a collinear or out-of-range ring is
  skipped. Nationwide notices and the border TFRs (15 of 76) have no geometry:
  no feature, counted in `metadata.sources[].withoutGeometry`.
- **Times** — `dateEffective`/`dateExpire` are local times in `codeTimeZone`
  (UTC, EDT, CDT, MDT, PDT, AKDT, Guam, … are in the table); they become ISO
  UTC. A zone the table does not know leaves both times null rather than guess,
  the area is kept and the card says nothing about validity. No `dateExpire`
  means until further notice. A TFR past its expiry is dropped at every refresh
  from the cached geometry, without a download.
- **Caching and politeness** — a refresh is one list request plus a download
  for each TFR that is new, changed (`creation_date`), older than 6 hours or
  failed earlier, at most four at a time (the first read is ~76 downloads in
  about 2 seconds, then ~0 per refresh). A TFR that leaves the list drops its
  cache entry. A single failing download skips only that NOTAM (counted in
  `pendingDetails`, retried at the next refresh); if every download fails and
  nothing was ever read, the source fails (`upstream_unavailable`) instead of
  serving an empty map. The subsource timeout is 90 s.
- **TFR properties** — `notam`, `type` (the FAA's), `category` (`vip`,
  `security`, `hazards`, `airshow`, `uas`, `space`, `special`, `other`),
  `facility`, `state`, `description`, `location`, `regulation` (14 CFR section),
  `area`, `areaIndex`, `areaCount`, `lowerFt`/`lowerRef`, `upperFt`/`upperRef`
  (`AGL`, `MSL` or `FL`; an upper limit of 0 AGL is treated as unspecified),
  `scheduled` (the area has a daily schedule: the card says to read the notice),
  `effective`, `expire`, `text` (≤ 400 characters), `link`
  (`https://tfr.faa.gov/tfr3/?page=detail_6_2117`), `timestamp` (= issue time).
  Feature id `<notam>#<n>` (`tfr:6/2117#1` on the wire), n = the area's
  position in the notice.
- **Delays** — `https://nasstatus.faa.gov/api/airport-status-information`
  (XML, ~1 to 20 KB). Read from the published DTD
  (`https://nasstatus.faa.gov/AirportStatus.dtd`): `Ground_Stop_List/Program`
  (`ARPT`, `Reason`, `End_Time` as a text clock like "3:15 pm EDT"),
  `Ground_Delay_List/Ground_Delay` (`Avg`, `Max` as "1 hour and 30 minutes"),
  `Arrival_Departure_Delay_List/Delay` (one or two `Arrival_Departure Type=…`
  legs with `Min`, `Max`, `Trend`) and `Airport_Closure_List/Airport` (`Start`,
  `Reopen`). **Caveat: only the closure list had a live payload on the day this
  was built (a quiet day); the other three shapes were written from the DTD and
  hand-written fixtures, and the parser is tolerant (by list and element name,
  unknown lists such as CTOP and airspace flow ignored).** Closure windows
  prefer the dates inside the NOTAM text (`2605271826-2705281600`, full year)
  over the feed's year-less "May 27 at 18:26 UTC." (nearest year to now).
  Durations become minutes.
- **Airport positions** — the feed has FAA identifiers only.
  `https://aviationweather.gov/api/data/airport?ids=KJFK,KEWR&format=json` (keyless;
  204 when no id is known) is asked once per 40 airports with `K` + the FAA code,
  or the ICAO code from a built-in table for Alaska, Hawaii, Puerto Rico, the
  Virgin Islands and the Pacific territories (`HNL` → `PHNL`). A resolved
  position is kept in server memory for 7 days, an unknown identifier for 1 day;
  a failed lookup is never remembered as "unknown", and when delays exist but
  nothing could be resolved the source fails rather than serve an empty map.
  Airports with no position are not drawn (`unlocated` in the source status).
- **Delay properties** — one point per airport (id = the FAA identifier,
  `delays:JFK` on the wire): `airport`, `icao`, `name`, `delayType` (the most
  severe program: `ground-stop` > `ground-delay` > `arrival-delay` >
  `departure-delay` > `closure`; closures rank last on purpose, most entries in
  the closure list are partial NOTAM closures such as "closed to general
  aviation"), that program's own fields flattened (`reason`, `avg`, `max`,
  `min`, `trend`, `endTime`, `start`, `reopen`), `programCount`, `programs`
  (all of them), `link` (the NAS Status page) and `timestamp` (= the feed's
  update time).
- **Display** — TFRs are translucent areas, clamped to ground, colored by type
  (VIP red, security orange, hazards yellow, air shows blue, UAS violet, space
  cyan, special grey), fainter while only scheduled; delays are dots on the
  ellipsoid, larger for worse programs (13, 12, 11, 11, 10 px). The row has a
  chip per feed and a legend (TFR types, then delay programs, with counts). A
  click opens a card (TFR: place, area, altitude limits, validity in UTC, CFR
  section, notice excerpt; delay: airport name, every program, age) that
  opens the FAA page.
- **Caveats** — three upstream hosts, all keyless. Size: 84 areas in 150 KB of
  features plus 5 airports; the route body is about 160 KB. The kit's user agent
  is sent on every request. The airport table covers the airports the FAA lists
  today; an unlisted territory airport is simply not drawn. Informational only:
  the NOTAM text governs; not for flight planning. Voice: toggle only (no alias).

### Buoys & River Gauges (`water-observations`, token `01`)

- **Buoys** — `https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt` (about
  100 KB; 852 stations in the sample, 861 later the same day). Whitespace
  delimited: a `#STN LAT LON YYYY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD
PRES PTDY ATMP WTMP DEWP VIS TIDE` header, a `#text` units line, then one row
  per station. `MM` means "not reported" and becomes `null` (never 0 or NaN: a
  calm 0.0 m/s is a reading, a missing anemometer is not). Columns are located
  by name from the header, so a reordered or extended file still parses; the
  `+0.0` tendency spelling is read as a number. Time is `YYYY MM DD hh mm` UTC,
  checked to be a real calendar time. A row is skipped when its station id is
  not 3 to 8 letters or digits, its position is non-finite, out of range or
  exactly 0,0, its time is not real, older than 6 hours or more than an hour
  ahead of the server clock, its column count differs from the header, or no
  measurement survives. A value outside a plausible range (wind over 120 m/s,
  pressure outside 850 to 1100 hPa, …) is `null`, the rest of the row kept. A
  station listed twice keeps its newest row. A file with no `#STN` header, a
  missing required column, or no usable row is a corrupt payload, never an empty
  map. TTL 15 minutes (the file refreshes every 10).
- **Buoy properties** — id = the station id (`buoys:41008` on the wire):
  `station`, `windDir` (deg true), `windMs`/`windKt`, `gustMs`/`gustKt` (knots
  are metres per second x 3600 / 1852, rounded to 0.1), `waveM`, `wavePeriodS`,
  `avgPeriodS`, `waveDir`, `pressureHpa`, `pressureTrendHpa` (3-hour change),
  `airC`, `waterC`, `dewC`, `visNmi`, `tideFt`, `timestamp` (= observation
  time). All measurement keys are always present.
- **Rivers** — `https://api.water.noaa.gov/nwps/v1/gauges`, the National Water
  Prediction Service gauge list: about 12,950 gauges, each with `lid`, `name`,
  `state`, `latitude`/`longitude` and `status.observed` / `status.forecast`
  blocks (`primary`/`secondary` reading with their units, `floodCategory`,
  `validTime`). Categories seen: `no_flooding` 7,056, `not_defined` 4,081,
  `obs_not_current` 1,028, `out_of_service` 617, `low_threshold` 70, `action`
  52, `minor` 33, `moderate` 9, `major` 3 (observed, one day in October); a
  gauge is kept when the observed **or** the forecast category is `action`,
  `minor`, `moderate` or `major` (168 that day). **Why tiles:** the unfiltered
  list is 13 MB and took 41 s once and a 504 at 60 s the next time, and the
  service has no category filter; a bounding box (`bbox.xmin`, `ymin`, `xmax`,
  `ymax`, `srid=EPSG_4326`) is answered in 3 to 15 s. Eight fixed boxes cover
  every gauge with a position: one for Alaska and Hawaii (longitude -180 to
  -135), then strips -135 to -120, -120 to -105, -105 to -90 (split at latitude
  35), -90 to -75 (split at latitude 34) and -75 to -60 (with Puerto Rico and
  the Virgin Islands). They share their edges and are de-duplicated by id. They
  are fetched three at a time, a tile answering an HTTP error is asked once more,
  and one tile still failing fails the whole `rivers` subsource (timeout 120 s),
  so the last good snapshot is served stale rather than a map missing a region.
  If the tiles together list fewer than 1,000 gauges the answer is treated as
  broken (`invalid_payload`), so a service that answers empty lists cannot
  become "no flooding anywhere". No gauge at or above action stage, with the
  full list present, is a normal cached empty snapshot. Gauges published at
  0,0 (a few have no position) and gauges with a malformed id are skipped.
- **River properties** — id = the NWS location id (`rivers:ASTF1`): `gauge`,
  `name`, `state`, `category` (observed: `action`, `minor`, `moderate`, `major`
  or `null`), `forecastCategory` (same), `stageFt`, `flowKcfs` (taken by unit,
  because a few gauges report flow as the primary reading; -999 means none and
  becomes `null`), `forecastStageFt`, `timestamp` (= the observation time, `null`
  for the year-1 placeholder).
- **Not shipped** — USGS Water Services instantaneous values were the planned
  fallback and are not used: NWPS answered once tiled, and USGS carries no flood
  categories (it would need per-state requests and a threshold table).
- **Display** — buoys are dots on the ellipsoid colored by sustained wind
  (under 11, 11 to 21, 22 to 33, 34 to 47, 48 kt and over; grey when not
  reported) and 5 to 9 px by wave height; gauges are 9 to 12 px dots colored by
  the worse of the observed and forecast category (yellow action, orange
  minor, red moderate, magenta major), with a white ring while flooding now and
  a dark ring when only the forecast reaches action stage. A click opens a card
  (buoy: wind in knots, waves, pressure and change, air, water and dew point,
  visibility, tide, age; gauge: gauge id and state, category now, stage and
  flow, forecast category and stage, age) that opens the NDBC station page or
  the water.noaa.gov gauge page. The row has a chip per feed and a legend.
- **Caveats** — two upstream hosts, both keyless. Route body about 0.4 MB for
  the buoys plus a few tens of KB for the gauges. One refresh of the rivers
  feed is eight requests and about 13 MB downloaded; the kit's user agent is
  sent on each. NDBC reports are real-time and not quality-reviewed; flood
  categories are the NWS's own. Informational only: not for navigation, and not
  a flood warning. Voice: toggle only (no alias); the show_data_layers_menu tool
  description was shortened by 18 characters to fit the prompt budget.
