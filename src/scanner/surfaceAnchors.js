import { clamp } from './coverageModel';
import { descriptorDistance } from './featureTracking';

const DEFAULT_MAX_ANCHORS = 72;

function colorDistance(first = {}, second = {}) {
  const red = (first.r || 0) - (second.r || 0);
  const green = (first.g || 0) - (second.g || 0);
  const blue = (first.b || 0) - (second.b || 0);
  return Math.sqrt(red ** 2 + green ** 2 + blue ** 2) / 441.7;
}

function matchAnchorFeatures(anchorFeatures = [], currentFeatures = [], options = {}) {
  const maximumDescriptorDistance = options.maximumDescriptorDistance ?? 0.78;
  const ratio = options.ratio ?? 0.9;
  const candidates = [];

  anchorFeatures.forEach((source) => {
    let best = null;
    let second = null;
    currentFeatures.forEach((target, targetIndex) => {
      const descriptor = descriptorDistance(source.descriptor, target.descriptor);
      if (!Number.isFinite(descriptor)) return;
      const rank = descriptor + colorDistance(source.color, target.color) * 0.12;
      const candidate = { source, target, targetIndex, descriptor, rank };
      if (!best || rank < best.rank) {
        second = best;
        best = candidate;
      } else if (!second || rank < second.rank) {
        second = candidate;
      }
    });
    if (!best || best.descriptor > maximumDescriptorDistance) return;
    if (second && best.rank > second.rank * ratio) return;
    candidates.push(best);
  });

  const usedTargets = new Set();
  return candidates
    .sort((first, second) => first.rank - second.rank)
    .filter((candidate) => {
      if (usedTargets.has(candidate.targetIndex)) return false;
      usedTargets.add(candidate.targetIndex);
      return true;
    });
}

function transformPoint(point, transform) {
  const denominator = (transform.g || 0) * point.x + (transform.h || 0) * point.y + 1;
  if (Math.abs(denominator) < 0.000001) return { ...point, x: Infinity, y: Infinity };
  return {
    ...point,
    x: (transform.a * point.x + transform.b * point.y + transform.tx) / denominator,
    y: (transform.c * point.x + transform.d * point.y + transform.ty) / denominator,
  };
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const values = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(values[row][column]) > Math.abs(values[pivot][column])) pivot = row;
    }
    if (Math.abs(values[pivot][column]) < 0.0000001) return null;
    [values[column], values[pivot]] = [values[pivot], values[column]];
    const divisor = values[column][column];
    for (let index = column; index <= size; index += 1) values[column][index] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const multiplier = values[row][column];
      for (let index = column; index <= size; index += 1) values[row][index] -= multiplier * values[column][index];
    }
  }
  return values.map((row) => row[size]);
}

function solve3x3(matrix, vector) {
  const values = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(values[row][column]) > Math.abs(values[pivot][column])) pivot = row;
    }
    if (Math.abs(values[pivot][column]) < 0.0000001) return null;
    [values[column], values[pivot]] = [values[pivot], values[column]];
    const divisor = values[column][column];
    for (let index = column; index < 4; index += 1) values[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const multiplier = values[row][column];
      for (let index = column; index < 4; index += 1) values[row][index] -= multiplier * values[column][index];
    }
  }
  return values.map((row) => row[3]);
}

function isSaneTransform(transform) {
  if (!transform) return false;
  const firstScale = Math.hypot(transform.a, transform.c);
  const secondScale = Math.hypot(transform.b, transform.d);
  const determinant = transform.a * transform.d - transform.b * transform.c;
  const axisSimilarity = Math.abs((transform.a * transform.b + transform.c * transform.d)
    / Math.max(firstScale * secondScale, 0.000001));
  return firstScale >= 0.52 && firstScale <= 1.9
    && secondScale >= 0.52 && secondScale <= 1.9
    && determinant >= 0.28 && determinant <= 3.1
    && axisSimilarity <= 0.72;
}

