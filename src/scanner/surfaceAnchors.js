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
  return {
    ...point,
    x: transform.a * point.x + transform.b * point.y + transform.tx,
    y: transform.c * point.x + transform.d * point.y + transform.ty,
  };
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

function inliersForTransform(matches, transform, threshold) {
  return matches.filter((match) => {
    const projected = transformPoint(match.source, transform);
    return Math.hypot(projected.x - match.target.x, projected.y - match.target.y) <= threshold;
  });
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
  const refined = refineTransform(best.inliers) || best.transform;
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
  const createTile = (tileId, tileFeatures) => ({
    id: tileId,
    features: tileFeatures,
    stickers: tileFeatures.map((feature, index) => ({
      id: `${tileId}-coverage-${index}`,
      anchorId: tileId,
      x: feature.x,
      y: feature.y,
      radius: 0.04 + clamp((feature.score || 0) / 260) * 0.022,
      confidence: feature.confidence,
    })),
  });
  const tileBuckets = new Map();
  anchorFeatures.forEach((feature) => {
    const tileX = Math.min(1, Math.floor(feature.x * 2));
    const tileY = Math.min(1, Math.floor(feature.y * 2));
    const tileId = `${id}-tile-${tileX}-${tileY}`;
    tileBuckets.set(tileId, [...(tileBuckets.get(tileId) || []), feature]);
  });
  let tiles = [...tileBuckets.entries()]
    .filter(([, tileFeatures]) => tileFeatures.length >= 4)
    .map(([tileId, tileFeatures]) => createTile(tileId, tileFeatures));
  if (!tiles.length) tiles = [createTile(`${id}-tile-all`, anchorFeatures)];
  return {
    id,
    timestamp,
    viewpoint,
    features: anchorFeatures,
    tiles,
    stickers: tiles.flatMap((tile) => tile.stickers),
  };
}

export function appendSurfaceAnchor(anchors = [], anchor, maximum = DEFAULT_MAX_ANCHORS) {
  if (!anchor) return anchors;
  return [...anchors, anchor].slice(-maximum);
}

export function localizeSurfaceAnchors(anchors = [], currentFeatures = [], options = {}) {
  const maximumVisibleAnchors = options.maximumVisibleAnchors ?? 7;
  const localizations = anchors.flatMap((anchor) => (anchor.tiles || [{
    id: `${anchor.id}-legacy`,
    features: anchor.features,
    stickers: anchor.stickers,
  }]).map((tile) => {
    const matches = matchAnchorFeatures(tile.features, currentFeatures, options);
    const transform = estimateSurfaceTransform(matches, options);
    if (!transform) return null;
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

  return { stickers, localizations };
}
