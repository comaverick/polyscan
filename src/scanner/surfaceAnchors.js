import { buildCaptureMesh } from './captureMesh';
import { clamp } from './coverageModel';
import { descriptorDistance } from './featureTracking';

const DEFAULT_MAX_ANCHORS = 42;

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
    x: transform.a * point.x - transform.b * point.y + transform.tx,
    y: transform.b * point.x + transform.a * point.y + transform.ty,
  };
}

function transformFromPair(first, second) {
  const sourceX = second.source.x - first.source.x;
  const sourceY = second.source.y - first.source.y;
  const targetX = second.target.x - first.target.x;
  const targetY = second.target.y - first.target.y;
  const denominator = sourceX ** 2 + sourceY ** 2;
  if (denominator < 0.0025) return null;
  const a = (targetX * sourceX + targetY * sourceY) / denominator;
  const b = (targetY * sourceX - targetX * sourceY) / denominator;
  const scale = Math.hypot(a, b);
  if (scale < 0.58 || scale > 1.72) return null;
  return {
    a,
    b,
    tx: first.target.x - a * first.source.x + b * first.source.y,
    ty: first.target.y - b * first.source.x - a * first.source.y,
  };
}

function refineTransform(matches) {
  if (matches.length < 2) return null;
  const sourceCenter = matches.reduce((center, match) => ({
    x: center.x + match.source.x / matches.length,
    y: center.y + match.source.y / matches.length,
  }), { x: 0, y: 0 });
  const targetCenter = matches.reduce((center, match) => ({
    x: center.x + match.target.x / matches.length,
    y: center.y + match.target.y / matches.length,
  }), { x: 0, y: 0 });
  let denominator = 0;
  let numeratorA = 0;
  let numeratorB = 0;
  matches.forEach((match) => {
    const sourceX = match.source.x - sourceCenter.x;
    const sourceY = match.source.y - sourceCenter.y;
    const targetX = match.target.x - targetCenter.x;
    const targetY = match.target.y - targetCenter.y;
    denominator += sourceX ** 2 + sourceY ** 2;
    numeratorA += sourceX * targetX + sourceY * targetY;
    numeratorB += sourceX * targetY - sourceY * targetX;
  });
  if (denominator < 0.0025) return null;
  const a = numeratorA / denominator;
  const b = numeratorB / denominator;
  const scale = Math.hypot(a, b);
  if (scale < 0.58 || scale > 1.72) return null;
  return {
    a,
    b,
    tx: targetCenter.x - a * sourceCenter.x + b * sourceCenter.y,
    ty: targetCenter.y - b * sourceCenter.x - a * sourceCenter.y,
  };
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
  for (let first = 0; first < matches.length - 1 && checked < 120; first += 1) {
    for (let second = first + 1; second < matches.length && checked < 120; second += 1) {
      checked += 1;
      const transform = transformFromPair(matches[first], matches[second]);
      if (!transform) continue;
      const inliers = inliersForTransform(matches, transform, threshold);
      if (!best || inliers.length > best.inliers.length) best = { transform, inliers };
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
  const maximumFeatures = options.maximumFeatures ?? 64;
  const anchorFeatures = features
    .filter((feature) => feature.descriptor?.length)
    .slice(0, maximumFeatures)
    .map((feature, index) => ({
      ...feature,
      id: `${id}-point-${index}`,
      confidence: clamp(0.58 + Math.min(feature.score || 0, 180) / 600),
    }));
  if (anchorFeatures.length < 8) return null;
  const patches = buildCaptureMesh(anchorFeatures, {
    maximumEdge: 0.22,
    maximumArea: 0.014,
    maximumTriangles: 72,
    maximumPerAnchor: 4,
  });
  if (!patches.length) return null;
  return { id, timestamp, viewpoint, features: anchorFeatures, patches };
}

export function appendSurfaceAnchor(anchors = [], anchor, maximum = DEFAULT_MAX_ANCHORS) {
  if (!anchor) return anchors;
  return [...anchors, anchor].slice(-maximum);
}

export function localizeSurfaceAnchors(anchors = [], currentFeatures = [], options = {}) {
  const maximumVisibleAnchors = options.maximumVisibleAnchors ?? 2;
  const localizations = anchors.map((anchor) => {
    const matches = matchAnchorFeatures(anchor.features, currentFeatures, options);
    const transform = estimateSurfaceTransform(matches, options);
    if (!transform) return null;
    return { anchor, transform, matchCount: matches.length };
  }).filter(Boolean)
    .sort((first, second) => second.transform.confidence - first.transform.confidence
      || second.transform.inlierCount - first.transform.inlierCount)
    .slice(0, maximumVisibleAnchors);

  const patches = localizations.flatMap(({ anchor, transform }) => anchor.patches.map((patch) => {
    const vertices = patch.vertices.map((vertex) => transformPoint(vertex, transform));
    const centroid = transformPoint(patch.centroid, transform);
    return {
      ...patch,
      id: `${anchor.id}-${patch.id}`,
      anchorId: anchor.id,
      confidence: clamp(patch.confidence * (0.58 + transform.confidence * 0.42)),
      vertices,
      centroid,
    };
  })).filter((patch) => patch.vertices.every((vertex) => (
    vertex.x > -0.16 && vertex.x < 1.16 && vertex.y > -0.16 && vertex.y < 1.16
  )));

  return { patches, localizations };
}
