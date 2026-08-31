import { buildCaptureAssets, createCaptureManifest } from './reconstructionClient';
import { serializePointCloudToPly } from './webxrDepth';

test('builds a reconstruction upload from video and full-resolution keyframes', () => {
  const video = new Blob(['video'], { type: 'video/mp4' });
  const photo = new Blob(['photo'], { type: 'image/jpeg' });
  const assets = buildCaptureAssets({
    capture: { blob: video },
    keyframes: [{ id: 'frame-one', capture: { blob: photo, width: 1200, height: 1600 } }],
  });
  expect(assets.map((asset) => asset.kind)).toEqual(['video', 'image']);
  expect(assets[1].keyframeId).toBe('frame-one');
});

test('builds a depth point-cloud asset for Android reconstruction', () => {
  const pointCloud = Array.from({ length: 100 }, (_, index) => ({ x: index * 0.04, y: 0, z: 1, nx: 0, ny: 0, nz: 1 }));
  const assets = buildCaptureAssets({ pointCloud });
  expect(assets).toHaveLength(1);
  expect(assets[0]).toMatchObject({ kind: 'pointcloud', filename: 'depth-scan.ply' });
  expect(assets[0].blob.size).toBeGreaterThan(0);
  expect(serializePointCloudToPly(pointCloud)).toContain('property float nx');
});

test('builds a measured mesh asset when stable depth faces are available', () => {
  const pointCloud = Array.from({ length: 100 }, (_, index) => ({ x: index * 0.01, y: 0, z: 0 }));
  const assets = buildCaptureAssets({ pointCloud, faces: [[0, 2, 1]] });
  expect(assets).toHaveLength(1);
  expect(assets[0]).toMatchObject({ kind: 'mesh', filename: 'depth-scan.ply' });
});

test('marks the manifest as a photogrammetry image capture', () => {
  const photo = new Blob(['photo'], { type: 'image/jpeg' });
  const manifest = createCaptureManifest({ frameCount: 32, webXRPointCloud: [{ x: 0, y: 0, z: 0 }], webXRMeshFaces: [[0, 0, 0]] }, [{
    id: 'frame-one',
    timestamp: 12,
    capture: { blob: photo, width: 1200, height: 1600 },
  }]);
  expect(manifest.version).toBe(2);
  expect(manifest.imageCount).toBe(1);
  expect(manifest.depthPointCount).toBe(1);
  expect(manifest.depthFaceCount).toBe(1);
  expect(manifest.keyframes[0].filename).toBe('keyframe-0001.jpg');
});
