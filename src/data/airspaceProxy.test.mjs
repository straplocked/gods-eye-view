import test from 'node:test';
import assert from 'node:assert/strict';
import { airspaceProxy } from '../../server/providers/airspace.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import {
  AWC_AIRPORTS,
  FAA_STATUS_EMPTY_XML,
  FAA_STATUS_XML,
  NOW_MS,
  TFR_DETAILS,
  TFR_LIST,
  area,
  grc,
  xnotam,
} from '../testSupport/airspaceFixtures.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const LIST_PATH = '/tfrapi/exportTfrList';
const STATUS_PATH = '/api/airport-status-information';
const AIRPORT_PATH = '/api/data/airport';
const detailPath = (notamId) =>
  `/download/detail_${notamId.replace('/', '_')}.xml`;
const isDetail = (pathname) => pathname.startsWith('/download/detail_');

const xml = (body) =>
  new Response(body, { headers: { 'Content-Type': 'application/xml' } });

/** The AWC lookup as the real service answers: known ids as JSON, 204 for none. */
function awcLookup(url) {
  const ids = url.searchParams.get('ids').split(',');
  const found = ids
    .filter((id) => AWC_AIRPORTS[id])
    .map((id) => AWC_AIRPORTS[id]);
  return found.length
    ? Response.json(found)
    : new Response(null, { status: 204 });
}

/** Upstream double for tfr.faa.gov, nasstatus.faa.gov and aviationweather.gov, with per-call overrides. */
function upstream({
  list = () => Response.json(TFR_LIST),
  detail = (notamId) =>
    TFR_DETAILS[notamId]
      ? xml(TFR_DETAILS[notamId])
      : new Response('not found', { status: 404 }),
  status = () => xml(FAA_STATUS_XML),
  airports = awcLookup,
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork \(\+/);
    if (parsed.hostname === 'tfr.faa.gov') {
      if (parsed.pathname === LIST_PATH) return list();
      if (isDetail(parsed.pathname))
        return detail(
          parsed.pathname
            .replace('/download/detail_', '')
            .replace('.xml', '')
            .replace('_', '/'),
          parsed,
        );
    }
    if (
      parsed.hostname === 'nasstatus.faa.gov' &&
      parsed.pathname === STATUS_PATH
    )
      return status();
    if (
      parsed.hostname === 'aviationweather.gov' &&
      parsed.pathname === AIRPORT_PATH
    )
      return airports(parsed);
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, fetchImpl };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = airspaceProxy({ now: () => NOW_MS, ...options });
  assert.equal(plugin.name, 'airspace');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/airspace');
        handler = callback;
      },
    },
  });
  return async (url = '/', method = 'GET', peer = 'local') => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ url, method, socket: { remoteAddress: peer } }, res);
    return res;
  };
}

const sourceMeta = (res, id) =>
  res.body.metadata.sources.find((entry) => entry.id === id);
const count = (calls, predicate) =>
  calls.filter(({ url }) => predicate(url)).length;
const listCalls = (calls) => count(calls, (url) => url.pathname === LIST_PATH);
const detailCalls = (calls) => count(calls, (url) => isDetail(url.pathname));
const statusCalls = (calls) =>
  count(calls, (url) => url.pathname === STATUS_PATH);
const airportCalls = (calls) =>
  count(calls, (url) => url.pathname === AIRPORT_PATH);
const idsOf = (res, source) =>
  res.body.features
    .filter((feature) => feature.properties.source === source)
    .map((feature) => feature.id);

const LIVE_TFR_IDS = [
  'tfr:6/2117#1',
  'tfr:6/0100#1',
  'tfr:6/1751#1',
  'tfr:6/2102#1',
  'tfr:6/1500#1',
  'tfr:6/1500#2',
  'tfr:6/0002#1',
];

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves TFR areas and airport delays as one valid collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl }, hook);
    const res = await request('/?url=https://invalid.example&notam=6/1');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'airspace');
    // Fixed upstream URLs: the client query went nowhere.
    assert.deepEqual([...new Set(calls.map(({ url }) => url.origin))].sort(), [
      'https://aviationweather.gov',
      'https://nasstatus.faa.gov',
      'https://tfr.faa.gov',
    ]);
    assert.ok(calls.every(({ url }) => !url.searchParams.has('notam')));
    // 6/0001 is expired and 6/9954 has no geometry: neither is served.
    assert.deepEqual(idsOf(res, 'tfr'), LIVE_TFR_IDS);
    assert.deepEqual(idsOf(res, 'delays'), [
      'delays:EWR',
      'delays:JFK',
      'delays:ORD',
      'delays:HNL',
      'delays:ASE',
    ]);
    assert.equal(res.body.metadata.partial, false);
    assert.deepEqual(
      res.body.metadata.sources.map(({ id, count: n, ok }) => [id, n, ok]),
      [
        ['tfr', 7, true],
        ['delays', 5, true],
      ],
    );
    // Status details: 8 listed, 1 without geometry, none missing; 6 airports, 1 unlocated.
    assert.deepEqual(
      [
        sourceMeta(res, 'tfr').listed,
        sourceMeta(res, 'tfr').withoutGeometry,
        sourceMeta(res, 'tfr').pendingDetails,
      ],
      [8, 1, 0],
    );
    assert.deepEqual(
      [sourceMeta(res, 'delays').airports, sourceMeta(res, 'delays').unlocated],
      [6, 1],
    );
  });
}

