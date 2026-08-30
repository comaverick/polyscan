export const DEFAULT_VIEWPOINT_THRESHOLDS = Object.freeze({
  translationMeters: 0.18,
  angleDegrees: 12,
  parallax: 0.075,
  minStableMatches: 4,
});

export const MIN_VIABLE_SCAN = Object.freeze({
  keyframes: 8,
  distinctViewpoints: 3,
  featureTracks: 18,
});

const PITCH_BANDS = [
  { name: 'upper', center: 24 },
  { name: 'middle', center: 0 },
  { name: 'lower', center: -24 },
];

export function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeAngle(degrees) {
  return ((degrees % 360) + 360) % 360;
}

export function angularDifference(first, second) {
  const difference = Math.abs(normalizeAngle(first) - normalizeAngle(second));
  return Math.min(difference, 360 - difference);
}

export function createDirectionalCoverage(yawBins = 20) {
  return PITCH_BANDS.flatMap((band, pitchBand) => Array.from({ length: yawBins }, (_, yawIndex) => ({
    id: `${pitchBand}-${yawIndex}`,
    yawIndex,
    yawBins,
    pitchBand,
    pitch: band.center,
    coverage: 0,
    observationCount: 0,
    distinctViewCount: 0,
    featureConfidence: 0,
    parallax: 0,
    status: 'unknown',
  })));
}

export function getVisibleCellIds({ yaw = 0, pitch = 0, yawBins = 20, horizontalFov = 78, verticalFov = 58 } = {}) {
  const yawSize = 360 / yawBins;
  return createDirectionalCoverage(yawBins)
    .filter((cell) => {
      const cellYaw = cell.yawIndex * yawSize + yawSize / 2;
      return angularDifference(cellYaw, yaw) <= horizontalFov / 2 + yawSize / 2
        && Math.abs(cell.pitch - pitch) <= verticalFov / 2 + 18;
    })
    .map((cell) => cell.id);
}

export function classifyCoverage(coverage) {
  if (coverage <= 0.001) return 'unknown';
  if (coverage < 0.34) return 'low';
  if (coverage < 0.66) return 'partial';
  if (coverage < 0.9) return 'good';
  return 'sufficient';
}

export function coverageOpacity(coverage) {
  if (coverage >= 0.9) return 0;
  if (coverage >= 0.66) return 0.08;
  if (coverage >= 0.34) return 0.24;
  if (coverage > 0) return 0.45;
  return 0.6;
}

export function isDistinctViewpoint(previousViewpoint, nextViewpoint, thresholds = DEFAULT_VIEWPOINT_THRESHOLDS) {
  if (!nextViewpoint || (nextViewpoint.stableMatches || 0) < thresholds.minStableMatches) return false;
  if (!previousViewpoint) return true;

  const hasTranslation = Number.isFinite(nextViewpoint.translationMeters)
    && nextViewpoint.translationMeters >= thresholds.translationMeters;
  const hasAngularNovelty = angularDifference(previousViewpoint.yaw || 0, nextViewpoint.yaw || 0) >= thresholds.angleDegrees;
  const hasParallax = Number.isFinite(nextViewpoint.parallax)
    && nextViewpoint.parallax >= thresholds.parallax;
  return hasTranslation || hasAngularNovelty || hasParallax;
}

export function updateDirectionalCoverage(cells, evidence) {
  const visibleIds = new Set(evidence.visibleCellIds || []);
  const usefulViewpoint = Boolean(evidence.usefulViewpoint);
  const featureConfidence = clamp(evidence.featureConfidence || 0);
  const parallax = clamp(evidence.parallax || 0);
  const contribution = clamp(0.12 + featureConfidence * 0.25 + parallax * 0.85, 0.12, 0.4);

  return cells.map((cell) => {
    if (!visibleIds.has(cell.id)) return cell;
    const nextCoverage = usefulViewpoint ? clamp(cell.coverage + contribution) : cell.coverage;
    return {
      ...cell,
      observationCount: cell.observationCount + 1,
      distinctViewCount: cell.distinctViewCount + (usefulViewpoint ? 1 : 0),
      coverage: nextCoverage,
      featureConfidence: Math.max(cell.featureConfidence, featureConfidence),
      parallax: Math.max(cell.parallax, parallax),
      status: classifyCoverage(nextCoverage),
    };
  });
}

export function isReconstructionViable({
  keyframes = 0,
  distinctViewpoints = 0,
  featureTracks = 0,
  meaningfulCameraMotion = false,
} = {}) {
  return keyframes >= MIN_VIABLE_SCAN.keyframes
    && distinctViewpoints >= MIN_VIABLE_SCAN.distinctViewpoints
    && featureTracks >= MIN_VIABLE_SCAN.featureTracks
    && meaningfulCameraMotion;
}

export function hasCompleteRoomCoverage(cells = [], options = {}) {
  const wallThreshold = options.wallThreshold ?? 0.16;
  const shellThreshold = options.shellThreshold ?? 0.11;
  const average = (items) => items.length
    ? items.reduce((sum, item) => sum + (item.coverage || 0), 0) / items.length
    : 0;
  const walls = [0, 1, 2, 3].map((wallIndex) => average(
    cells.filter((cell) => Math.floor(cell.yawIndex / 5) === wallIndex),
  ));
  const upper = average(cells.filter((cell) => cell.pitchBand === 0));
  const lower = average(cells.filter((cell) => cell.pitchBand === 2));
  return walls.every((coverage) => coverage >= wallThreshold)
    && upper >= shellThreshold
    && lower >= shellThreshold;
}

