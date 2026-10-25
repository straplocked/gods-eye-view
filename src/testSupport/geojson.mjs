// Test helpers over the shared GeoJSON validator (src/layers/common/geojson.js).
// Not a test file: the unit runner only collects *.test.mjs.
import assert from 'node:assert/strict';
import {
  validateFeatureCollection,
  validateKeylessLayerCollection,
} from '../layers/common/geojson.js';

/**
 * Assert that a value is a valid RFC 7946 FeatureCollection, listing every
 * validator error in the failure message.
 * @param {unknown} collection
 * @param {{requireIds?: boolean}} [options]
 */
export function assertValidFeatureCollection(collection, options) {
  const { ok, errors } = validateFeatureCollection(collection, options);
  assert.ok(ok, `invalid FeatureCollection:\n  ${errors.join('\n  ')}`);
}

/**
 * Assert that a keyless proxy response satisfies the layer contract
 * (docs/KEYLESS-FEEDS.md), metadata included.
 * @param {unknown} collection
 * @param {string} layerId
 */
export function assertValidKeylessLayerCollection(collection, layerId) {
  const { ok, errors } = validateKeylessLayerCollection(collection, {
    layerId,
    requireMetadata: true,
  });
  assert.ok(ok, `invalid ${layerId} collection:\n  ${errors.join('\n  ')}`);
}
