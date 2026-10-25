/**
 * Generic globe layer for a keyless FeatureCollection route: points, lines
 * and polygons styled per feature, one click card through the world-overlay
 * host, and one Layers-panel chip per subsource. A keyless layer is mostly
 * configuration over this (see docs/KEYLESS-FEEDS.md): a source, a style
 * function, a card function and its subsource list.
 *
 * Lifecycle follows the earthquake and fire-perimeter layers: one request
 * token aborted on disable/destroy, late results dropped, entities swapped in
 * one suspended batch only when the snapshot changed, no per-frame work (the
 * render governor needs no hold). World text goes through the overlay host
 * only; Cesium text labels are forbidden.
 * @module layers/common/featureLayer
 */
import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import {
  countBySource,
  featureAnchor,
  partialFeedError,
  safeExternalLink,
  subsourceChips,
  visibleFeatures,
} from './featureModel.js';

const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

const DEFAULT_STYLE = Object.freeze({
  color: '#ffd54f',
  outlineColor: '#000000',
  pixelSize: 9,
  outlineWidth: 1,
  fillAlpha: 0.25,
  lineWidth: 2,
  outline: true,
  clampToGround: true,
});

const toCartesian = ([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat);

function pointGraphics(style, color) {
  return {
    pixelSize: style.pixelSize,
    color,
    outlineColor: Cesium.Color.fromCssColorString(style.outlineColor),
    outlineWidth: style.outlineWidth,
    // A point that is not clamped sits on the ellipsoid; with the depth test
    // disabled below it still draws over terrain. Thousands of clamped points
    // (Aviation Weather's METARs) would each track terrain height updates.
    heightReference:
      style.clampToGround === false
        ? Cesium.HeightReference.NONE
        : Cesium.HeightReference.CLAMP_TO_GROUND,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
  };
}

function lineGraphics(positions, style, color) {
  return {
    positions,
    clampToGround: true,
    width: style.lineWidth,
    material: new Cesium.ColorMaterialProperty(color.withAlpha(0.9)),
  };
}

/**
 * Cesium entity options for one geometry; `kind` says whether a pick on it
 * is a point (owned in the pick registry) or a line/area (never owned, so
 * large areas cannot swallow sibling layers' clicks).
 */
function geometryParts(geometry, style, color) {
  const c = geometry.coordinates;
  switch (geometry.type) {
    case 'Point':
      return [
        {
          kind: 'point',
          position: toCartesian(c),
          point: pointGraphics(style, color),
        },
      ];
    case 'MultiPoint':
      return c.map((position) => ({
        kind: 'point',
        position: toCartesian(position),
        point: pointGraphics(style, color),
      }));
    case 'LineString':
      return [
        {
          kind: 'line',
          polyline: lineGraphics(c.map(toCartesian), style, color),
        },
      ];
    case 'MultiLineString':
      return c.map((line) => ({
        kind: 'line',
        polyline: lineGraphics(line.map(toCartesian), style, color),
      }));
    case 'Polygon':
    case 'MultiPolygon': {
      const polygons = geometry.type === 'Polygon' ? [c] : c;
      return polygons.map(([outer, ...holes]) => {
        const outerPositions = outer.map(toCartesian);
        return {
          kind: 'area',
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              outerPositions,
              holes.map(
                (hole) => new Cesium.PolygonHierarchy(hole.map(toCartesian)),
              ),
            ),
            material: new Cesium.ColorMaterialProperty(
              color.withAlpha(style.fillAlpha),
            ),
          },
          // Entity polygons cannot outline clamped geometry themselves. A
          // style with `outline: false` is a fill only (Aurora's probability
          // bands, where the outline would draw seams between neighbors).
          ...(style.outline === false
            ? {}
            : { polyline: lineGraphics(outerPositions, style, color) }),
        };
      });
    }
    case 'GeometryCollection':
      return geometry.geometries.flatMap((child) =>
        geometryParts(child, style, color),
      );
    default:
      return [];
  }
}

/**
 * Create one keyless feature layer.
 * @param {Object} options
 * @param {string} options.id - Layer id (also the overlay source id).
 * @param {string} options.name - English layer name.
 * @param {string} options.icon
 * @param {string} options.sourceName - English source label for the panel row.
 * @param {{getSnapshot: Function}} options.source - Resolves `{features, metadata}`.
 * @param {Array<{id: string, label: string, title?: string, chip?: boolean}>} [options.subsources] - Row chips; labels are English msg() keys. `chip: false` keeps the name for the "feed unavailable" status without a toggle (a feed with no features of its own).
 * @param {(feature: Object) => Object} [options.style] - `{color, outlineColor, pixelSize, outlineWidth, fillAlpha, lineWidth, outline}` (CSS colors; `outline: false` draws areas without an outline; `clampToGround: false` draws points on the ellipsoid instead of tracking terrain, for layers with thousands of points).
 * @param {(feature: Object, nowMs: number, metadata: ?Object) => {title: string, details: string[], accent: string, link?: string}} options.card - `metadata` is the latest response's `metadata` member.
 * @param {(features: Array<Object>, metadata: ?Object) => Array<Object>} [options.legend] - Panel legend rows for the visible features.
 * @param {(metadata: ?Object, nowMs: number) => ?{text: string, title?: string}} [options.rowInfo] - A line under the panel row built from the response `metadata` (Aurora & Space Weather shows the latest Kp); null hides it.
 * @param {(feature: Object, anchor: {lon: number, lat: number}) => Object} [options.analystRecord]
 * @param {number} [options.updateInterval=300000]
 * @returns {Object} Layer module (init/enable/disable/update/destroy/getStats/getRowControls/getAnalystRecords).
 */
