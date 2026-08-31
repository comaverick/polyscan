import {
  IncrementalDepthStore,
  mergePointCloud,
  getStableScanMarkers,
  requestDepthSession,
  sampleDepthSurface,
  sampleDepthPointCloud,
  serializePointCloudToPly,
} from './webxrDepth';

test('requests immersive AR with depth as a required feature', async () => {
  const requestSession = jest.fn(() => Promise.resolve({ id: 'xr-session' }));
  const previousXr = navigator.xr;
  Object.defineProperty(navigator, 'xr', { configurable: true, value: { requestSession } });
  await expect(requestDepthSession()).resolves.toEqual({ id: 'xr-session' });
  expect(requestSession).toHaveBeenCalledWith('immersive-ar', expect.objectContaining({
    requiredFeatures: ['local', 'depth-sensing'],
  }));
  Object.defineProperty(navigator, 'xr', { configurable: true, value: previousXr });
});

test('converts normalized depth samples into world-space points', () => {
  const projectionMatrix = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  const frame = {
    getDepthInformation: () => ({ getDepthInMeters: () => 2 }),
  };
  const pose = {
    views: [{ projectionMatrix, transform: { matrix: projectionMatrix } }],
  };
  const points = sampleDepthPointCloud(frame, pose, { sampleGrid: 4 });
  expect(points).toHaveLength(25);
  expect(points[0]).toMatchObject({ x: -2, y: 2, z: -2, r: 118, g: 211, b: 255 });
});

test('keeps depth-grid indices aligned with sampled points', () => {
  const identity = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  const surface = sampleDepthSurface(
    { getDepthInformation: () => ({ getDepthInMeters: () => 2 }) },
    { views: [{ projectionMatrix: identity, transform: { matrix: identity } }] },
    { sampleGrid: 4 },
  );
  expect(surface.gridSide).toBe(5);
  expect(surface.gridPointIndices).toHaveLength(25);
  expect(surface.gridPointIndices.every((index) => index >= 0)).toBe(true);
  expect(new Set(surface.gridPointIndices).size).toBe(surface.points.length);
});

test('uses the forward XR view transform to place depth points in reference space', () => {
  const projectionMatrix = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    3, 4, 5, 1,
  ];
  const frame = { getDepthInformation: () => ({ getDepthInMeters: () => 1 }) };
  const pose = { views: [{ projectionMatrix: [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ], transform: { matrix: projectionMatrix } }] };
  const [point] = sampleDepthPointCloud(frame, pose, { sampleGrid: 4 });
  expect(point).toMatchObject({ x: 2, y: 5, z: 4 });
});

test('applies the normalized depth-buffer transform for raw CPU depth data', () => {
  const projectionMatrix = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  const rawDepth = new Uint16Array([1000, 2000, 3000, 4000]).buffer;
  const frame = {
    getDepthInformation: () => ({
      width: 2,
      height: 2,
      rawValueToMeters: 0.001,
      depthDataFormat: 'unsigned-short',
      data: rawDepth,
      normDepthBufferFromNormView: { matrix: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0.5, 0, 0, 1,
      ] },
    }),
  };
  const pose = { views: [{ projectionMatrix, transform: { matrix: projectionMatrix } }] };
  const points = sampleDepthPointCloud(frame, pose, { sampleGrid: 4 });
  expect(points).toHaveLength(25);
  expect(points.some((point) => point.z === -4)).toBe(true);
});

test('voxel merges repeated depth samples and serializes a valid PLY', () => {
  const merged = mergePointCloud([{ x: 0, y: 0, z: 0, r: 1, g: 2, b: 3 }], [
    { x: 0.004, y: 0.003, z: 0.002, r: 4, g: 5, b: 6 },
    { x: 0.2, y: 0, z: 0, r: 7, g: 8, b: 9 },
  ], { voxelSize: 0.025 });
  expect(merged).toHaveLength(2);
  const ply = serializePointCloudToPly(merged);
  expect(ply).toContain('element vertex 2');
  expect(ply).toContain('property float z');
  expect(ply).toContain('end_header');
});

test('serializes stable depth-grid faces into the PLY mesh', () => {
  const points = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 1, z: 0 },
  ];
  const ply = serializePointCloudToPly(points, { faces: [[0, 2, 1], [1, 2, 3]] });
  expect(ply).toContain('element face 2');
  expect(ply).toContain('property list uchar int vertex_indices');
  expect(ply).toContain('3 0 2 1');
});

test('stable scan markers keep one world-space position per coarse voxel', () => {
  const markers = getStableScanMarkers([
    { x: 1, y: 2, z: 3 },
    { x: 1.03, y: 2.01, z: 3.02 },
    { x: 1.2, y: 2, z: 3 },
  ], { markerVoxelSize: 0.08 });
  expect(markers).toHaveLength(2);
  expect(markers[0]).toEqual({ x: 1, y: 2, z: 3 });
});

