import { clamp } from './coverageModel';

export function grayscaleFromImageData(imageData) {
  const pixels = imageData?.data || [];
  const grayscale = new Uint8Array(Math.floor(pixels.length / 4));
  for (let source = 0, target = 0; source < pixels.length; source += 4, target += 1) {
    grayscale[target] = Math.round(
      pixels[source] * 0.2126
      + pixels[source + 1] * 0.7152
      + pixels[source + 2] * 0.0722,
    );
  }
  return grayscale;
}

function patchCorrelation(previous, current, width, height, sourceX, sourceY, targetX, targetY, radius) {
  if (sourceX - radius < 0 || sourceX + radius >= width
    || sourceY - radius < 0 || sourceY + radius >= height
    || targetX - radius < 0 || targetX + radius >= width
    || targetY - radius < 0 || targetY + radius >= height) return -1;

  const sampleCount = (radius * 2 + 1) ** 2;
  let sourceMean = 0;
  let targetMean = 0;
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      sourceMean += previous[(sourceY + offsetY) * width + sourceX + offsetX];
      targetMean += current[(targetY + offsetY) * width + targetX + offsetX];
    }
  }
  sourceMean /= sampleCount;
  targetMean /= sampleCount;

  let numerator = 0;
  let sourceEnergy = 0;
  let targetEnergy = 0;
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      const sourceValue = previous[(sourceY + offsetY) * width + sourceX + offsetX] - sourceMean;
      const targetValue = current[(targetY + offsetY) * width + targetX + offsetX] - targetMean;
      numerator += sourceValue * targetValue;
      sourceEnergy += sourceValue ** 2;
      targetEnergy += targetValue ** 2;
    }
  }
  if (sourceEnergy < 180 || targetEnergy < 180) return -1;
  return numerator / Math.sqrt(sourceEnergy * targetEnergy);
}

function bestPatchMatch(previous, current, width, height, x, y, options = {}) {
  const searchRadius = options.searchRadius ?? 6;
  const patchRadius = options.patchRadius ?? 2;
  let best = null;
  let secondScore = -1;
  for (let offsetY = -searchRadius; offsetY <= searchRadius; offsetY += 1) {
    for (let offsetX = -searchRadius; offsetX <= searchRadius; offsetX += 1) {
      const targetX = x + offsetX;
      const targetY = y + offsetY;
      const score = patchCorrelation(previous, current, width, height, x, y, targetX, targetY, patchRadius);
      if (!best || score > best.score) {
        secondScore = best?.score ?? -1;
        best = { x: targetX, y: targetY, score };
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
  }
  if (!best) return null;
  return { ...best, separation: best.score - secondScore };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function trackStickerGroup(previous, current, width, height, stickers, options) {
  const minimumCorrelation = options.minimumCorrelation ?? 0.7;
  const maximumFlowResidual = options.maximumFlowResidual ?? 3.8;
  const controlStickers = [...stickers]
    .sort((first, second) => (second.confidence || 0) - (first.confidence || 0))
    .slice(0, options.maximumControlPoints ?? 18);
  const candidates = controlStickers.map((sticker) => {
    const sourceX = Math.round(sticker.x * width);
    const sourceY = Math.round(sticker.y * height);
    const forward = bestPatchMatch(previous, current, width, height, sourceX, sourceY, options);
    if (!forward || forward.score < minimumCorrelation) return null;
    const backward = bestPatchMatch(current, previous, width, height, forward.x, forward.y, {
      ...options,
      searchRadius: Math.min(options.searchRadius ?? 7, 5),
    });
    if (!backward || Math.hypot(backward.x - sourceX, backward.y - sourceY) > 2.2) return null;
    return {
      sticker,
      x: forward.x,
      y: forward.y,
      dx: forward.x - sourceX,
      dy: forward.y - sourceY,
      score: forward.score,
    };
  }).filter(Boolean);

  if (candidates.length < Math.min(3, controlStickers.length)) return { stickers: [], trackedCount: 0, confidence: 0 };
  const medianX = median(candidates.map((candidate) => candidate.dx));
  const medianY = median(candidates.map((candidate) => candidate.dy));
  const coherent = candidates.filter((candidate) => (
    Math.hypot(candidate.dx - medianX, candidate.dy - medianY) <= maximumFlowResidual
  ));
  if (coherent.length < Math.min(3, controlStickers.length)) return { stickers: [], trackedCount: 0, confidence: 0 };

  const trackedById = new Map(coherent.map((candidate) => [candidate.sticker.id, candidate]));
  const nextStickers = stickers.map((sticker) => {
    const tracked = trackedById.get(sticker.id);
    if (tracked) {
      return {
        ...sticker,
        x: tracked.x / width,
        y: tracked.y / height,
        confidence: clamp((sticker.confidence || 0.7) * 0.72 + tracked.score * 0.28),
        misses: 0,
      };
    }
    const misses = (sticker.misses || 0) + 1;
    return {
      ...sticker,
      x: sticker.x + medianX / width,
      y: sticker.y + medianY / height,
      confidence: (sticker.confidence || 0.7) * 0.82,
      misses,
    };
  }).filter((sticker) => sticker.misses <= 2
    && sticker.confidence >= 0.28
    && sticker.x > -0.08 && sticker.x < 1.08
    && sticker.y > -0.08 && sticker.y < 1.08);

  return {
    stickers: nextStickers,
    trackedCount: coherent.length,
    confidence: coherent.reduce((sum, candidate) => sum + candidate.score, 0) / coherent.length,
  };
}

export function trackSurfaceStickerGroups(previous, current, width, height, stickers = [], options = {}) {
  if (!previous?.length || previous.length !== current?.length || !stickers.length) {
    return { stickers: [], trackedCount: 0, confidence: 0 };
  }
  const groups = new Map();
  stickers.forEach((sticker) => {
    const key = sticker.anchorId || 'active-surface';
    groups.set(key, [...(groups.get(key) || []), sticker]);
  });
  const results = [...groups.values()].map((group) => (
    trackStickerGroup(previous, current, width, height, group, options)
  ));
  const trackedCount = results.reduce((sum, result) => sum + result.trackedCount, 0);
  return {
    stickers: results.flatMap((result) => result.stickers),
    trackedCount,
    confidence: results.length
      ? results.reduce((sum, result) => sum + result.confidence, 0) / results.length
      : 0,
  };
}
