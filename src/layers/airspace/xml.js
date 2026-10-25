/**
 * A small, strict XML reader for the two FAA documents behind the Airspace
 * layer (the per-TFR XNOTAM detail and the NAS airport-status feed). Pure and
 * portable: no DOM, no Node imports. It builds a plain element tree and
 * nothing else — no DTD or external entity is ever read or expanded (a
 * `<!DOCTYPE>` is skipped), only the five predefined entities and numeric
 * character references are decoded, and node count and depth are capped, so
 * an upstream body cannot blow up memory.
 * @module layers/airspace/xml
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const MAX_NODES = 200_000;
const MAX_DEPTH = 64;

/** Error for a body that is not well-formed enough to read; never cached. */
function invalidXml(detail) {
  return Object.assign(new Error(detail), { code: 'invalid_payload' });
}

/** Decode predefined entities and numeric references; unknown ones stay as written. */
function decode(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, name) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}

/** `ns:Name` → `Name`: the documents are read by local name. */
const localName = (name) => name.slice(name.lastIndexOf(':') + 1);

function parseAttributes(source) {
  const attrs = {};
  for (const match of source.matchAll(
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
  ))
    attrs[localName(match[1])] = decode(match[2] ?? match[3]);
  return attrs;
}

/**
 * @typedef {Object} XmlElement
 * @property {string} name - Local element name (namespace prefix dropped).
 * @property {Object<string, string>} attrs
 * @property {XmlElement[]} children
 * @property {string} text - Direct text, entity-decoded, trimmed.
 */

/**
 * Parse an XML document into an element tree.
 * @param {string} text
 * @returns {XmlElement} The root element.
 * @throws {Error & {code: 'invalid_payload'}} For anything that is not a
 *   single well-formed element (mismatched tags, no root, too many nodes).
 */
export function parseXml(text) {
  if (typeof text !== 'string') throw invalidXml('XML body is not text');
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let root = null;
  const stack = [];
  let nodes = 0;
  let pos = 0;
  const addText = (raw) => {
    const top = stack[stack.length - 1];
    if (top) top.text += raw;
  };
  while (pos < source.length) {
    const lt = source.indexOf('<', pos);
    if (lt < 0) {
      addText(source.slice(pos));
      break;
    }
    if (lt > pos) addText(decode(source.slice(pos, lt)));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      if (end < 0) throw invalidXml('unterminated comment');
      pos = end + 3;
    } else if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      if (end < 0) throw invalidXml('unterminated CDATA');
      addText(source.slice(lt + 9, end));
      pos = end + 3;
    } else if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      if (end < 0) throw invalidXml('unterminated declaration');
      pos = end + 2;
    } else if (source.startsWith('<!', lt)) {
      // DOCTYPE and friends: skipped, never interpreted. A bracketed internal
      // subset ends at "]>".
      const bracket = source.indexOf('[', lt);
      const close = source.indexOf('>', lt);
      if (close < 0) throw invalidXml('unterminated declaration');
      if (bracket >= 0 && bracket < close) {
        const end = source.indexOf(']>', bracket);
        if (end < 0) throw invalidXml('unterminated DOCTYPE');
        pos = end + 2;
      } else pos = close + 1;
    } else if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt);
      if (end < 0) throw invalidXml('unterminated end tag');
      const name = localName(source.slice(lt + 2, end).trim());
      const open = stack.pop();
      if (!open || open.name !== name)
        throw invalidXml(`unexpected end tag </${name}>`);
      open.text = open.text.trim();
      pos = end + 1;
    } else {
      const end = findTagEnd(source, lt);
      if (end < 0) throw invalidXml('unterminated tag');
      let body = source.slice(lt + 1, end);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const nameEnd = body.search(/[\s]/);
      const rawName = nameEnd < 0 ? body : body.slice(0, nameEnd);
      if (!rawName) throw invalidXml('tag without a name');
      if (++nodes > MAX_NODES) throw invalidXml('too many elements');
      const element = {
        name: localName(rawName),
        attrs: nameEnd < 0 ? {} : parseAttributes(body.slice(nameEnd)),
        children: [],
        text: '',
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(element);
      else if (root) throw invalidXml('more than one root element');
      else root = element;
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw invalidXml('nesting too deep');
        stack.push(element);
      }
      pos = end + 1;
    }
  }
  if (stack.length) throw invalidXml(`unclosed <${stack.at(-1).name}>`);
  if (!root) throw invalidXml('no root element');
  return root;
}

/** Index of the `>` that closes the tag opening at `from`, skipping quoted attribute values. */
function findTagEnd(source, from) {
  let quote = null;
  for (let i = from + 1; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

/** Direct children of `element` named `name`. */
export function childrenNamed(element, name) {
  return element ? element.children.filter((child) => child.name === name) : [];
}

/** First direct child named `name`, or null. */
export function firstChild(element, name) {
  return element?.children.find((child) => child.name === name) ?? null;
}

/** Trimmed text of the first direct child named `name`; '' when absent. */
export function childText(element, name) {
  return firstChild(element, name)?.text ?? '';
}

/**
 * Every descendant named `name`, document order, not descending into a match.
 * @param {XmlElement} element
 * @param {string} name
 * @returns {XmlElement[]}
 */
export function descendantsNamed(element, name) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.name === name) found.push(child);
      else walk(child);
    }
  };
  if (element) walk(element);
  return found;
}
