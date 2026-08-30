import {
  clamp,
  getVisibleCellIds,
  isDistinctViewpoint,
} from './coverageModel';

function luminance(red, green, blue) {
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function luminanceAt(data, width, x, y) {
  const index = (y * width + x) * 4;
  return luminance(data[index], data[index + 1], data[index + 2]);
}

function descriptorAt(data, width, height, x, y) {
  const descriptor = [];
  // A wider normalized patch survives small camera movements and exposure
  // changes better than the old 3x3 descriptor. It is still intentionally
  // compact enough to compare on a phone several times per second.
  for (let offsetY = -8; offsetY <= 8; offsetY += 4) {
    for (let offsetX = -8; offsetX <= 8; offsetX += 4) {
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
  const rightX = Math.min(width - 1, x + 3);
  const leftX = Math.max(0, x - 3);
  const downY = Math.min(height - 1, y + 3);
  const upY = Math.max(0, y - 3);
  const center = luminanceAt(data, width, x, y);
  const right = luminanceAt(data, width, rightX, y);
  const left = luminanceAt(data, width, leftX, y);
  const down = luminanceAt(data, width, x, downY);
  const up = luminanceAt(data, width, x, upY);
  return Math.abs(right - left) + Math.abs(down - up) + Math.abs(center - (right + left + down + up) / 4);
}

function colorAt(data, width, x, y) {
  const index = (y * width + x) * 4;
  return { r: data[index], g: data[index + 1], b: data[index + 2] };
}

export function extractFrameFeatures(context, width, height, maximum = 80) {
  const image = context.getImageData(0, 0, width, height);
  const candidates = [];
  const data = image.data;
  for (let y = 12; y < height - 12; y += 4) {
    for (let x = 12; x < width - 12; x += 4) {
      const score = featureScore(data, width, height, x, y);
      if (score >= 16) candidates.push({ x, y, score });
    }
  }
  candidates.sort((first, second) => second.score - first.score);
  const selected = [];
  const regionCounts = new Map();
  const maximumPerRegion = Math.max(5, Math.ceil(maximum / 9));
  for (const candidate of candidates) {
    if (selected.length >= maximum) break;
    const regionX = Math.min(3, Math.floor((candidate.x / width) * 4));
    const regionY = Math.min(2, Math.floor((candidate.y / height) * 3));
    const regionId = `${regionX}-${regionY}`;
    if ((regionCounts.get(regionId) || 0) >= maximumPerRegion) continue;
    const tooClose = selected.some((feature) => Math.hypot(feature.x - candidate.x, feature.y - candidate.y) < 14);
    if (tooClose) continue;
    selected.push({
      id: `feature-${selected.length}`,
      x: candidate.x / width,
      y: candidate.y / height,
      score: candidate.score,
      descriptor: descriptorAt(data, width, height, candidate.x, candidate.y),
      color: colorAt(data, width, candidate.x, candidate.y),
      velocity: { x: 0, y: 0 },
    });
    regionCounts.set(regionId, (regionCounts.get(regionId) || 0) + 1);
  }
  return selected;
}

export function descriptorDistance(first, second) {
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
      dx: best.current.x - previous.x,
      dy: best.current.y - previous.y,
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

export function buildFrameEvidence({ previousFrame, currentFrame, orientation = {}, referenceViewpoint, referenceFeatures = [], thresholds }) {
  const previousFeatures = previousFrame?.features || [];
  const currentFeatures = currentFrame.features || [];
  const matches = matchFrameFeatures(previousFeatures, currentFeatures);
  const stableTrackCount = matches.filter((match) => match.confidence >= 0.24).length;
  const featureConfidence = clamp(stableTrackCount / Math.max(12, Math.min(previousFeatures.length || currentFeatures.length || 1, 32)));
  const median = (values) => {
    if (!values.length) return 0;
    const ordered = [...values].sort((first, second) => first - second);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  };
  const coherentParallax = (candidateMatches, minimumConfidence) => {
    const usable = candidateMatches.filter((match) => match.confidence >= minimumConfidence);
    if (usable.length < 8) return 0;
    const displacement = median(usable.map((match) => match.displacement));
    const medianDx = median(usable.map((match) => match.dx || 0));
    const medianDy = median(usable.map((match) => match.dy || 0));
    const spread = median(usable.map((match) => Math.hypot(
      (match.dx || 0) - medianDx,
      (match.dy || 0) - medianDy,
    )));
    // Real camera motion moves many details in a coherent direction. Random
    // descriptor swaps on repeated textures do not, so they cannot advance
    // the scan or create a new surface anchor.
    const directionalConsistency = Math.hypot(medianDx, medianDy) / Math.max(0.000001, displacement);
    const allowedSpread = Math.max(0.024, displacement * 0.72);
    return directionalConsistency >= 0.68 && spread <= allowedSpread ? displacement : 0;
  };
  const parallax = coherentParallax(matches, 0.2);
  // A slow room sweep can move only a few pixels between two analysis ticks.
  // Compare against the last saved viewpoint as well, otherwise the scan
  // never accumulates enough motion to save the next view.
  const referenceMatches = referenceFeatures.length
    ? matchFrameFeatures(referenceFeatures, currentFeatures, {
      maxDistance: 0.4,
      maxDescriptorDistance: 0.64,
    })
    : [];
  const referenceParallax = coherentParallax(referenceMatches, 0.22);
  const accumulatedParallax = Math.max(parallax, referenceParallax);
  // A large frame-to-frame jump is not useful capture evidence. It usually
  // means the phone was swung too quickly or the frame is blurred. Keeping it
  // out of the keyframe stream prevents the mapper from accepting a bad view.
  const medianRawDisplacement = median(matches.map((match) => match.displacement));
  const largeMotionMatches = matches.filter((match) => match.displacement >= 0.1).length;
  const tooFast = (largeMotionMatches >= 8 && medianRawDisplacement >= 0.16)
    || (referenceParallax >= 0.28 && stableTrackCount < 12);
  const yaw = Number.isFinite(orientation.yaw) ? orientation.yaw : 0;
  const pitch = Number.isFinite(orientation.pitch) ? orientation.pitch : 0;
  const viewpoint = {
    yaw,
    pitch,
    parallax: accumulatedParallax,
    frameParallax: parallax,
    referenceParallax,
    translationMeters: orientation.translationMeters,
    stableMatches: stableTrackCount,
  };
  const tracking = currentFeatures.length >= 6 && (previousFrame == null || stableTrackCount >= 4);
  const usefulViewpoint = tracking && !tooFast
    && isDistinctViewpoint(referenceViewpoint || previousFrame?.viewpoint, viewpoint, thresholds);
  const stableFeatures = matches
    .filter((match) => match.confidence >= 0.24)
    .map((match) => ({
      id: match.trackId,
      x: match.current.x,
      y: match.current.y,
      confidence: match.confidence,
      color: match.current.color,
      descriptor: match.current.descriptor,
      score: match.current.score,
    }));
  return {
    matches,
    stableFeatures,
    stableTrackCount,
    featureConfidence,
    parallax: accumulatedParallax,
    frameParallax: parallax,
    referenceParallax,
    tooFast,
    tracking,
    usefulViewpoint,
    viewpoint,
    visibleCellIds: getVisibleCellIds({ yaw, pitch }),
  };
}