function refineTransform(matches) {
  if (matches.length < 3) return null;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  let x = 0;
  let y = 0;
  let targetXFromX = 0;
  let targetXFromY = 0;
  let targetX = 0;
  let targetYFromX = 0;
  let targetYFromY = 0;
  let targetY = 0;
  matches.forEach((match) => {
    xx += match.source.x ** 2;
    xy += match.source.x * match.source.y;
    yy += match.source.y ** 2;
    x += match.source.x;
    y += match.source.y;
    targetXFromX += match.source.x * match.target.x;
    targetXFromY += match.source.y * match.target.x;
    targetX += match.target.x;
    targetYFromX += match.source.x * match.target.y;
    targetYFromY += match.source.y * match.target.y;
    targetY += match.target.y;
  });
  const normal = [[xx, xy, x], [xy, yy, y], [x, y, matches.length]];
  const horizontal = solve3x3(normal, [targetXFromX, targetXFromY, targetX]);
  const vertical = solve3x3(normal, [targetYFromX, targetYFromY, targetY]);
  if (!horizontal || !vertical) return null;
  const transform = {
    a: horizontal[0],
    b: horizontal[1],
    tx: horizontal[2],
    c: vertical[0],
    d: vertical[1],
    ty: vertical[2],
  };
  return isSaneTransform(transform) ? transform : null;
}

function refinePerspectiveTransform(matches) {
  if (matches.length < 4) return null;
  const matrix = [];
  const vector = [];
  matches.forEach(({ source, target }) => {
    matrix.push([source.x, source.y, 1, 0, 0, 0, -target.x * source.x, -target.x * source.y]);
    vector.push(target.x);
    matrix.push([0, 0, 0, source.x, source.y, 1, -target.y * source.x, -target.y * source.y]);
    vector.push(target.y);
  });
  const normal = Array.from({ length: 8 }, () => Array(8).fill(0));
  const right = Array(8).fill(0);
  matrix.forEach((row, rowIndex) => {
    for (let first = 0; first < 8; first += 1) {
      right[first] += row[first] * vector[rowIndex];
      for (let second = 0; second < 8; second += 1) normal[first][second] += row[first] * row[second];
    }
  });
  const values = solveLinearSystem(normal, right);
  if (!values) return null;
  const transform = {
    a: values[0], b: values[1], tx: values[2],
    c: values[3], d: values[4], ty: values[5],
    g: values[6], h: values[7],
  };
  if (!isSaneTransform(transform)) return null;
  const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
  return corners.every((corner) => {
    const projected = transformPoint(corner, transform);
    return Number.isFinite(projected.x) && Number.isFinite(projected.y)
      && projected.x > -1.5 && projected.x < 2.5 && projected.y > -1.5 && projected.y < 2.5;
  }) ? transform : null;
}

function inliersForTransform(matches, transform, threshold) {
  return matches.filter((match) => {
    const projected = transformPoint(match.source, transform);
    return Math.hypot(projected.x - match.target.x, projected.y - match.target.y) <= threshold;
  });
}

