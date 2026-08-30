import { trackSurfaceStickerGroups } from './surfaceFlow';

function texturedFrame(width, height, shiftX = 0, shiftY = 0) {
  const frame = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - shiftX;
      const sourceY = y - shiftY;
      frame[y * width + x] = ((sourceX * 29 + sourceY * 47 + sourceX * sourceY * 3) % 211 + 211) % 211;
    }
  }
  return frame;
}

test('keeps surface stickers attached across consecutive translated frames', () => {
  const width = 72;
  const height = 54;
  const previous = texturedFrame(width, height);
  const current = texturedFrame(width, height, 4, -2);
  const stickers = [
    { id: 'a', anchorId: 'wall', x: 0.3, y: 0.35, confidence: 0.9 },
    { id: 'b', anchorId: 'wall', x: 0.5, y: 0.4, confidence: 0.9 },
    { id: 'c', anchorId: 'wall', x: 0.4, y: 0.65, confidence: 0.9 },
    { id: 'd', anchorId: 'wall', x: 0.65, y: 0.62, confidence: 0.9 },
  ];

  const result = trackSurfaceStickerGroups(previous, current, width, height, stickers);

  expect(result.trackedCount).toBeGreaterThanOrEqual(3);
  expect(Math.round(result.stickers[0].x * width) - Math.round(stickers[0].x * width)).toBe(4);
  expect(Math.round(result.stickers[0].y * height) - Math.round(stickers[0].y * height)).toBe(-2);
});

test('drops stickers instead of floating when the image no longer matches', () => {
  const width = 72;
  const height = 54;
  const previous = texturedFrame(width, height);
  const current = new Uint8Array(width * height).fill(128);
  const stickers = [
    { id: 'a', anchorId: 'wall', x: 0.3, y: 0.35, confidence: 0.9 },
    { id: 'b', anchorId: 'wall', x: 0.5, y: 0.4, confidence: 0.9 },
    { id: 'c', anchorId: 'wall', x: 0.4, y: 0.65, confidence: 0.9 },
  ];

  expect(trackSurfaceStickerGroups(previous, current, width, height, stickers).stickers).toEqual([]);
});
