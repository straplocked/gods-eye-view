import { msg } from '../../i18n/marker.js';
import { createKeylessFeatureSource } from '../common/featureSource.js';
import { INTERNET_INFRASTRUCTURE_LAYER_ID } from './records.js';

/**
 * Request the IODA internet outage markers and PeeringDB data centers through
 * the same-origin keyless route (/api/v1/layers/internet-infrastructure).
 * Portable: no i18n catalog, Cesium or DOM; failures stay English data the
 * Layers panel translates. The 4 MiB cap is above the ~2.3 MB that ~5,300
 * facilities and a few dozen outage markers serialize to.
 * @param {{fetchImpl?: Function}} [options]
 */
export function createInternetInfrastructureSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return createKeylessFeatureSource({
    layerId: INTERNET_INFRASTRUCTURE_LAYER_ID,
    label: msg('Internet Outages & Data Centers'),
    maxBytes: 4 * 1024 * 1024,
    fetchImpl,
  });
}
