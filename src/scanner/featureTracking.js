import {
  clamp,
  getVisibleCellIds,
  isDistinctViewpoint,
} from './coverageModel';

function luminance(red, green, blue) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function descriptorAt(data, width, height, x, y) {
  const descriptor = [];
  for (let offsetY = -2; offsetY <= 2; offsetY += 2) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 2) {
      const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
      const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
      const index = (sampleY * width + sampleX) * 4;
      descriptor.push(luminance(data[index], data[index + 1], data[index + 2]));
    }
  }
  const average = descriptor.reduce((sum, value) => sum + value, 0) / descriptor.length;
  const variance = Math.sqrt(descriptor.reduce((sum, value) => sum + (value - average) ** 2, 0) / descriptor.length) || 1;
  return descriptor.map((value) => (value - average) / variance);
}

function featureScore(data, width, height, x, y) {
  const center = luminance(...data.slice((y * width + x) * 4, (y * width + x) * 4 + 3));
  const rightX = Math.min(width - 1, x + 3);
  const leftX = Math.max(0, x - 3);
  const downY = Math.min(height - 1, y + 3);
  const upY = Math.max(0, y - 3);
  const right = luminance(...data.slice((y * width + rightX) * 4, (y * width + rightX) * 4 + 3));
  const left = luminance(...data.slice((y * width + leftX) * 4, (y * width + leftX) * 4 + 3));
  const down = luminance(...data.slice((downY * width + x) * 4, (downY * width + x) * 4 + 3));
  const up = luminance(...data.slice((upY * width + x) * 4, (upY * width + x) * 4 + 3));
  return Math.abs(right - left) + Math.abs(down - up) + Math.abs(center - (right + left + down + up) / 4);
}

function colorAt(data, width, x, y) {
  const index = (y * width + x) * 4;
  return { r: data[index], g: data[index + 1], b: data[index + 2] };
}

export function extractFrameFeatures(context, width, height, maximum = 64) {
  const image = context.getImageData(0, 0, width, height);
  const candidates = [];
  const data = image.data;
  for (let y = 12; y < height - 12; y += 12) {
    for (let x = 12; x < width - 12; x += 12) {
      const score = featureScore(data, width, height, x, y);
      if (score >= 14) candidates.push({ x, y, score });
    }
  }
  candidates.sort((first, second) => second.score - first.score);
  const selected = [];
  candidates.forEach((candidate) => {
    if (selected.length >= maximum) return;
    const tooClose = selected.some((feature) => Math.hypot(feature.x - candidate.x, feature.y - candidate.y) < 18);
    if (tooClose) return;
    selected.push({
      id: `feature-${selected.length}`,
      x: candidate.x / width,
      y: candidate.y / height,
      score: candidate.score,
      descriptor: descriptorAt(data, width, height, candidate.x, candidate.y),
      color: colorAt(data, width, candidate.x, candidate.y),
      velocity: { x: 0, y: 0 },
    });
  });
  return selected;
}

function descriptorDistance(first, second) {
  if (!first || !second || first.length !== second.length) return Infinity;
  const sum = first.reduce((total, value, index) => total + (value - second[index]) ** 2, 0);
  return Math.sqrt(sum / first.length);
}

export function matchFrameFeatures(previousFeatures = [], currentFeatures = [], options = {}) {
  const maxDistance = options.maxDistance ?? 0.18;
  const maxDescriptorDistance = options.maxDescriptorDistance ?? 0.62;
  const used = new Set();
  const matches = [];
  previousFeatures.forEach((previous) => {
    let best = null;
    let secondBest = null;
    currentFeatures.forEach((current, index) => {
      if (used.has(index)) return;
      const predictedX = previous.x + (previous.velocity?.x || 0);
      const predictedY = previous.y + (previous.velocity?.y || 0);
      const screenDistance = Math.hypot(current.x - predictedX, current.y - predictedY);
      if (screenDistance > maxDistance) return;
      const descriptor = descriptorDistance(previous.descriptor, current.descriptor);
      const rank = descriptor + screenDistance * 1.2;
      if (!best || rank < best.rank) {
        secondBest = best;
        best = { current, index, rank, screenDistance, descriptor };
      } else if (!secondBest || rank < secondBest.rank) {
        secondBest = { current, index, rank, screenDistance, descriptor };
      }
    });
    if (!best || best.descriptor > maxDescriptorDistance) return;
    if (secondBest && best.rank > secondBest.rank * 0.92) return;
    used.add(best.index);
    matches.push({
      trackId: previous.trackId || previous.id,
      previous,
      current: best.current,
      confidence: clamp(1 - best.descriptor / maxDescriptorDistance) * clamp(1 - best.screenDistance / maxDistance),
      displacement: best.screenDistance,
    });
  });
  return matches;
}

export function updateFeatureTracks(previousTracks = [], matches = [], timestamp = 0) {
  const tracksById = new Map(previousTracks.map((track) => [track.id, track]));
  matches.forEach((match) => {
    const existing = tracksById.get(match.trackId) || {
      id: match.trackId,
      observations: [],
      confidence: 0,
    };
    const observation = {
      x: match.current.x,
      y: match.current.y,
      timestamp,
      color: match.current.color,
    };
    const observations = [...existing.observations, observation].slice(-12);
    tracksById.set(match.trackId, {
      ...existing,
      observations,
      confidence: clamp(Math.max(existing.confidence, match.confidence) + 0.06),
      screen: { x: match.current.x, y: match.current.y },
    });
  });
  return [...tracksById.values()];
}

