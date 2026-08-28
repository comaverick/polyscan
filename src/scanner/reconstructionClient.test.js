import { buildCaptureAssets, createCaptureManifest } from './reconstructionClient';

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

test('marks the manifest as a photogrammetry image capture', () => {
  const photo = new Blob(['photo'], { type: 'image/jpeg' });
  const manifest = createCaptureManifest({ frameCount: 32 }, [{
    id: 'frame-one',
    timestamp: 12,
    capture: { blob: photo, width: 1200, height: 1600 },
  }]);
  expect(manifest.version).toBe(2);
  expect(manifest.imageCount).toBe(1);
  expect(manifest.keyframes[0].filename).toBe('keyframe-0001.jpg');
});
