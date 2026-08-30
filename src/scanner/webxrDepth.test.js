import {
  mergePointCloud,
  getStableScanMarkers,
  requestDepthSession,
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
    views: [{ projectionMatrix, transform: { inverse: { matrix: projectionMatrix } } }],
  };
  const points = sampleDepthPointCloud(frame, pose, { sampleGrid: 4 });
  expect(points).toHaveLength(25);
  expect(points[0]).toMatchObject({ x: -2, y: 2, z: -2, r: 118, g: 211, b: 255 });
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

test('stable scan markers keep one world-space position per coarse voxel', () => {
  const markers = getStableScanMarkers([
    { x: 1, y: 2, z: 3 },
    { x: 1.03, y: 2.01, z: 3.02 },
    { x: 1.2, y: 2, z: 3 },
  ], { markerVoxelSize: 0.08 });
  expect(markers).toHaveLength(2);
  expect(markers[0]).toEqual({ x: 1, y: 2, z: 3 });
});