export function buildFrameEvidence({ previousFrame, currentFrame, orientation = {}, referenceViewpoint, thresholds }) {
  const previousFeatures = previousFrame?.features || [];
  const currentFeatures = currentFrame.features || [];
  const matches = matchFrameFeatures(previousFeatures, currentFeatures);
  const stableTrackCount = matches.filter((match) => match.confidence >= 0.24).length;
  const featureConfidence = clamp(stableTrackCount / Math.max(12, Math.min(previousFeatures.length || currentFeatures.length || 1, 32)));
  const parallax = matches.length
    ? matches.reduce((sum, match) => sum + match.displacement, 0) / matches.length
    : 0;
  const yaw = Number.isFinite(orientation.yaw) ? orientation.yaw : 0;
  const pitch = Number.isFinite(orientation.pitch) ? orientation.pitch : 0;
  const viewpoint = {
    yaw,
    pitch,
    parallax,
    translationMeters: orientation.translationMeters,
    stableMatches: stableTrackCount,
  };
  const tracking = currentFeatures.length >= 6 && (previousFrame == null || stableTrackCount >= 4);
  const usefulViewpoint = tracking && isDistinctViewpoint(referenceViewpoint || previousFrame?.viewpoint, viewpoint, thresholds);
  const stableFeatures = matches
    .filter((match) => match.confidence >= 0.24)
    .map((match) => ({
      id: match.trackId,
      x: match.current.x,
      y: match.current.y,
      confidence: match.confidence,
      color: match.current.color,
    }));
  return {
    matches,
    stableFeatures,
    stableTrackCount,
    featureConfidence,
    parallax,
    tracking,
    usefulViewpoint,
    viewpoint,
    visibleCellIds: getVisibleCellIds({ yaw, pitch }),
  };
}

function triangleArea(first, second, third) {
  return Math.abs(
    (first.x * (second.y - third.y)
      + second.x * (third.y - first.y)
      + third.x * (first.y - second.y)) / 2,
  );
}

/**
 * Builds a lightweight screen-space mesh from stable tracked features.
 *
 * This is deliberately a capture-feedback mesh, not reconstructed geometry.
 * Its job is to make locally verified image regions feel spatial while the
 * reconstruction service remains the source of real 3D output.
 */
export function buildScreenMesh(features = [], options = {}) {
  const minimumConfidence = options.minimumConfidence ?? 0.18;
  const maximumEdge = options.maximumEdge ?? 0.22;
  const minimumArea = options.minimumArea ?? 0.00035;
  const maximumArea = options.maximumArea ?? 0.018;
  const maximumTriangles = options.maximumTriangles ?? 96;
  const neighborCount = options.neighborCount ?? 5;
  const points = features
    .filter((feature) => Number.isFinite(feature.x)
      && Number.isFinite(feature.y)
      && feature.x >= 0 && feature.x <= 1
      && feature.y >= 0 && feature.y <= 1
      && (feature.confidence ?? 0) >= minimumConfidence)
    .map((feature, index) => ({ ...feature, meshId: feature.id || `mesh-point-${index}` }));
  const used = new Set();
  const triangles = [];

  points.forEach((anchor) => {
    const neighbors = points
      .filter((point) => point !== anchor)
      .map((point) => ({ point, distance: Math.hypot(point.x - anchor.x, point.y - anchor.y) }))
      .filter(({ distance }) => distance <= maximumEdge)
      .sort((first, second) => first.distance - second.distance)
      .slice(0, neighborCount);

    let trianglesForAnchor = 0;
    for (let firstIndex = 0; firstIndex < neighbors.length - 1; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < neighbors.length; secondIndex += 1) {
        const first = neighbors[firstIndex].point;
        const second = neighbors[secondIndex].point;
        const key = [anchor.meshId, first.meshId, second.meshId].sort().join('|');
        if (used.has(key)) continue;

        const area = triangleArea(anchor, first, second);
        const longestEdge = Math.max(
          Math.hypot(anchor.x - first.x, anchor.y - first.y),
          Math.hypot(anchor.x - second.x, anchor.y - second.y),
          Math.hypot(first.x - second.x, first.y - second.y),
        );
        const shapeQuality = area / Math.max(longestEdge * longestEdge, 0.000001);
        if (area < minimumArea || area > maximumArea || shapeQuality < 0.045) continue;

        used.add(key);
        const screenVertices = [anchor, first, second].map(({ x, y }) => ({ x, y }));
        triangles.push({
          id: `mesh-${key}`,
          confidence: clamp(((anchor.confidence || 0) + (first.confidence || 0) + (second.confidence || 0)) / 3),
          screenVertices,
          centroid: {
            x: screenVertices.reduce((sum, vertex) => sum + vertex.x, 0) / 3,
            y: screenVertices.reduce((sum, vertex) => sum + vertex.y, 0) / 3,
          },
        });
        trianglesForAnchor += 1;
        if (trianglesForAnchor >= 3 || triangles.length >= maximumTriangles) break;
      }
      if (trianglesForAnchor >= 3 || triangles.length >= maximumTriangles) break;
    }
  });

  return triangles
    .sort((first, second) => second.confidence - first.confidence)
    .slice(0, maximumTriangles);
}
