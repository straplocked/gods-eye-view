import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { newsEventsProxy } from '../../server/providers/newsEvents.js';
import { assertValidKeylessLayerCollection } from '../testSupport/geojson.mjs';
import { buildZip } from '../testSupport/zip.mjs';
import {
  BATCH,
  KYIV,
  NOW_MS,
  batchCsv,
  batchZip,
  gkgLine,
  pointerText,
} from '../testSupport/newsEventsFixtures.mjs';

const MINUTE = 60_000;
const POINTER_URL = 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt';
const zipUrl = (stamp = BATCH) =>
  `https://data.gdeltproject.org/gdeltv2/${stamp}.gkg.csv.zip`;

/** The pointer text and zip bytes GDELT would serve for a CSV batch. */
function serve(csv = batchCsv(), stamp = BATCH) {
  return batchZip(csv, stamp);
}

/**
 * Upstream double: lastupdate.txt and the GKG zip it names. `pointer` and
 * `zip` are functions so a test can change them between requests.
 */
function upstream({ pointer, zip } = {}) {
  const calls = [];
  const state = { current: serve() };
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    assert.match(options.headers['User-Agent'], /^GodsEyeView\/fork \(\+/);
    const parsed = new URL(url);
    // Only the GDELT host, over https, is ever contacted.
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.hostname, 'data.gdeltproject.org');
    if (String(url) === POINTER_URL)
      return pointer ? pointer() : new Response(state.current.pointer);
    if (parsed.pathname.endsWith('.gkg.csv.zip'))
      return zip ? zip() : new Response(state.current.zip);
    throw new Error(`unexpected upstream ${url}`);
  };
  return { calls, fetchImpl, state };
}