test('GUARD: the proxy serves a ground-delay airport as a point at the resolved coordinates', async () => {
  const { fetchImpl } = upstream();
  const res = await install({ fetchImpl })();
  const ewr = res.body.features.find((feature) => feature.id === 'delays:EWR');
  assert.deepEqual(ewr.geometry, {
    type: 'Point',
    coordinates: [-74.1687, 40.6925],
  });
  assert.equal(ewr.properties.delayType, 'ground-delay');
  assert.equal(ewr.properties.avg, 90);
  assert.equal(ewr.properties.max, 184);
  assert.equal(ewr.properties.source, 'delays');
  const jfk = res.body.features.find((feature) => feature.id === 'delays:JFK');
  assert.deepEqual(jfk.geometry.coordinates, [-73.7787, 40.6399]);
  assert.equal(jfk.properties.delayType, 'ground-stop');
  // The circle TFR (6/0100) is served as a closed 36-vertex polygon.
  const circle = res.body.features.find((f) => f.id === 'tfr:6/0100#1');
  assert.equal(circle.geometry.coordinates[0].length, 37);
});

test('airport ids are looked up once, as ICAO codes, in one request', async () => {
  const { calls, fetchImpl } = upstream();
  await install({ fetchImpl })();
  const lookups = calls.filter(({ url }) => url.pathname === AIRPORT_PATH);
  assert.equal(lookups.length, 1);
  assert.equal(
    lookups[0].url.search,
    '?ids=KEWR,KJFK,KORD,KZZZ,PHNL,KASE&format=json',
  );
});

test('the TFR list refreshes after 10 minutes and delays after 5; geometry and airports are not re-read', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  await request();
  assert.equal(detailCalls(calls), 8);
  clock = NOW_MS + 5 * MINUTE - 1;
  await request();
  assert.deepEqual([listCalls(calls), statusCalls(calls)], [1, 1]);
  clock = NOW_MS + 5 * MINUTE;
  await request();
  assert.deepEqual([listCalls(calls), statusCalls(calls)], [1, 2]);
  clock = NOW_MS + 10 * MINUTE - 1;
  await request();
  assert.deepEqual([listCalls(calls), statusCalls(calls)], [1, 2]);
  clock = NOW_MS + 10 * MINUTE;
  const res = await request();
  assert.deepEqual([listCalls(calls), statusCalls(calls)], [2, 3]);
  // Eight XNOTAM downloads in total, and one airport lookup: both cached.
  assert.equal(detailCalls(calls), 8);
  assert.equal(airportCalls(calls), 1);
  assert.deepEqual(idsOf(res, 'tfr'), LIVE_TFR_IDS);
});

test('airport positions last a week, an unknown code a day', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  await request();
  // 25 hours on: only the code the lookup did not know (ZZZ) is asked again.
  clock = NOW_MS + 25 * HOUR;
  await request();
  const lookups = calls.filter(({ url }) => url.pathname === AIRPORT_PATH);
  assert.equal(lookups.length, 2);
  assert.equal(lookups[1].url.search, '?ids=KZZZ&format=json');
  // Seven days and an hour on: everything is asked again.
  clock = NOW_MS + 7 * 24 * HOUR + HOUR;
  await request();
  const again = calls.filter(({ url }) => url.pathname === AIRPORT_PATH);
  assert.equal(again.length, 3);
  assert.equal(
    again[2].url.search,
    '?ids=KEWR,KJFK,KORD,KZZZ,PHNL,KASE&format=json',
  );
});