test('incremental depth store confirms and preserves stable markers', () => {
  const store = new IncrementalDepthStore({
    markerConfirmationFrames: 2,
    markerStabilizationFrames: 3,
    maximumMarkers: 4,
  });
  const first = store.addPoints([{ x: 1, y: 2, z: 3 }]);
  expect(first.addedMarkers).toHaveLength(0);
  const second = store.addPoints([{ x: 1.01, y: 2.01, z: 3.01 }]);
  expect(second.addedMarkers).toHaveLength(1);
  expect(second.markerCount).toBe(1);
  const third = store.addPoints([{ x: 1.03, y: 2.03, z: 3.03 }]);
  expect(third.updatedMarkers).toHaveLength(1);
  const fourth = store.addPoints([{ x: 1.1, y: 2.1, z: 3.1 }]);
  expect(fourth.updatedMarkers).toHaveLength(0);
  expect(store.getMarkers()[0].x).toBeCloseTo(1.0133333333333334, 10);
  expect(store.getMarkers()[0].y).toBeCloseTo(2.013333333333333, 10);
  expect(store.getMarkers()[0].z).toBeCloseTo(3.013333333333333, 10);
});

test('incremental depth store closes a continuous grid without duplicate faces', () => {
  const store = new IncrementalDepthStore({
    markerConfirmationFrames: 1,
    meshMaxEdgeLength: 2,
  });
  const surface = {
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
    ],
    gridPoints: [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 1, y: 1, z: 0 },
    ],
    gridPointIndices: [0, 1, 2, 3],
    gridSide: 2,
  };
  const first = store.addSurface(surface);
  const second = store.addSurface(surface);
  expect(first.faceCount).toBe(2);
  expect(second.facesAdded).toBe(0);
  expect(store.getFaces()).toEqual([[0, 2, 1], [1, 2, 3]]);
});

test('storage continues past the live render marker budget', () => {
  const store = new IncrementalDepthStore({
    markerConfirmationFrames: 1,
    markerStabilizationFrames: 1,
    maximumMarkers: 1,
    maximumStoredMarkers: 8,
  });
  const result = store.addPoints([
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
  ]);
  expect(result.markerCount).toBe(2);
  const firstVisible = store.getVisibleMarkers({ x: 0, y: 0, z: 0 }, 1);
  const secondVisible = store.getVisibleMarkers({ x: 0, y: 0, z: 0 }, 1);
  expect(firstVisible).toHaveLength(1);
  expect(secondVisible).toEqual(firstVisible);
});

test('fuses repeated readings instead of preserving a noisy first sample', () => {
  const store = new IncrementalDepthStore({ markerConfirmationFrames: 1 });
  store.addPoints([{ x: 0, y: 0, z: 2, nx: 0, ny: 0, nz: 1 }]);
  const result = store.addPoints([{ x: 0.02, y: 0, z: 2.01, nx: 0, ny: 0, nz: 1 }]);
  expect(result.pointCount).toBe(1);
  expect(store.getPoints()[0].x).toBeCloseTo(0.01, 4);
  expect(store.getPoints()[0].z).toBeCloseTo(2.005, 4);
});

test('locks settled markers and ignores a later far depth spike', () => {
  const store = new IncrementalDepthStore({
    markerConfirmationFrames: 1,
    markerStabilizationFrames: 2,
    markerLockedMatchDistance: 0.04,
  });
  store.addPoints([{ x: 0, y: 0, z: 2 }]);
  store.addPoints([{ x: 0.02, y: 0, z: 2 }]);
  store.addPoints([{ x: 0.08, y: 0, z: 2 }]);
  expect(store.getMarkers()).toHaveLength(1);
  expect(store.getMarkers()[0].x).toBeCloseTo(0.01, 4);
});

test('rebases stored points and markers when the XR origin resets', () => {
  const store = new IncrementalDepthStore({ markerConfirmationFrames: 1 });
  store.addPoints([{ x: 1, y: 2, z: 3 }]);
  const translation = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    4, 5, 6, 1,
  ];
  expect(store.applyReferenceSpaceReset({ matrix: translation })).toBe(true);
  expect(store.getPoints()[0]).toMatchObject({ x: 5, y: 7, z: 9 });
  expect(store.getMarkers()[0]).toMatchObject({ x: 5, y: 7, z: 9 });
});

test('does not bridge a depth discontinuity when estimating normals', () => {
  const projectionMatrix = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
  const frame = {
    getDepthInformation: () => ({
      getDepthInMeters: (x) => x < 0.5 ? 2 : 4,
    }),
  };
  const pose = { views: [{ projectionMatrix, transform: { matrix: projectionMatrix } }] };
  const points = sampleDepthPointCloud(frame, pose, { sampleGrid: 4 });
  expect(points.some((point) => !Number.isFinite(point.nx))).toBe(true);
});
