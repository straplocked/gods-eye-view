import assert from 'node:assert/strict';
import test from 'node:test';
import { httpsLink, invalidPayload, toNumber } from './normalize.js';

test('invalidPayload carries the code the keyless kit maps', () => {
  const error = invalidPayload('feed is not a list');
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'invalid_payload');
  assert.equal(error.message, 'feed is not a list');
});

test('toNumber reads finite numbers and numeric strings only', () => {
  assert.equal(toNumber(4.5), 4.5);
  assert.equal(toNumber('-12.25'), -12.25);
  assert.equal(toNumber(' 7 '), 7);
  assert.equal(toNumber(0), 0);
  for (const value of [
    '',
    '  ',
    'MM',
    'null',
    NaN,
    Infinity,
    null,
    undefined,
    true,
    {},
    [],
  ])
    assert.equal(toNumber(value), null, `${String(value)} is not a number`);
});

test('httpsLink keeps credential-free https links on the allowed hosts', () => {
  assert.equal(
    httpsLink(' https://www.gdacs.org/report.aspx?eventid=1 '),
    'https://www.gdacs.org/report.aspx?eventid=1',
  );
  assert.equal(httpsLink('http://www.gdacs.org/'), null);
  assert.equal(httpsLink('javascript:alert(1)'), null);
  assert.equal(httpsLink('https://user:pw@www.gdacs.org/'), null);
  assert.equal(httpsLink('not a url'), null);
  assert.equal(httpsLink(42), null);
  assert.equal(httpsLink(`https://a.example/${'x'.repeat(2048)}`), null);

  const hosts = ['www.tsunami.gov', 'tsunami.gov'];
  assert.equal(
    httpsLink('https://tsunami.gov/x', hosts),
    'https://tsunami.gov/x',
  );
  assert.equal(httpsLink('https://evil.tsunami.gov.example/x', hosts), null);

  const usgs = /(?:^|\.)usgs\.gov$/;
  assert.equal(
    httpsLink('https://volcanoes.usgs.gov/v', usgs),
    'https://volcanoes.usgs.gov/v',
  );
  assert.equal(httpsLink('https://usgs.gov.example/v', usgs), null);
});
