import assert from 'node:assert/strict';
import test from 'node:test';
import {
  childText,
  childrenNamed,
  descendantsNamed,
  firstChild,
  parseXml,
} from './xml.js';

test('parses elements, attributes, text, self-closing tags and a byte-order mark', () => {
  const root = parseXml(
    '﻿<?xml version="1.0"?>\n<!-- note --><a x="1" ns:y=\'two\'>\n  <b>hello</b><c/><d k="a>b"/>\n  <b> world </b>\n</a>',
  );
  assert.equal(root.name, 'a');
  assert.deepEqual(root.attrs, { x: '1', y: 'two' });
  assert.deepEqual(
    root.children.map(({ name }) => name),
    ['b', 'c', 'd', 'b'],
  );
  assert.equal(childText(root, 'b'), 'hello');
  assert.deepEqual(
    childrenNamed(root, 'b').map(({ text }) => text),
    ['hello', 'world'],
  );
  // '>' inside a quoted attribute value does not end the tag.
  assert.equal(firstChild(root, 'd').attrs.k, 'a>b');
  assert.equal(childText(root, 'missing'), '');
  assert.equal(firstChild(null, 'b'), null);
});

test('decodes the predefined entities and numeric references only', () => {
  const root = parseXml(
    '<a>&lt;x&gt; &amp; &quot;q&quot; &apos;s&apos; &#65;&#x42; &unknown; &#0; <![CDATA[<raw & text>]]></a>',
  );
  assert.equal(root.text, '<x> & "q" \'s\' AB &unknown; &#0; <raw & text>');
});

test('a DOCTYPE with an internal subset is skipped and never expanded', () => {
  const root = parseXml(
    '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>',
  );
  assert.equal(root.text, '&lol2;');
  assert.equal(
    parseXml('<!DOCTYPE a SYSTEM "http://x/a.dtd"><a>ok</a>').text,
    'ok',
  );
});

test('namespace prefixes are dropped from element and attribute names', () => {
  const root = parseXml(
    '<x:Root xmlns:x="urn:x"><x:Item x:id="7">v</x:Item></x:Root>',
  );
  assert.equal(root.name, 'Root');
  assert.equal(firstChild(root, 'Item').attrs.id, '7');
});

test('descendantsNamed walks the tree in document order without entering a match', () => {
  const root = parseXml(
    '<r><g><i>1</i></g><i>2<i>inner</i></i><g><h><i>3</i></h></g></r>',
  );
  assert.deepEqual(
    descendantsNamed(root, 'i').map(({ text }) => text),
    ['1', '2', '3'],
  );
});

test('malformed documents throw an invalid_payload error', () => {
  for (const bad of [
    '',
    'not xml',
    '<a><b></a>',
    '<a>',
    '<a></a><b></b>',
    '<a></b>',
    '<a><!-- unterminated</a>',
    '<a><![CDATA[x</a>',
    '<a attr="x',
    '<?xml',
    '<!DOCTYPE x [ unterminated',
    '</a>',
    '< >',
  ]) {
    assert.throws(() => parseXml(bad), { code: 'invalid_payload' }, bad);
  }
  assert.throws(() => parseXml(null), { code: 'invalid_payload' });
  assert.throws(() => parseXml(42), { code: 'invalid_payload' });
});

test('element count and nesting depth are capped', () => {
  const deep = `${'<a>'.repeat(80)}${'</a>'.repeat(80)}`;
  assert.throws(() => parseXml(deep), { code: 'invalid_payload' });
  const wide = `<r>${'<i/>'.repeat(200_001)}</r>`;
  assert.throws(() => parseXml(wide), { code: 'invalid_payload' });
  const fine = parseXml(`<r>${'<i/>'.repeat(1000)}</r>`);
  assert.equal(fine.children.length, 1000);
});