test('a TFR geometry is cached until it leaves the list, re-read when its list entry changes or after six hours', async () => {
  let clock = NOW_MS;
  let rows = TFR_LIST;
  const { calls, fetchImpl } = upstream({ list: () => Response.json(rows) });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  assert.equal(detailCalls(calls), 8);

  // 6/2117 leaves the list: its feature goes, nothing is downloaded.
  rows = TFR_LIST.filter((row) => row.notam_id !== '6/2117');
  clock = NOW_MS + 10 * MINUTE;
  let res = await request();
  assert.equal(detailCalls(calls), 8);
  assert.equal(idsOf(res, 'tfr').includes('tfr:6/2117#1'), false);
  assert.equal(sourceMeta(res, 'tfr').listed, 7);

  // It comes back (the cache entry was dropped with it): downloaded again.
  rows = TFR_LIST;
  clock = NOW_MS + 20 * MINUTE;
  res = await request();
  assert.equal(detailCalls(calls), 9);
  assert.equal(
    calls.filter(({ url }) => url.pathname === detailPath('6/2117')).length,
    2,
  );
  assert.ok(idsOf(res, 'tfr').includes('tfr:6/2117#1'));

  // An amended entry (new creation date): only that NOTAM is downloaded again.
  rows = TFR_LIST.map((row) =>
    row.notam_id === '6/0100' ? { ...row, creation_date: '10/25/2026' } : row,
  );
  clock = NOW_MS + 30 * MINUTE;
  await request();
  assert.equal(detailCalls(calls), 10);
  assert.equal(
    calls.filter(({ url }) => url.pathname === detailPath('6/0100')).length,
    2,
  );

  // After six hours every cached geometry is read again.
  rows = TFR_LIST;
  clock = NOW_MS + 6 * HOUR + 31 * MINUTE;
  await request();
  assert.equal(detailCalls(calls) - 10, 8);
});

