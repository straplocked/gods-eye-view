# This fork

`straplocked/gods-eye-view` is a fork of
[`bilawalsidhu/gods-eye-view`](https://github.com/bilawalsidhu/gods-eye-view).
It adds two things on top of upstream `main`:

1. **Ten keyless live data layers**, built on one shared kit. None of them
   needs a paid or registered key; the server fetches each public feed itself,
   with the fork's User-Agent, a timeout, a byte cap and a per-subsource cache,
   and the browser only ever talks to the same-origin `/api/v1/layers/<id>`
   route.
2. **A production container image** published to GHCR and an Unraid template,
   for running the built app behind Nginx Proxy Manager
   ([docs/DEPLOY-UNRAID.md](DEPLOY-UNRAID.md)).

Nothing upstream was removed. The README sentence "Twenty layers and map
sources. Eighteen have a keyless path." is pinned by a test and still describes
the upstream catalog; the fork's layers are listed in the README table and
below.

## The shared kit

| Piece                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/providers/common/keylessFeed.js` | `createKeylessFeedProxy()`: one route per layer from independent subsources, TTL cache with stale-on-error, single-flight refresh, 60 s failure backoff, per-client rate limit, fixed upstream URLs, sanitized 502, per-subsource status in `metadata.sources[]`. The upstream client adds the User-Agent, `redirect: 'error'`, byte caps, gzip and `retries`; `mapLimited()` bounds parallel reads. |
| `server/providers/common/zip.js`         | Reads a single-entry zip (GDELT) with size caps and CRC-32 checks.                                                                                                                                                                                                                                                                                                                                   |
| `src/layers/common/geojson.js`           | RFC 7946 checks used by every normalizer, the kit and the tests.                                                                                                                                                                                                                                                                                                                                     |
| `src/layers/common/normalize.js`         | `invalidPayload()`, `toNumber()` and `httpsLink()`, shared by the normalizers.                                                                                                                                                                                                                                                                                                                       |
| `src/layers/common/featureSource.js`     | Portable client source for a keyless route (body cap, abort).                                                                                                                                                                                                                                                                                                                                        |
| `src/layers/common/featureLayer.js`      | Cesium feature layer with feed chips, cards through the world-overlay host and point picks.                                                                                                                                                                                                                                                                                                          |

The contract, failure semantics and the add-a-layer checklist are in
[docs/KEYLESS-FEEDS.md](KEYLESS-FEEDS.md).

## Keyless layers

Every route also answers `GET <route>/status` (cache state only; never fetches
upstream). TTLs are per subsource and are minimums: nothing is fetched more
often, however many people are viewing.

| Layer id                  | Token | Upstreams                                                                        | Route                                    | TTL per subsource                                           |
| ------------------------- | ----- | -------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| `global-hazards`          | `5`   | GDACS, NASA EONET                                                                | `/api/v1/layers/global-hazards`          | `gdacs` 15 min, `eonet` 30 min                              |
| `weather-warnings`        | `6`   | NWS alerts (api.weather.gov), NOAA tsunami.gov (NTWC, PTWC)                      | `/api/v1/layers/weather-warnings`        | `nws` 2 min (zones cached 7 days), `tsunami` 5 min          |
| `volcanoes`               | `7`   | Smithsonian GVP, USGS Volcano Hazards Program                                    | `/api/v1/layers/volcanoes`               | `gvp` 6 h, `usgs` 10 min                                    |
| `space-weather`           | `8`   | NOAA SWPC OVATION aurora, planetary Kp                                           | `/api/v1/layers/space-weather`           | `aurora` 5 min, `kp` 15 min                                 |
| `aviation-weather`        | `9`   | NOAA Aviation Weather Center METAR cache, US SIGMET/AIRMET, international SIGMET | `/api/v1/layers/aviation-weather`        | `metar`, `sigmet`, `isigmet` 5 min each                     |
| `airspace`                | `00`  | FAA TFR list + XNOTAM detail, FAA NAS Status, NOAA AWC airport lookup            | `/api/v1/layers/airspace`                | `tfr` 10 min (detail 6 h), `delays` 5 min (airports 7 days) |
| `water-observations`      | `01`  | NOAA NDBC latest observations, NOAA NWPS gauges                                  | `/api/v1/layers/water-observations`      | `buoys` 15 min, `rivers` 15 min                             |
| `citizen-sensors`         | `02`  | Sensor.Community, Safecast API                                                   | `/api/v1/layers/citizen-sensors`         | `airpm` 10 min, `radiation` 30 min                          |
| `internet-infrastructure` | `03`  | Georgia Tech IODA, PeeringDB                                                     | `/api/v1/layers/internet-infrastructure` | `outages` 10 min, `datacenters` 24 h                        |
| `news-events`             | `04`  | GDELT 2.0 GKG                                                                    | `/api/v1/layers/news-events`             | `gdelt` 15 min                                              |

Licences and attribution for each upstream are in
[DATA_SOURCES.md](../DATA_SOURCES.md); behaviour and caveats per layer are in
[docs/CURRENT-STATE.md](CURRENT-STATE.md) and
[docs/KEYLESS-FEEDS.md](KEYLESS-FEEDS.md).

### Sub-sources dropped or left out

- **USGS Water Services instantaneous values** (`water-observations`): not
  used. NWPS answers once it is read in bounding-box tiles, and it carries the
  flood categories; USGS has none and would need per-state requests plus a
  threshold table.
- **Safecast realtime devices feed** (`tt.safecast.org/devices`,
  `citizen-sensors`): rejected. It is mostly air-quality notes, repeats
  devices, and some entries carry contact names and e-mail addresses. The
  layer reads `api.safecast.org/measurements.json` instead.
- **FAA CTOP and airspace flow programs** (`airspace`): ignored for now; they
  have no airport and carry their own polygons.
- **GDACS areas, cyclone tracks and wind buffers** (`global-hazards`): not
  drawn; one centroid per event.

### Things to decide before a public deployment

- **PeeringDB** (`internet-infrastructure`, `datacenters` feed): its
  acceptable-use policy forbids bulk reproduction except for "Internet
  operational" use. The fork keeps the list in server memory only.
  **Accepted decision (2026-10-25, the operator):** the feed stays on for this
  deployment, which sits behind an NPM Access List login and is the operator's
  own research use. A deployment opened to other people needs PeeringDB's
  permission, or the feed turned off.
  Anonymous PeeringDB requests are throttled (HTTP 429 with a Retry-After of
  up to ~45 min); the kit waits out the Retry-After before asking again.
- **Smithsonian GVP** reuse terms could not be re-read (the site is behind bot
  verification); confirm them before commercial or bulk redistribution.
- **IODA** responses carry a Georgia Tech "all rights reserved" notice; data is
  read live and credited, not redistributed.
- **Voice prompt budget**: each layer's voice manifest entry adds to the
  Realtime prompt, which `src/voice/pointAndAsk.test.mjs` caps at 52,350
  characters; about 12 are spare. The next layer must trim, go voice-off or
  set a deliberate new budget (see the checklist in KEYLESS-FEEDS.md).

## Deploying

The published image (`ghcr.io/straplocked/gods-eye-view`, built from
`deploy/Dockerfile` by `.github/workflows/publish.yml`) serves the built app
with `vite preview`, keeps state in one `/data` volume and never trusts a peer
for key setup. Setup on Unraid behind Nginx Proxy Manager, the manual steps
(enable Actions, GHCR visibility, the NPM access list, `chown 99:100`) and the
known trade-offs are in [docs/DEPLOY-UNRAID.md](DEPLOY-UNRAID.md).

## Syncing with upstream

```sh
git fetch upstream
git merge upstream/main
```

Expect conflicts in the shared registries every keyless layer touches; keep
both sides of each list:

- `src/data/layerState.js` (`LAYER_STATE_REGISTRY`, alphabetical) and
  `src/data/layerStateTokenReservations.json`. Never renumber a published
  token. If upstream published a token the fork also took, run
  `npm run layer-token:check -- --base-ref upstream/main` and move the fork's
  layer to a fresh token from `npm run layer-token:next`.
- `src/app/constructCatalog.js`, `src/app/sourceComposition.js`,
  `src/sources/reference.js`, `server/providers/local.js`.
- `src/ui/layerNames.js`, `src/ui/layerPanel.js`, `src/voice/layerManifest.js`,
  `src/data/dataCredits.js`.
- `package.json` `exports`, `scripts/package-boundaries.json`,
  `scripts/format-scope.json`.
- `src/i18n/locales/{es,ru,zh-CN}.json` and `src/i18n/same-as-english.json`.
- The pinned tests: layer counts in `src/data/layerState.test.mjs`,
  `src/data/layerStateTokenLedger.test.mjs`, `src/app/constructCatalog.test.mjs`
  and `src/sources/reference.test.mjs`; the plugin and route table in
  `src/tooling/previewServing.test.mjs`; the Realtime payload pins in
  `src/firstRunExperience.test.mjs` and `src/voice/actionSchemas.test.mjs`;
  the prompt ceiling in `src/voice/pointAndAsk.test.mjs`. Re-derive these
  after the merge rather than picking a side.
- `README.md` "What's on the Globe", `DATA_SOURCES.md`,
  `docs/CURRENT-STATE.md`.

After the merge, run the full check in the container: `npm run format:check`,
`npm run check:boundaries`, `npm run layer-token:check -- --base-ref
upstream/main`, `npm test` and `npm run build`.