export function createKeylessFeatureLayer({
  id,
  name,
  icon,
  sourceName,
  source,
  subsources = [],
  style = () => DEFAULT_STYLE,
  card,
  legend = null,
  rowInfo = null,
  analystRecord = null,
  updateInterval = 300_000,
  overlayHost = null,
  screenSpaceEventHandlerFactory = null,
  picking = null,
  pointer = null,
  openExternal = null,
} = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError(`${name} requires a snapshot source`);
  if (typeof card !== 'function')
    throw new TypeError(`${name} requires a card builder`);
  const logTag = `[Data:${name.replace(/\s+/g, '')}]`;
  const feedNames = new Map(
    subsources.map(({ id: sub, label }) => [sub, label]),
  );
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _features = [];
  let _metadata = null;
  let _signature = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _clickHandler = null;
  let _selectedId = null;
  let _selectedCardId = null;
  let _selectedLink = null;
  let _rowListener = null;
  const _hidden = new Set();
  /** @type {Map<string, {feature: Object, anchor: {lon: number, lat: number}}>} */
  const _rendered = new Map();
  /** @type {Map<string, string>} entity id → feature id */
  const _entityFeature = new Map();
  /** Entity ids of point parts, the only picks this layer claims. */
  const _pointEntities = new Set();

  const canSelect = () =>
    Boolean(overlayHost && screenSpaceEventHandlerFactory && picking);
  const notifyRow = () => {
    try {
      _rowListener?.();
    } catch (error) {
      console.warn(`${logTag} row listener error:`, error);
    }
  };

  function publishSelectedCard() {
    if (!overlayHost) return;
    const row = _selectedId ? _rendered.get(_selectedId) : null;
    if (!row) {
      _selectedId = null;
      _selectedLink = null;
      _selectedCardId = null;
      overlayHost.setEntries(id, [], CARD_HOST_OPTIONS);
      return;
    }
    const model = card(row.feature, Date.now(), _metadata);
    const link = openExternal ? safeExternalLink(model.link) : null;
    const entry = {
      id: `${id}-card:${row.feature.id}`,
      // `selected` picks the paint lane and collision protection.
      selected: true,
      // Only a linked card is clickable: the host registers hit rectangles
      // solely for interactive entries.
      interactive: Boolean(link),
      ...(link
        ? {
            accessibilityLabel: t('Open {title} source page', {
              title: model.title,
            }),
            activate: () => {
              openExternal(link);
              return true;
            },
          }
        : {}),
      title: model.title,
      details: model.details,
      accent: model.accent,
      priority: Number.MAX_SAFE_INTEGER,
      gapPx: 15,
      verticalOnly: true,
      placement: 'above',
      position: Cesium.Cartesian3.fromDegrees(row.anchor.lon, row.anchor.lat),
    };
    _selectedLink = link;
    _selectedCardId = entry.id;
    overlayHost.setEntries(id, [entry], CARD_HOST_OPTIONS);
  }

  function clearSelection() {
    _selectedId = null;
    _selectedLink = null;
    _selectedCardId = null;
    if (overlayHost) {
      overlayHost.clearSource(id);
      overlayHost.setVisible?.(id, false);
    }
  }

  /** Rebuild the entities for the visible subsources in one batch. */
  function render() {
    if (!_dataSource) return;
    const shown = visibleFeatures(_features, _hidden);
    const entities = [];
    _rendered.clear();
    _entityFeature.clear();
    _pointEntities.clear();
    for (const feature of shown) {
      const anchor = featureAnchor(feature.geometry);
      if (!anchor) continue;
      const featureStyle = { ...DEFAULT_STYLE, ...(style(feature) || {}) };
      const color = Cesium.Color.fromCssColorString(featureStyle.color);
      geometryParts(feature.geometry, featureStyle, color).forEach(
        ({ kind, ...graphics }, index) => {
          const entityId = `${id}:${feature.id}:${index}`;
          _entityFeature.set(entityId, feature.id);
          if (kind === 'point') _pointEntities.add(entityId);
          entities.push(new Cesium.Entity({ id: entityId, ...graphics }));
        },
      );
      _rendered.set(feature.id, { feature, anchor });
    }
    const collection = _dataSource.entities;
    collection.suspendEvents();
    try {
      collection.removeAll();
      for (const entity of entities) collection.add(entity);
    } finally {
      collection.resumeEvents();
    }
    _count = _rendered.size;
    if (_selectedId) publishSelectedCard();
  }

  function toggleSubsource(subsourceId) {
    if (_hidden.has(subsourceId)) _hidden.delete(subsourceId);
    else _hidden.add(subsourceId);
    render();
    notifyRow();
  }

  /** Resolve a scene pick to one of this layer's feature ids, or null. */
  function pickedFeatureId(picked) {
    const pickId = picking.resolvePickId(picked);
    return typeof pickId === 'string'
      ? (_entityFeature.get(pickId) ?? null)
      : null;
  }

  function installClickHandler() {
    if (!canSelect() || _clickHandler || !_viewer) return;
    // Only point picks are registered as owned: polygons and lines can cover
    // whole regions and would otherwise make sibling cards inert under them.
    picking.registerPickOwner?.(id, (pickId) => _pointEntities.has(pickId));
    _clickHandler = screenSpaceEventHandlerFactory(_viewer);
    _clickHandler.setInputAction((click) => {
      if (pointer && !pointer.isPointerFree()) return;
      const cardHit = overlayHost.hitTest?.(
        click.position?.x,
        click.position?.y,
        { sourceId: id },
      );
      if (cardHit && cardHit.entryId === _selectedCardId) {
        if (_selectedLink && openExternal) openExternal(_selectedLink);
        return;
      }
      const picked = _viewer.scene.pick(click.position);
      const featureId = picked ? pickedFeatureId(picked) : null;
      if (featureId) {
        _selectedId = featureId;
        overlayHost.setVisible?.(id, true);
        publishSelectedCard();
        return;
      }
      // A sibling layer's pick is not "empty space": leave the card alone.
      if (picked) {
        const pickId = picking.resolvePickId(picked);
        if (pickId && picking.isOwnedByOtherLayer(id, pickId)) return;
      }
      if (_selectedId) {
        _selectedId = null;
        publishSelectedCard();
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    picking?.unregisterPickOwner?.(id);
    if (_clickHandler) {
      _clickHandler.destroy();
      _clickHandler = null;
    }
  }

  const layer = {
    id,
    name,
    icon,
    source: sourceName,
    updateInterval,

    init(viewer) {
      if (_viewer) throw new Error(`${name} layer is already initialized`);
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      overlayHost?.setVisible?.(id, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.(id, true);
      installClickHandler();
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      removeClickHandler();
      clearSelection();
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const features = Array.isArray(snapshot?.features)
          ? snapshot.features
          : [];
        _metadata = snapshot?.metadata ?? null;
        const signature = JSON.stringify(features);
        if (signature !== _signature) {
          _features = features;
          _signature = signature;
          render();
        } else if (_selectedId) publishSelectedCard();
        _lastUpdate = Date.now();
        _lastError = partialFeedError(snapshot?.metadata, feedNames);
        _stale = snapshot?.metadata?.stale === true;
        notifyRow();
        return true;
      } catch (error) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn(`${logTag} Fetch error:`, error);
        _lastError = error?.message || msg('Source unavailable');
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      removeClickHandler();
      clearSelection();
      _rendered.clear();
      _entityFeature.clear();
      _pointEntities.clear();
      _features = [];
      _metadata = null;
      _signature = null;
      _rowListener = null;
      _viewer = null;
      _enabled = false;
      if (_dataSource) {
        viewer?.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    /** Panel row: one chip per subsource, plus the configured legend. */
    getRowControls() {
      const counts = countBySource(_features);
      const info = rowInfo ? rowInfo(_metadata, Date.now()) : null;
      return {
        ...(info?.text
          ? {
              info: info.text,
              ...(info.title ? { infoTitle: info.title } : {}),
            }
          : {}),
        chips: subsourceChips(
          subsources
            .filter((entry) => entry.chip !== false)
            .map((entry) => ({
              id: entry.id,
              label: t(entry.label),
              title: t('{source}: {count} loaded · click to show or hide', {
                source: t(entry.label),
                count: counts.get(entry.id) || 0,
              }),
            })),
          _hidden,
          toggleSubsource,
        ),
        legend: legend
          ? legend(
              [..._rendered.values()].map(({ feature }) => feature),
              _metadata,
            )
          : [],
      };
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    /** Snapshot visible features as plain records for the analyst engine. */
    getAnalystRecords(maxCount = 2000) {
      if (!_enabled) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const result = [];
      for (const { feature, anchor } of _rendered.values()) {
        if (result.length >= limit) break;
        result.push(
          analystRecord
            ? analystRecord(feature, anchor)
            : { id: feature.id, lat: anchor.lat, lon: anchor.lon },
        );
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        degraded: Boolean(_lastError && _lastUpdate),
      };
    },
  };
  return layer;
}