test('a TFR that expires between list refreshes is dropped without a download', async () => {
  let clock = NOW_MS;
  const shortLived = xnotam({
    seq: 77,
    effective: '2026-10-25T09:00:00',
    expire: '2026-10-25T11:30:00',
    areas: [
      area({
        merged: [
          grc('40.0N', '100.0W'),
          grc('40.0N', '099.9W'),
          grc('39.9N', '099.9W'),
          grc('40.0N', '100.0W'),
        ],
      }),
    ],
  });
  const { calls, fetchImpl } = upstream({
    list: () =>
      Response.json([
        { notam_id: '6/0077', type: 'HAZARDS', facility: 'ZKC', state: 'NE' },
      ]),
    detail: () => xml(shortLived),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.deepEqual(idsOf(await request(), 'tfr'), ['tfr:6/0077#1']);
  clock = NOW_MS + HOUR;
  const res = await request();
  assert.deepEqual(idsOf(res, 'tfr'), []);
  assert.equal(sourceMeta(res, 'tfr').ok, true);
  assert.equal(detailCalls(calls), 1);
});

test('NOTAM downloads run at most four at a time', async () => {
  let inFlight = 0;
  let peak = 0;
  const rows = Array.from({ length: 12 }, (_, i) => ({
    notam_id: `6/${String(100 + i).padStart(4, '0')}`,
    type: 'HAZARDS',
    facility: 'ZKC',
    state: 'NE',
  }));
  const { calls, fetchImpl } = upstream({
    list: () => Response.json(rows),
    detail: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return xml(TFR_DETAILS['6/2117']);
    },
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(detailCalls(calls), 12);
  assert.equal(peak, 4);
});

test('one subsource failing: the other still serves and nothing is cached for the failed one', async () => {
  let clock = NOW_MS;
  let corrupt = true;
  const { calls, fetchImpl } = upstream({
    status: () =>
      corrupt ? xml('<html>maintenance</html>') : xml(FAA_STATUS_XML),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'airspace');
  assert.deepEqual(idsOf(res, 'tfr'), LIVE_TFR_IDS);
  assert.deepEqual(idsOf(res, 'delays'), []);
  assert.deepEqual(sourceMeta(res, 'delays'), {
    id: 'delays',
    ok: false,
    stale: false,
    count: 0,
    fetchedAt: null,
    truncated: false,
    error: 'invalid_payload',
  });
  assert.equal(res.body.metadata.partial, true);
  const status = await request('/status');
  assert.deepEqual(
    status.body.sources.map(({ id, cached, lastError }) => [
      id,
      cached,
      lastError,
    ]),
    [
      ['tfr', true, null],
      ['delays', false, 'invalid_payload'],
    ],
  );
  // Within the failure backoff nothing is retried; after it the feed is asked again.
  assert.equal(statusCalls(calls), 1);
  corrupt = false;
  clock = NOW_MS + MINUTE;
  const recovered = await request();
  assert.equal(statusCalls(calls), 2);
  assert.equal(sourceMeta(recovered, 'delays').ok, true);
  assert.equal(idsOf(recovered, 'delays').length, 5);
});

test('the TFR list failing while delays are fine: delays served, TFR ok:false', async () => {
  const { fetchImpl } = upstream({
    list: () => new Response('busy', { status: 503 }),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'airspace');
  assert.equal(res.body.features.length, 5);
  assert.equal(sourceMeta(res, 'tfr').error, 'upstream_status');
  assert.equal(sourceMeta(res, 'tfr').ok, false);
});

test('single NOTAM downloads failing skip only those NOTAMs, and only those are retried', async () => {
  let clock = NOW_MS;
  let broken = true;
  const { calls, fetchImpl } = upstream({
    detail: (notamId) => {
      if (broken && notamId === '6/0100')
        return new Response('gone', { status: 503 });
      if (broken && notamId === '6/1751') return xml('<html>oops</html>');
      return xml(TFR_DETAILS[notamId]);
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'airspace');
  assert.equal(sourceMeta(res, 'tfr').ok, true);
  assert.equal(sourceMeta(res, 'tfr').pendingDetails, 2);
  assert.deepEqual(idsOf(res, 'tfr'), [
    'tfr:6/2117#1',
    'tfr:6/2102#1',
    'tfr:6/1500#1',
    'tfr:6/1500#2',
    'tfr:6/0002#1',
  ]);
  broken = false;
  clock = NOW_MS + 10 * MINUTE;
  const healed = await request();
  assert.equal(sourceMeta(healed, 'tfr').pendingDetails, 0);
  assert.equal(idsOf(healed, 'tfr').length, 7);
  // 8 first time + the two that failed.
  assert.equal(detailCalls(calls), 10);
});

test('when every NOTAM download fails and nothing was ever read, the TFR source fails instead of serving an empty map', async () => {
  let clock = NOW_MS;
  let down = true;
  const { fetchImpl } = upstream({
    detail: (notamId) =>
      down ? new Response('busy', { status: 503 }) : xml(TFR_DETAILS[notamId]),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'tfr').ok, false);
  assert.equal(sourceMeta(res, 'tfr').error, 'upstream_unavailable');
  assert.equal(sourceMeta(res, 'tfr').count, 0);
  assert.equal(sourceMeta(res, 'delays').ok, true);
  const status = await request('/status');
  assert.equal(status.body.sources[0].cached, false);
  down = false;
  clock = NOW_MS + MINUTE;
  const recovered = await request();
  assert.equal(sourceMeta(recovered, 'tfr').ok, true);
  assert.equal(idsOf(recovered, 'tfr').length, 7);
});

test('the airport lookup failing with nothing known fails the delays source; delays resume when it recovers', async () => {
  let clock = NOW_MS;
  let down = true;
  const { calls, fetchImpl } = upstream({
    airports: (url) =>
      down ? new Response('busy', { status: 503 }) : awcLookup(url),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'delays').ok, false);
  assert.equal(sourceMeta(res, 'delays').error, 'upstream_unavailable');
  assert.equal(sourceMeta(res, 'delays').count, 0);
  assert.equal(idsOf(res, 'tfr').length, 7);
  // A failed lookup is not remembered as "unknown airport".
  down = false;
  clock = NOW_MS + MINUTE;
  const recovered = await request();
  assert.equal(sourceMeta(recovered, 'delays').ok, true);
  assert.equal(idsOf(recovered, 'delays').length, 5);
  assert.equal(airportCalls(calls), 2);
});

test('with positions cached, a failing airport lookup still serves the delays that are known', async () => {
  let clock = NOW_MS;
  let down = false;
  const extra = FAA_STATUS_XML.replace(
    '</Ground_Delay_List>',
    '<Ground_Delay><ARPT>LAX</ARPT><Reason>wind</Reason><Avg>30 minutes</Avg><Max>1 hour</Max></Ground_Delay></Ground_Delay_List>',
  );
  let body = FAA_STATUS_XML;
  const { fetchImpl } = upstream({
    status: () => xml(body),
    airports: (url) =>
      down ? new Response('busy', { status: 503 }) : awcLookup(url),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal(idsOf(await request(), 'delays').length, 5);
  // LAX is new; its lookup fails; the five cached airports stay.
  body = extra;
  down = true;
  clock = NOW_MS + 5 * MINUTE;
  const res = await request();
  assert.equal(sourceMeta(res, 'delays').ok, true);
  assert.equal(idsOf(res, 'delays').length, 5);
  assert.equal(sourceMeta(res, 'delays').unlocated, 2);
});

test('a failed refresh serves the last good snapshot as stale', async () => {
  let clock = NOW_MS;
  let fail = false;
  const { fetchImpl } = upstream({
    list: () => {
      if (fail) throw new Error('private upstream details');
      return Response.json(TFR_LIST);
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  await request();
  fail = true;
  clock = NOW_MS + 10 * MINUTE;
  const res = await request();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-Data-Stale'], 'true');
  assert.equal(res.body.metadata.stale, true);
  const tfr = sourceMeta(res, 'tfr');
  assert.deepEqual(
    [tfr.ok, tfr.stale, tfr.count, tfr.error],
    [false, true, 7, 'upstream_unavailable'],
  );
  assert.equal(res.body.features.length, 12);
  assert.doesNotMatch(JSON.stringify(res.body), /private/);
});

test('no TFRs and no delays are cached like any snapshot and are not errors', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    list: () => Response.json([]),
    status: () => xml(FAA_STATUS_EMPTY_XML),
  });
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'airspace');
  assert.deepEqual(res.body.features, []);
  assert.equal(sourceMeta(res, 'tfr').ok, true);
  assert.equal(sourceMeta(res, 'delays').ok, true);
  clock = NOW_MS + 4 * MINUTE;
  await request();
  assert.deepEqual([listCalls(calls), statusCalls(calls)], [1, 1]);
  // No airports means no lookup at all.
  assert.equal(airportCalls(calls), 0);
});

test('oversized streamed and declared bodies are capped; everything failing gives a sanitized 502', async () => {
  for (const declared of [true, false]) {
    let cancelled = 0;
    const huge = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled++;
          },
        }),
        {
          headers: declared
            ? { 'Content-Length': String(64 * 1024 * 1024) }
            : {},
        },
      );
    const { fetchImpl } = upstream({ list: huge, status: huge });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502);
    assert.deepEqual(res.body, { error: 'airspace_unavailable' });
    assert.ok(cancelled >= 1, 'oversized body was not cancelled');
  }
});

test('an oversized NOTAM download skips that NOTAM only', async () => {
  const { fetchImpl } = upstream({
    detail: (notamId) =>
      notamId === '6/2117'
        ? xml(`${TFR_DETAILS['6/2117']}${' '.repeat(600 * 1024)}`)
        : xml(TFR_DETAILS[notamId]),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.equal(sourceMeta(res, 'tfr').pendingDetails, 1);
  assert.equal(idsOf(res, 'tfr').includes('tfr:6/2117#1'), false);
  assert.equal(idsOf(res, 'tfr').length, 6);
});

test('malformed data from both feeds never becomes a cached empty snapshot', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl } = upstream({
    list: () => Response.json({ error: 'upstream detail' }),
    status: () => xml('<html>error</html>'),
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 502);
  clock = NOW_MS + MINUTE;
  const again = await request();
  assert.equal(again.status, 502);
  assert.deepEqual(again.body, { error: 'airspace_unavailable' });
  assert.equal(listCalls(calls), 2);
  assert.equal(statusCalls(calls), 2);
});

test('concurrent requests share one upstream operation per feed and per NOTAM', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    list: async () => {
      await pending;
      return Response.json(TFR_LIST);
    },
    status: async () => {
      await pending;
      return xml(FAA_STATUS_XML);
    },
  });
  const request = install({ fetchImpl });
  const responses = [request(), request('/', 'GET', 'other')];
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.equal(listCalls(calls), 1);
  assert.equal(statusCalls(calls), 1);
  assert.equal(detailCalls(calls), 8);
  assert.equal(airportCalls(calls), 1);
});

test('non-GET requests never fetch upstream', async () => {
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl });
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
    const res = await request('/', method);
    assert.equal(res.status, 405);
    assert.equal(res.headers.Allow, 'GET');
  }
  assert.equal(calls.length, 0);
});

test('an unknown sub-route is a 404 and never reaches the FAA', async () => {
  const { calls, fetchImpl } = upstream();
  const res = await install({ fetchImpl })('/anything');
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test('a client over the rate limit gets 429 with Retry-After', async () => {
  const { fetchImpl } = upstream();
  const request = install({ fetchImpl });
  let limited = null;
  for (let i = 0; i < 80 && !limited; i++) {
    const res = await request('/', 'GET', 'noisy');
    if (res.status === 429) limited = res;
  }
  assert.ok(limited, 'no 429 after 80 requests');
  assert.equal(limited.headers['Retry-After'], '60');
  assert.deepEqual(limited.body, { error: 'rate_limited' });
});