function createCoverageStickers(tileId, tileFeatures = []) {
  if (tileFeatures.length < 4) return [];

  const minFeatureX = Math.min(...tileFeatures.map((feature) => feature.x));
  const maxFeatureX = Math.max(...tileFeatures.map((feature) => feature.x));
  const minFeatureY = Math.min(...tileFeatures.map((feature) => feature.y));
  const maxFeatureY = Math.max(...tileFeatures.map((feature) => feature.y));
  const centerX = (minFeatureX + maxFeatureX) / 2;
  const centerY = (minFeatureY + maxFeatureY) / 2;
  // Feature points are usually concentrated on edges of a wall. Expand their
  // envelope slightly so the UI can show the surrounding wall area without
  // pretending that an untracked, full-screen plane has been reconstructed.
  const halfWidth = Math.min(0.23, Math.max(0.08, (maxFeatureX - minFeatureX) / 2 + 0.06));
  const halfHeight = Math.min(0.23, Math.max(0.08, (maxFeatureY - minFeatureY) / 2 + 0.06));
  const minX = clamp(centerX - halfWidth, 0.02, 0.9);
  const maxX = clamp(centerX + halfWidth, minX + 0.08, 0.98);
  const minY = clamp(centerY - halfHeight, 0.02, 0.9);
  const maxY = clamp(centerY + halfHeight, minY + 0.08, 0.98);
  // Use enough small cells that a locked wall reads as covered, rather than as
  // a handful of unrelated dots. The grid is still bounded to keep mobile
  // canvas work predictable.
  const columns = Math.max(4, Math.min(6, Math.ceil((maxX - minX) / 0.075)));
  const rows = Math.max(4, Math.min(6, Math.ceil((maxY - minY) / 0.075)));
  const candidates = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      candidates.push({
        x: minX + ((column + 0.5) / columns) * (maxX - minX),
        y: minY + ((row + 0.5) / rows) * (maxY - minY),
      });
    }
  }

  const awayFromFeatures = candidates.filter((candidate) => tileFeatures.every((feature) => (
    Math.hypot(feature.x - candidate.x, feature.y - candidate.y) >= 0.045
  )));
  const points = (awayFromFeatures.length >= candidates.length * 0.55 ? awayFromFeatures : candidates).slice(0, 36);
  return points.map((point, index) => ({
    id: `${tileId}-wall-${index}`,
    anchorId: tileId,
    x: point.x,
    y: point.y,
    radius: 0.032,
    confidence: 0.48,
    trackable: false,
    kind: 'surface-coverage',
  }));
}

function interpolatePatch(patch, u, v) {
  const top = {
    x: patch[0].x + (patch[1].x - patch[0].x) * u,
    y: patch[0].y + (patch[1].y - patch[0].y) * u,
  };
  const bottom = {
    x: patch[3].x + (patch[2].x - patch[3].x) * u,
    y: patch[3].y + (patch[2].y - patch[3].y) * u,
  };
  return {
    x: top.x + (bottom.x - top.x) * v,
    y: top.y + (bottom.y - top.y) * v,
  };
}

function createCoverageCells(tileId, patch, columns = 6, rows = 6) {
  if (!Array.isArray(patch) || patch.length < 4) return [];
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const left = column / columns;
      const right = (column + 1) / columns;
      const top = row / rows;
      const bottom = (row + 1) / rows;
      cells.push({
        id: `${tileId}-cell-${row}-${column}`,
        anchorId: tileId,
        vertices: [
          interpolatePatch(patch, left, top),
          interpolatePatch(patch, right, top),
          interpolatePatch(patch, right, bottom),
          interpolatePatch(patch, left, bottom),
        ],
        confidence: 0.7,
        kind: 'surface-coverage-cell',
      });
    }
  }
  return cells;
}

export function estimateSurfaceTransform(matches = [], options = {}) {
  const threshold = options.inlierThreshold ?? 0.048;
  const minimumInliers = options.minimumInliers ?? 4;
  if (matches.length < minimumInliers) return null;
  let best = null;
  let checked = 0;
  for (let first = 0; first < matches.length - 2 && checked < 160; first += 1) {
    for (let second = first + 1; second < matches.length - 1 && checked < 160; second += 1) {
      for (let third = second + 1; third < matches.length && checked < 160; third += 1) {
        checked += 1;
        const transform = refineTransform([matches[first], matches[second], matches[third]]);
        if (!transform) continue;
        const inliers = inliersForTransform(matches, transform, threshold);
        if (!best || inliers.length > best.inliers.length) best = { transform, inliers };
      }
    }
  }
  if (!best || best.inliers.length < minimumInliers) return null;
  // A wall changes shape under perspective. Prefer a projective transform once
  // enough inliers exist, while retaining affine tracking as a safe fallback.
  const refined = refinePerspectiveTransform(best.inliers) || refineTransform(best.inliers) || best.transform;
  const inliers = inliersForTransform(matches, refined, threshold);
  if (inliers.length < minimumInliers) return null;
  const averageError = inliers.reduce((sum, match) => {
    const projected = transformPoint(match.source, refined);
    return sum + Math.hypot(projected.x - match.target.x, projected.y - match.target.y);
  }, 0) / inliers.length;
  return {
    ...refined,
    inlierCount: inliers.length,
    averageError,
    confidence: clamp((inliers.length / Math.max(8, matches.length)) * (1 - averageError / threshold)),
  };
}