function distance3d(first, second) {
  return Math.hypot(
    (first.x || 0) - (second.x || 0),
    (first.y || 0) - (second.y || 0),
    (first.z || 0) - (second.z || 0),
  );
}

function normalizeVector(vector) {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (!length) return null;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

export function triangulateFeatureTrack(track, firstPose, secondPose, options = {}) {
  const minimumBaseline = options.minimumBaseline ?? 0.18;
  const maximumReprojectionError = options.maximumReprojectionError ?? 0.035;
  if (!track || !firstPose || !secondPose || (track.observations || []).length < 2) return null;
  if (distance3d(firstPose.position, secondPose.position) < minimumBaseline) return null;
  if ((track.reprojectionError ?? 0) > maximumReprojectionError) return null;

  const firstRay = normalizeVector(firstPose.ray);
  const secondRay = normalizeVector(secondPose.ray);
  if (!firstRay || !secondRay) return null;
  const cross = {
    x: firstRay.y * secondRay.z - firstRay.z * secondRay.y,
    y: firstRay.z * secondRay.x - firstRay.x * secondRay.z,
    z: firstRay.x * secondRay.y - firstRay.y * secondRay.x,
  };
  const raySeparation = Math.hypot(cross.x, cross.y, cross.z);
  if (raySeparation < 0.06) return null;

  const baseline = {
    x: secondPose.position.x - firstPose.position.x,
    y: secondPose.position.y - firstPose.position.y,
    z: secondPose.position.z - firstPose.position.z,
  };
  const denominator = 1 - (firstRay.x * secondRay.x + firstRay.y * secondRay.y + firstRay.z * secondRay.z) ** 2;
  if (Math.abs(denominator) < 0.01) return null;
  const firstBaselineDot = baseline.x * firstRay.x + baseline.y * firstRay.y + baseline.z * firstRay.z;
  const secondBaselineDot = baseline.x * secondRay.x + baseline.y * secondRay.y + baseline.z * secondRay.z;
  const rayDot = firstRay.x * secondRay.x + firstRay.y * secondRay.y + firstRay.z * secondRay.z;
  const firstDepth = (firstBaselineDot - rayDot * secondBaselineDot) / denominator;
  const secondDepth = (rayDot * firstBaselineDot - secondBaselineDot) / denominator;
  if (firstDepth <= 0 || secondDepth <= 0) return null;
  const firstPoint = {
    x: firstPose.position.x + firstRay.x * firstDepth,
    y: firstPose.position.y + firstRay.y * firstDepth,
    z: firstPose.position.z + firstRay.z * firstDepth,
  };
  const secondPoint = {
    x: secondPose.position.x + secondRay.x * secondDepth,
    y: secondPose.position.y + secondRay.y * secondDepth,
    z: secondPose.position.z + secondRay.z * secondDepth,
  };
  const position = {
    x: (firstPoint.x + secondPoint.x) / 2,
    y: (firstPoint.y + secondPoint.y) / 2,
    z: (firstPoint.z + secondPoint.z) / 2,
  };
  if (![position.x, position.y, position.z].every(Number.isFinite)) return null;

  return {
    id: track.id,
    position,
    confidence: clamp((track.confidence ?? 0) * Math.min(1, raySeparation * 2)),
    sourceKeyframes: [firstPose.keyframeId, secondPose.keyframeId],
    screen: track.screen,
  };
}

export function createSurfacePatch(points, options = {}) {
  const confidenceThreshold = options.confidenceThreshold ?? 0.64;
  const planeErrorThreshold = options.planeErrorThreshold ?? 0.06;
  if (!Array.isArray(points) || points.length < 3) return null;
  if (points.some((point) => (point.confidence ?? 0) < confidenceThreshold)) return null;
  if ((options.planeError ?? Infinity) > planeErrorThreshold) return null;
  return {
    vertices: points.map((point) => point.position),
    confidence: points.reduce((sum, point) => sum + point.confidence, 0) / points.length,
    sourceKeyframes: [...new Set(points.flatMap((point) => point.sourceKeyframes || []))],
    colorSamples: points.map((point) => point.color).filter(Boolean),
    textureSource: options.textureSource || null,
  };
}

export function selectBestKeyframes(keyframes, limit = 24) {
  const ranked = [...(keyframes || [])].sort((first, second) => {
    const firstScore = (first.sharpness || 0) + (first.stableTrackCount || 0) * 2 + (first.viewpoint?.parallax || 0) * 100;
    const secondScore = (second.sharpness || 0) + (second.stableTrackCount || 0) * 2 + (second.viewpoint?.parallax || 0) * 100;
    return secondScore - firstScore;
  });
  const selected = [];
  ranked.forEach((keyframe) => {
    if (selected.length >= limit) return;
    const duplicate = selected.some((existing) => angularDifference(
      existing.viewpoint?.yaw || 0,
      keyframe.viewpoint?.yaw || 0,
    ) < 8
      && Math.abs((existing.viewpoint?.parallax || 0) - (keyframe.viewpoint?.parallax || 0)) < 0.02
      && Math.abs((existing.timestamp || 0) - (keyframe.timestamp || 0)) < 1200);
    if (!duplicate) selected.push(keyframe);
  });
  return selected.sort((first, second) => first.timestamp - second.timestamp);
}