function install(options = {}, hook = 'configureServer') {
  let handler;
  const plugin = newsEventsProxy({ now: () => NOW_MS, ...options });
  assert.equal(plugin.name, 'news-events');
  assert.equal(typeof plugin.configureServer, 'function');
  assert.equal(typeof plugin.configurePreviewServer, 'function');
  plugin[hook]({
    middlewares: {
      use(path, callback) {
        assert.equal(path, '/api/v1/layers/news-events');
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

const gdelt = (res) =>
  res.body.metadata.sources.find(({ id }) => id === 'gdelt');
const zipCalls = (calls) =>
  calls.filter((url) => url.endsWith('.gkg.csv.zip')).length;
const pointerCalls = (calls) =>
  calls.filter((url) => url === POINTER_URL).length;

for (const hook of ['configureServer', 'configurePreviewServer']) {
  test(`${hook}: serves the newest GKG batch as one valid collection`, async () => {
    const { calls, fetchImpl } = upstream();
    const request = install({ fetchImpl }, hook);
    const res = await request('/?url=https://invalid.example/x.zip&ref=1');
    assert.equal(res.status, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assertValidKeylessLayerCollection(res.body, 'news-events');
    // Fixed upstream URLs: the client query went nowhere.
    assert.deepEqual(calls, [POINTER_URL, zipUrl()]);
    assert.deepEqual(
      res.body.features.map((feature) => feature.id),
      [
        'gdelt:-2102835',
        'gdelt:-1044367',
        'gdelt:423587',
        'gdelt:BR',
        'gdelt:-2089956',
      ],
    );
    const lucknow = res.body.features[0];
    assert.equal(lucknow.properties.layer, 'news-events');
    assert.equal(lucknow.properties.source, 'gdelt');
    assert.equal(lucknow.properties.timestamp, '2026-10-25T08:30:00.000Z');
    assert.equal(lucknow.properties.articleCount, 2);
    assert.equal(res.body.metadata.partial, false);
    assert.equal(res.body.metadata.stale, false);
    assert.deepEqual(gdelt(res), {
      batch: '2026-10-25T08:45:00.000Z',
      records: 6,
      geolocated: 5,
      locations: 5,
      corruptLines: 3,
      skippedBlocks: 3,
      md5Verified: true,
      id: 'gdelt',
      ok: true,
      stale: false,
      count: 5,
      fetchedAt: '2026-10-25T09:00:00.000Z',
      truncated: false,
    });
  });
}

test('guard: a zip whose md5 differs from the pointer is rejected, even though it is a perfectly good zip', async () => {
  const { zip, pointer } = serve();
  const wrongMd5 = pointer.replace(
    createHash('md5').update(zip).digest('hex'),
    '0'.repeat(32),
  );
  const { fetchImpl } = upstream({ pointer: () => new Response(wrongMd5) });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'news_events_unavailable' });
});

test('guard: a hand-built tiny zip with a wrong md5 is rejected, the same bytes with the right md5 are read', async () => {
  const csv = `${gkgLine({ url: 'https://tiny.example/a', locations: KYIV })}\n`;
  const tiny = buildZip(`${BATCH}.gkg.csv`, csv);
  const md5 = createHash('md5').update(tiny).digest('hex');
  const wrong = md5.replace(/^./, md5[0] === 'a' ? 'b' : 'a');
  for (const [claimed, status] of [
    [wrong, 502],
    [md5, 200],
  ]) {
    const { fetchImpl } = upstream({
      pointer: () =>
        new Response(pointerText({ size: tiny.length, md5: claimed })),
      zip: () => new Response(tiny),
    });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, status, `md5 ${claimed}`);
    if (status === 200) assert.equal(res.body.features.length, 1);
  }
});

test('a zip of the wrong size, wrong entry name or wrong shape is refused', async () => {
  const good = serve();
  const cases = {
    'size differs from the pointer': {
      pointer: () =>
        new Response(pointerText({ size: good.zip.length + 1, md5: good.md5 })),
    },
    'entry is not a GKG csv': (() => {
      const zip = buildZip('malware.exe', batchCsv());
      return {
        zip: () => new Response(zip),
        pointer: () =>
          new Response(
            pointerText({
              size: zip.length,
              md5: createHash('md5').update(zip).digest('hex'),
            }),
          ),
      };
    })(),
    'not a zip at all': (() => {
      const bytes = Buffer.from('<html>maintenance</html>');
      return {
        zip: () => new Response(bytes),
        pointer: () =>
          new Response(
            pointerText({
              size: bytes.length,
              md5: createHash('md5').update(bytes).digest('hex'),
            }),
          ),
      };
    })(),
  };
  for (const [label, options] of Object.entries(cases)) {
    const { fetchImpl } = upstream(options);
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502, label);
  }
});

test('the batch is cached for 15 minutes; an unchanged pointer costs no second download', async () => {
  let clock = NOW_MS;
  const { calls, fetchImpl, state } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  await request();
  clock = NOW_MS + 15 * MINUTE - 1;
  await request();
  assert.deepEqual([pointerCalls(calls), zipCalls(calls)], [1, 1]);
  // TTL over: the pointer is read again, but it still names the same batch.
  clock = NOW_MS + 15 * MINUTE;
  const same = await request();
  assert.equal(same.status, 200);
  assert.deepEqual([pointerCalls(calls), zipCalls(calls)], [2, 1]);
  assert.equal(same.body.features.length, 5);
  // A new batch is downloaded.
  state.current = serve(
    `${gkgLine({ url: 'https://new.example/a', locations: KYIV })}\n`,
    '20261025090000',
  );
  clock = NOW_MS + 30 * MINUTE;
  const fresh = await request();
  assert.deepEqual([pointerCalls(calls), zipCalls(calls)], [3, 2]);
  assert.equal(calls.at(-1), zipUrl('20261025090000'));
  assert.deepEqual(
    fresh.body.features.map((feature) => feature.id),
    ['gdelt:-1044367'],
  );
  assert.equal(gdelt(fresh).batch, '2026-10-25T09:00:00.000Z');
});

test('a failed refresh serves the last good batch as stale, without upstream detail', async () => {
  let clock = NOW_MS;
  const { fetchImpl } = upstream({
    pointer: () => {
      if (clock > NOW_MS) throw new Error('private upstream details');
      return new Response(serve().pointer);
    },
  });
  const request = install({ fetchImpl, now: () => clock });
  assert.equal((await request()).status, 200);
  clock = NOW_MS + 15 * MINUTE;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.headers['X-Data-Stale'], 'true');
  assert.equal(stale.body.metadata.stale, true);
  assert.deepEqual(
    [
      gdelt(stale).ok,
      gdelt(stale).stale,
      gdelt(stale).count,
      gdelt(stale).error,
    ],
    [false, true, 5, 'upstream_unavailable'],
  );
  assert.equal(stale.body.features.length, 5);
  assert.doesNotMatch(JSON.stringify(stale.body), /private/);
});

/**
 * Upstream double whose zip files exist only for the stamps in `files`
 * (stamp to zip bytes); every other batch answers 404. `asked` lists the
 * stamps requested, in order.
 */
function upstreamWithFiles(files) {
  const asked = [];
  const { fetchImpl } = upstream();
  const wrapped = async (url, options) => {
    if (String(url).endsWith('.gkg.csv.zip')) {
      const stamp = String(url).split('/').pop().slice(0, 14);
      asked.push(stamp);
      return files[stamp]
        ? new Response(files[stamp])
        : new Response('', { status: 404 });
    }
    return fetchImpl(url, options);
  };
  return { asked, fetchImpl: wrapped };
}
const olderBatch = () =>
  serve(
    `${gkgLine({ url: 'https://old.example/a', locations: KYIV })}\n`,
    '20261025083000',
  );

test('when the pointed file is missing (404) the newest earlier batch is served, flagged as not md5-checked', async () => {
  const { asked, fetchImpl } = upstreamWithFiles({
    20261025083000: olderBatch().zip,
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assert.deepEqual(asked, ['20261025084500', '20261025083000']);
  assertValidKeylessLayerCollection(res.body, 'news-events');
  assert.equal(gdelt(res).batch, '2026-10-25T08:30:00.000Z');
  assert.equal(gdelt(res).md5Verified, false);
  assert.equal(res.body.features.length, 1);
});

test('a fallback batch is reused while the pointed file stays missing; the pointed file is picked up when it appears', async () => {
  let clock = NOW_MS;
  const files = { 20261025083000: olderBatch().zip };
  const { asked, fetchImpl } = upstreamWithFiles(files);
  const request = install({ fetchImpl, now: () => clock });
  assert.equal(gdelt(await request()).batch, '2026-10-25T08:30:00.000Z');
  assert.deepEqual(asked, ['20261025084500', '20261025083000']);
  // Next refresh: the pointed file is probed again, the fallback is not
  // downloaded a second time.
  clock = NOW_MS + 15 * MINUTE;
  assert.equal(gdelt(await request()).batch, '2026-10-25T08:30:00.000Z');
  assert.deepEqual(asked.slice(2), ['20261025084500']);
  assert.equal(asked.filter((s) => s === '20261025083000').length, 1);
  // The file appears.
  files[BATCH] = serve().zip;
  clock = NOW_MS + 30 * MINUTE;
  const fresh = await request();
  assert.equal(gdelt(fresh).batch, '2026-10-25T08:45:00.000Z');
  assert.equal(gdelt(fresh).md5Verified, true);
});

test('no file for the pointed batch or the six before it fails the feed and is not cached', async () => {
  let clock = NOW_MS;
  const { asked, fetchImpl } = upstreamWithFiles({});
  const request = install({ fetchImpl, now: () => clock });
  const res = await request();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'news_events_unavailable' });
  assert.deepEqual(asked, [
    '20261025084500',
    '20261025083000',
    '20261025081500',
    '20261025080000',
    '20261025074500',
    '20261025073000',
    '20261025071500',
  ]);
  const status = await request('/status');
  assert.deepEqual(
    status.body.sources.map(({ cached, lastError }) => [cached, lastError]),
    [[false, 'upstream_status']],
  );
});

test('only a 404 falls back: another HTTP error fails the refresh without trying other batches', async () => {
  const asked = [];
  const { fetchImpl } = upstream({
    zip: () => {
      asked.push('zip');
      return new Response('', { status: 503 });
    },
  });
  assert.equal((await install({ fetchImpl })()).status, 502);
  assert.deepEqual(asked, ['zip']);
});

test('a batch with no readable record is never cached as an empty map', async () => {
  let clock = NOW_MS;
  let csv = 'garbage\nlines\n';
  const { calls, fetchImpl, state } = upstream();
  const request = install({ fetchImpl, now: () => clock });
  state.current = serve(csv);
  const bad = await request();
  assert.equal(bad.status, 502);
  assert.deepEqual(bad.body, { error: 'news_events_unavailable' });
  // Inside the failure backoff nothing is retried.
  await request();
  assert.equal(zipCalls(calls), 1);
  // After it, a healthy batch with the same stamp is read: the bad one was
  // not remembered as the answer for that stamp.
  csv = batchCsv();
  state.current = serve(csv);
  clock = NOW_MS + MINUTE;
  const healed = await request();
  assert.equal(healed.status, 200);
  assert.equal(healed.body.features.length, 5);
  assert.equal(zipCalls(calls), 2);
});

test('oversized pointers, zips and inflated files are capped; the failure is sanitized', async () => {
  const huge = (declared) => () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      }),
      {
        headers: declared ? { 'Content-Length': String(64 * 1024 * 1024) } : {},
      },
    );
  for (const declared of [true, false]) {
    // The pointer's size is small and fine: the body is what is capped.
    const { fetchImpl } = upstream({ zip: huge(declared) });
    const res = await install({ fetchImpl })();
    assert.equal(res.status, 502, `declared ${declared}`);
    assert.deepEqual(res.body, { error: 'news_events_unavailable' });
  }
  // A pointer that itself names an oversized zip never triggers a download.
  const { calls, fetchImpl } = upstream({
    pointer: () => new Response(pointerText({ size: 11 * 1024 * 1024 })),
  });
  assert.equal((await install({ fetchImpl })()).status, 502);
  assert.equal(zipCalls(calls), 0);
  // A zip whose header declares more than the 80 MB cap is refused uninflated.
  const bomb = buildZip(`${BATCH}.gkg.csv`, batchCsv(), {
    declaredSize: 90 * 1024 * 1024,
  });
  const bombMd5 = createHash('md5').update(bomb).digest('hex');
  const bombed = upstream({
    pointer: () =>
      new Response(pointerText({ size: bomb.length, md5: bombMd5 })),
    zip: () => new Response(bomb),
  });
  const res = await install({ fetchImpl: bombed.fetchImpl })();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'news_events_unavailable' });
});

