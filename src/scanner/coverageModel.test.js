import {
  MIN_VIABLE_SCAN,
  classifyCoverage,
  createDirectionalCoverage,
  createSurfacePatch,
  isDistinctViewpoint,
  isReconstructionViable,
  selectBestKeyframes,
  triangulateFeatureTrack,
  updateDirectionalCoverage,
} from './coverageModel';

const visibleCells = ['1-8', '1-9', '1-10', '0-9'];

test('starts every directional cell unknown and blue', () => {
  const cells = createDirectionalCoverage(20);
  expect(cells).toHaveLength(60);
  expect(cells.every((cell) => cell.coverage === 0 && cell.status === 'unknown')).toBe(true);
});

test('repeated same-pose observations do not clear blue coverage', () => {
  const cells = createDirectionalCoverage(20);
  const observed = updateDirectionalCoverage(cells, {
    visibleCellIds: visibleCells,
    usefulViewpoint: false,
    featureConfidence: 0.9,
    parallax: 0.002,
  });
  expect(observed.find((cell) => cell.id === '1-9').observationCount).toBe(1);
  expect(observed.find((cell) => cell.id === '1-9').distinctViewCount).toBe(0);
  expect(observed.find((cell) => cell.id === '1-9').coverage).toBe(0);
  const repeated = updateDirectionalCoverage(observed, {
    visibleCellIds: visibleCells,
    usefulViewpoint: false,
    featureConfidence: 0.95,
    parallax: 0.003,
  });
  expect(repeated.find((cell) => cell.id === '1-9').observationCount).toBe(2);
  expect(repeated.find((cell) => cell.id === '1-9').coverage).toBe(0);
});

test('distinct viewpoints reduce blue coverage only for visible cells', () => {
  const cells = createDirectionalCoverage(20);
  const updated = updateDirectionalCoverage(cells, {
    visibleCellIds: visibleCells,
    usefulViewpoint: true,
    featureConfidence: 0.85,
    parallax: 0.12,
  });
  expect(updated.find((cell) => cell.id === '1-9').coverage).toBeGreaterThan(0);
  expect(updated.find((cell) => cell.id === '1-9').status).toBe('partial');
  expect(updated.find((cell) => cell.id === '2-9').coverage).toBe(0);
});

test('one useful keyframe can update several visible cells', () => {
  const cells = updateDirectionalCoverage(createDirectionalCoverage(), {
    visibleCellIds: visibleCells,
    usefulViewpoint: true,
    featureConfidence: 0.75,
    parallax: 0.1,
  });
  expect(visibleCells.every((id) => cells.find((cell) => cell.id === id).distinctViewCount === 1)).toBe(true);
});

test('viewpoint novelty uses translation, angle, or parallax and rejects still frames', () => {
  const previous = { yaw: 40, pitch: 0, parallax: 0, stableMatches: 10 };
  expect(isDistinctViewpoint(previous, { yaw: 40, pitch: 0, parallax: 0.002, stableMatches: 10 })).toBe(false);
  expect(isDistinctViewpoint(previous, { yaw: 40, pitch: 0, parallax: 0.09, stableMatches: 10 })).toBe(true);
  expect(isDistinctViewpoint(previous, { yaw: 54, pitch: 0, parallax: 0.01, stableMatches: 10 })).toBe(true);
  expect(isDistinctViewpoint(previous, { yaw: 40, pitch: 0, parallax: 0.01, translationMeters: 0.2, stableMatches: 10 })).toBe(true);
});

test('coverage states move through low, partial, good, and sufficient without a completion score', () => {
  expect(classifyCoverage(0)).toBe('unknown');
  expect(classifyCoverage(0.2)).toBe('low');
  expect(classifyCoverage(0.5)).toBe('partial');
  expect(classifyCoverage(0.75)).toBe('good');
  expect(classifyCoverage(0.95)).toBe('sufficient');
});