export function createSurfaceAnchor({ id, features = [], viewpoint, timestamp }, options = {}) {
  const maximumFeatures = options.maximumFeatures ?? 56;
  const anchorFeatures = features
    .filter((feature) => feature.descriptor?.length)
    .slice(0, maximumFeatures)
    .map((feature, index) => ({
      ...feature,
      id: `${id}-point-${index}`,
      confidence: clamp(0.58 + Math.min(feature.score || 0, 180) / 600),
    }));
  if (anchorFeatures.length < 6) return null;
  const createTile = (tileId, tileFeatures) => {
    const patch = (() => {
      const padding = 0.035;
      const minFeatureX = Math.min(...tileFeatures.map((feature) => feature.x));
      const maxFeatureX = Math.max(...tileFeatures.map((feature) => feature.x));
      const minFeatureY = Math.min(...tileFeatures.map((feature) => feature.y));
      const maxFeatureY = Math.max(...tileFeatures.map((feature) => feature.y));
      const centerX = (minFeatureX + maxFeatureX) / 2;
      const centerY = (minFeatureY + maxFeatureY) / 2;
      const halfWidth = Math.min(0.17, (maxFeatureX - minFeatureX) / 2 + padding);
      const halfHeight = Math.min(0.17, (maxFeatureY - minFeatureY) / 2 + padding);
      const minX = Math.max(0, centerX - halfWidth);
      const maxX = Math.min(1, centerX + halfWidth);
      const minY = Math.max(0, centerY - halfHeight);
      const maxY = Math.min(1, centerY + halfHeight);
      return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
    })();
    return {
      id: tileId,
      features: tileFeatures,
      patch,
      coverageCells: createCoverageCells(tileId, patch),
      coverageStickers: createCoverageStickers(tileId, tileFeatures),
      stickers: tileFeatures.map((feature, index) => ({
        id: `${tileId}-coverage-${index}`,
        anchorId: tileId,
        x: feature.x,
        y: feature.y,
        radius: 0.04 + clamp((feature.score || 0) / 260) * 0.022,
        confidence: feature.confidence,
      })),
    };
  };
  const tileBuckets = new Map();
  anchorFeatures.forEach((feature) => {
    const tileX = Math.min(1, Math.floor(feature.x * 2));
    const tileY = Math.min(1, Math.floor(feature.y * 2));
    const tileId = `${id}-tile-${tileX}-${tileY}`;
    tileBuckets.set(tileId, [...(tileBuckets.get(tileId) || []), feature]);
  });
  let tiles = [...tileBuckets.entries()]
    .filter(([, tileFeatures]) => tileFeatures.length >= 5)
    .map(([tileId, tileFeatures]) => createTile(tileId, tileFeatures));
  if (!tiles.length) tiles = [createTile(`${id}-tile-all`, anchorFeatures)];
  return {
    id,
    timestamp,
    viewpoint,
    features: anchorFeatures,
    tiles,
    patches: tiles.map((tile) => ({
      id: tile.id,
      anchorId: id,
      vertices: tile.patch,
      confidence: 0.7,
    })),
    coverageCells: tiles.flatMap((tile) => tile.coverageCells || []),
    stickers: tiles.flatMap((tile) => tile.stickers),
    coverageStickers: tiles.flatMap((tile) => tile.coverageStickers || []),
  };
}

export function appendSurfaceAnchor(anchors = [], anchor, maximum = DEFAULT_MAX_ANCHORS) {
  if (!anchor) return anchors;
  return [...anchors, anchor].slice(-maximum);
}