test('only the busiest 2,000 places are served and the cut is reported', async () => {
  const lines = [];
  for (let index = 0; index < 2100; index++)
    lines.push(
      gkgLine({
        id: `p-${index}`,
        url: `https://news.example/p-${index}`,
        locations: `4#Town ${index}, Land#XX#XX00#0#${(index % 170) - 85}#${(index % 350) - 175}#${5000 + index}#1`,
      }),
    );
  // The last place read has three articles (p-2099 and two more): it must survive the cut.
  for (const extra of ['x', 'y'])
    lines.push(
      gkgLine({
        id: `p-last-${extra}`,
        url: `https://news.example/last-${extra}`,
        locations: `4#Town 2099, Land#XX#XX00#0#${(2099 % 170) - 85}#${(2099 % 350) - 175}#7099#1`,
      }),
    );
  // Several towns share coordinates mod 170/350; FeatureIDs keep them apart.
  const csv = `${lines.join('\n')}\n`;
  const big = serve(csv);
  const { fetchImpl } = upstream({
    pointer: () => new Response(big.pointer),
    zip: () => new Response(big.zip),
  });
  const res = await install({ fetchImpl })();
  assert.equal(res.status, 200);
  assertValidKeylessLayerCollection(res.body, 'news-events');
  assert.equal(res.body.features.length, 2000);
  assert.equal(gdelt(res).truncated, true);
  assert.equal(gdelt(res).count, 2000);
  assert.equal(gdelt(res).locations, 2100);
  assert.equal(res.body.features[0].id, 'gdelt:7099');
  assert.equal(res.body.features[0].properties.articleCount, 3);
  // Everything else has a single article: the cut took only those.
  assert.ok(
    res.body.features.slice(1).every((f) => f.properties.articleCount === 1),
  );
});

test('concurrent requests share one pointer read and one download', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { calls, fetchImpl } = upstream({
    pointer: async () => {
      await pending;
      return new Response(serve().pointer);
    },
  });
  const request = install({ fetchImpl });
  const responses = [request(), request('/', 'GET', 'other')];
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual([pointerCalls(calls), zipCalls(calls)], [1, 0]);
  release();
  for (const res of await Promise.all(responses)) assert.equal(res.status, 200);
  assert.deepEqual([pointerCalls(calls), zipCalls(calls)], [1, 1]);
});

test('non-GET requests never fetch upstream; unknown sub-routes are 404', async () => {
  const { calls, fetchImpl } = upstream();
  const request = install({ fetchImpl });
  for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
    const res = await request('/', method);
    assert.equal(res.status, 405);
    assert.equal(res.headers.Allow, 'GET');
  }
  assert.equal((await request('/anything')).status, 404);
  assert.equal(calls.length, 0);
  const status = await request('/status');
  assert.deepEqual(
    status.body.sources.map(({ id, cached }) => [id, cached]),
    [['gdelt', false]],
  );
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
