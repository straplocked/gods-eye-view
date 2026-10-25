/**
 * Portable client source for a keyless layer route (/api/v1/layers/<id>,
 * served by server/providers/common/keylessFeed.js). No Cesium, DOM or i18n
 * catalog: failures stay English data that the Layers panel translates by
 * shape ("<source> HTTP <status>", "Malformed <source> response").
 * @module layers/common/featureSource
 */
import { readResponseJsonCapped } from '../../sources/httpBody.js';
import { validateKeylessLayerCollection } from './geojson.js';

/** Same-origin route for a keyless layer (mirrors the server's keylessLayerRoute). */
export function keylessLayerPath(layerId) {
  return `/api/v1/layers/${layerId}`;
}

/**
 * Create a snapshot source over one keyless layer route. `getSnapshot`
 * resolves `{features, metadata}` only for a body that passes the layer
 * contract, so a corrupt response can never replace the displayed snapshot.
 * @param {Object} options
 * @param {string} options.layerId - Layer id (route suffix and properties.layer).
 * @param {string} options.label - English source name used in error text.
 * @param {number} [options.maxBytes=32 MiB] - Response body cap.
 * @param {Function} [options.fetchImpl]
 * @returns {{getSnapshot: (options?: {signal?: AbortSignal}) => Promise<{features: Array<Object>, metadata: Object}>}}
 */
export function createKeylessFeatureSource({
  layerId,
  label,
  maxBytes = 32 * 1024 * 1024,
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (typeof layerId !== 'string' || !layerId)
    throw new TypeError('Keyless feature source needs a layer id');
  const name = label || layerId;
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(keylessLayerPath(layerId), { signal });
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw Object.assign(new Error(`${name} HTTP ${response.status}`), {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
      }
      let payload;
      try {
        payload = await readResponseJsonCapped(response, maxBytes, signal);
      } catch (error) {
        if (signal?.aborted || error?.code === 'RESPONSE_TOO_LARGE')
          throw error;
        throw new Error(`Malformed ${name} response`);
      }
      signal?.throwIfAborted();
      const { ok } = validateKeylessLayerCollection(payload, {
        layerId,
        requireMetadata: true,
      });
      if (!ok) throw new Error(`Malformed ${name} response`);
      return { features: payload.features, metadata: payload.metadata };
    },
  };
}
