import {
  extractFrameFeatures,
  matchFrameFeatures,
} from './featureTracking';
import {
  createSurfaceAnchor,
  localizeSurfaceAnchors,
} from './surfaceAnchors';

function texturedImage(width, height, shiftX = 0, shiftY = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = x - shiftX;
      const sourceY = y - shiftY;
      const inside = sourceX >= 0 && sourceX < width && sourceY >= 0 && sourceY < height;
      const value = inside
        ? ((sourceX * 37 + sourceY * 53 + sourceX * sourceY * 7) % 239 + 239) % 239
        : 0;
      const index = (y * width + x) * 4;
      data[index] = value;
      data[index + 1] = (value * 3 + 17) % 255;
      data[index + 2] = (value * 5 + 29) % 255;
      data[index + 3] = 255;
    }
  }
  return { data };
}

function featuresFrom(image, width, height) {
  return extractFrameFeatures({ getImageData: () => image }, width, height);
}

test('finds repeatable details after a camera-like image translation', () => {
  const width = 160;
  const height = 120;
  const previous = featuresFrom(texturedImage(width, height), width, height);
  const current = featuresFrom(texturedImage(width, height, 4, 4), width, height);
  const matches = matchFrameFeatures(previous, current);

  expect(previous.length).toBeGreaterThan(30);
  expect(current.length).toBeGreaterThan(30);
  expect(matches.length).toBeGreaterThan(12);
});

test('relocalizes real extracted descriptors instead of perfect test descriptors', () => {
  const width = 160;
  const height = 120;
  const previous = featuresFrom(texturedImage(width, height), width, height);
  const current = featuresFrom(texturedImage(width, height, 4, 4), width, height);
  const anchor = createSurfaceAnchor({ id: 'real-frame', features: previous, timestamp: 0 });
  const localized = localizeSurfaceAnchors([anchor], current);

  expect(localized.localizations).toHaveLength(1);
  expect(localized.stickers.length).toBeGreaterThan(20);
});
