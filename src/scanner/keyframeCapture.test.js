import { countCapturedKeyframes, getCaptureDimensions, resolveKeyframeAssets } from './keyframeCapture';

test('keeps camera frames at source size when they are already mobile friendly', () => {
  expect(getCaptureDimensions(1280, 720)).toEqual({ width: 1280, height: 720 });
});

test('limits the longest image edge while preserving orientation', () => {
  expect(getCaptureDimensions(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 });
});

test('resolves captured keyframe promises and counts usable images', async () => {
  const blob = new Blob(['photo'], { type: 'image/jpeg' });
  const frames = await resolveKeyframeAssets([
    { id: 'one', capturePromise: Promise.resolve({ blob, width: 1200, height: 1600 }) },
    { id: 'two', capturePromise: Promise.resolve(null) },
  ]);
  expect(countCapturedKeyframes(frames)).toBe(1);
  expect(frames[0].capture.blob).toBe(blob);
  expect(frames[0].capturePromise).toBeUndefined();
});