export function localizeSurfaceAnchors(anchors = [], currentFeatures = [], options = {}) {
  const maximumVisibleAnchors = options.maximumVisibleAnchors ?? 7;
  const minimumTransformConfidence = options.minimumTransformConfidence ?? 0;
  const localizations = anchors.flatMap((anchor) => (anchor.tiles || [{
    id: `${anchor.id}-legacy`,
    features: anchor.features,
    stickers: anchor.stickers,
  }]).map((tile) => {
    const matches = matchAnchorFeatures(tile.features, currentFeatures, options);
    const transform = estimateSurfaceTransform(matches, options);
    if (!transform || transform.confidence < minimumTransformConfidence) return null;
    return { anchor, tile, transform, matchCount: matches.length };
  })).filter(Boolean)
    .sort((first, second) => second.transform.confidence - first.transform.confidence
      || second.transform.inlierCount - first.transform.inlierCount)
    .slice(0, maximumVisibleAnchors);

  const stickers = localizations.flatMap(({ tile, transform }) => tile.stickers.map((sticker) => {
    const position = transformPoint(sticker, transform);
    return {
      ...sticker,
      anchorId: tile.id,
      x: position.x,
      y: position.y,
      radius: sticker.radius * Math.sqrt(
        Math.hypot(transform.a, transform.c) * Math.hypot(transform.b, transform.d),
      ),
      confidence: clamp(sticker.confidence * (0.58 + transform.confidence * 0.42)),
    };
  })).filter((sticker) => sticker.x > -0.12 && sticker.x < 1.12
    && sticker.y > -0.12 && sticker.y < 1.12);

  const coverageStickers = localizations.flatMap(({ tile, transform }) => (tile.coverageStickers || []).map((sticker) => {
    const position = transformPoint(sticker, transform);
    return {
      ...sticker,
      anchorId: tile.id,
      x: position.x,
      y: position.y,
      radius: sticker.radius * Math.sqrt(
        Math.hypot(transform.a, transform.c) * Math.hypot(transform.b, transform.d),
      ),
      confidence: clamp(sticker.confidence * (0.58 + transform.confidence * 0.42)),
    };
  })).filter((sticker) => sticker.x > -0.12 && sticker.x < 1.12
    && sticker.y > -0.12 && sticker.y < 1.12);

  const coverageCells = localizations.flatMap(({ tile, transform }) => (tile.coverageCells || []).map((cell) => ({
    ...cell,
    anchorId: tile.id,
    vertices: cell.vertices.map((point) => transformPoint(point, transform)),
    confidence: clamp(cell.confidence * (0.58 + transform.confidence * 0.42)),
  }))).filter((cell) => cell.vertices.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));

  const patches = localizations.map(({ anchor, tile, transform }) => ({
    id: tile.id,
    anchorId: anchor.id,
    vertices: (tile.patch || derivePatch(anchor.features)).map((point) => transformPoint(point, transform)),
    confidence: transform.confidence,
  })).filter((patch) => patch.vertices.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));

  return { stickers, coverageStickers, coverageCells, patches, localizations };
}

function derivePatch(features = []) {
  if (!features.length) return [];
  const padding = 0.035;
  const minFeatureX = Math.min(...features.map((feature) => feature.x));
  const maxFeatureX = Math.max(...features.map((feature) => feature.x));
  const minFeatureY = Math.min(...features.map((feature) => feature.y));
  const maxFeatureY = Math.max(...features.map((feature) => feature.y));
  const centerX = (minFeatureX + maxFeatureX) / 2;
  const centerY = (minFeatureY + maxFeatureY) / 2;
  const halfWidth = Math.min(0.17, (maxFeatureX - minFeatureX) / 2 + padding);
  const halfHeight = Math.min(0.17, (maxFeatureY - minFeatureY) / 2 + padding);
  const minX = Math.max(0, centerX - halfWidth);
  const maxX = Math.min(1, centerX + halfWidth);
  const minY = Math.max(0, centerY - halfHeight);
  const maxY = Math.min(1, centerY + halfHeight);
  return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
}