test('Done viability is evidence based and does not require complete room coverage', () => {
  expect(isReconstructionViable()).toBe(false);
  expect(isReconstructionViable({
    keyframes: MIN_VIABLE_SCAN.keyframes,
    distinctViewpoints: MIN_VIABLE_SCAN.distinctViewpoints,
    featureTracks: MIN_VIABLE_SCAN.featureTracks,
    meaningfulCameraMotion: true,
  })).toBe(true);
  expect(isReconstructionViable({
    keyframes: 12,
    distinctViewpoints: 4,
    featureTracks: 24,
    meaningfulCameraMotion: true,
  })).toBe(true);
});

test('triangulation requires multi-view baseline and rejects degenerate rays', () => {
  const track = { id: 'track-a', confidence: 0.9, reprojectionError: 0.01, observations: [{}, {}] };
  const poseA = { keyframeId: 'a', position: { x: 0, y: 0, z: 0 }, ray: { x: 0, y: 0, z: 1 } };
  const poseB = { keyframeId: 'b', position: { x: 0.2, y: 0, z: 0 }, ray: { x: -0.2, y: 0, z: 1 } };
  expect(triangulateFeatureTrack(track, poseA, poseB)).toEqual(expect.objectContaining({ id: 'track-a' }));
  expect(triangulateFeatureTrack(track, poseA, { ...poseB, position: { x: 0.03, y: 0, z: 0 } })).toBeNull();
  expect(triangulateFeatureTrack(track, poseA, { ...poseB, ray: { x: 0, y: 0, z: 1 } })).toBeNull();
});

test('surface patches require stable confident points', () => {
  const points = [
    { position: { x: 0, y: 0, z: 1 }, confidence: 0.8, sourceKeyframes: ['a'], color: { r: 100, g: 120, b: 140 } },
    { position: { x: 1, y: 0, z: 1 }, confidence: 0.75, sourceKeyframes: ['b'], color: { r: 110, g: 130, b: 150 } },
    { position: { x: 0, y: 1, z: 1 }, confidence: 0.72, sourceKeyframes: ['b'], color: { r: 120, g: 140, b: 160 } },
  ];
  expect(createSurfacePatch(points, { planeError: 0.02 })).toEqual(expect.objectContaining({ confidence: expect.any(Number) }));
  expect(createSurfacePatch(points.map((point) => ({ ...point, confidence: 0.4 })), { planeError: 0.02 })).toBeNull();
  expect(createSurfacePatch(points, { planeError: 0.2 })).toBeNull();
});

test('Done can select best non-duplicate keyframes while leaving incomplete regions alone', () => {
  const keyframes = [
    { id: 'one', timestamp: 1, sharpness: 2, stableTrackCount: 5, viewpoint: { yaw: 2, parallax: 0.1 } },
    { id: 'two', timestamp: 2, sharpness: 1, stableTrackCount: 4, viewpoint: { yaw: 3, parallax: 0.105 } },
    { id: 'three', timestamp: 3, sharpness: 8, stableTrackCount: 9, viewpoint: { yaw: 40, parallax: 0.2 } },
  ];
  expect(selectBestKeyframes(keyframes).map((keyframe) => keyframe.id)).toEqual(['one', 'three']);
});

test('no semantic target is needed to update the directional map', () => {
  const cells = updateDirectionalCoverage(createDirectionalCoverage(), {
    visibleCellIds: ['1-8', '1-9', '1-10'],
    usefulViewpoint: true,
    featureConfidence: 0.7,
    parallax: 0.1,
  });
  expect(cells.filter((cell) => cell.coverage > 0)).toHaveLength(3);
  expect(cells.every((cell) => !Object.prototype.hasOwnProperty.call(cell, 'activeTarget'))).toBe(true);
});

test('tracking loss preserves prior coverage and does not fabricate missing regions', () => {
  const beforeLoss = updateDirectionalCoverage(createDirectionalCoverage(), {
    visibleCellIds: ['1-9'],
    usefulViewpoint: true,
    featureConfidence: 0.8,
    parallax: 0.1,
  });
  const afterLoss = updateDirectionalCoverage(beforeLoss, {
    visibleCellIds: [],
    usefulViewpoint: false,
    featureConfidence: 0,
    parallax: 0,
  });
  expect(afterLoss.find((cell) => cell.id === '1-9').coverage).toBe(beforeLoss.find((cell) => cell.id === '1-9').coverage);
  expect(afterLoss.find((cell) => cell.id === '1-8').status).toBe('unknown');
});
