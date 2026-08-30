import {
  createSurfaceAnchor,
  estimateSurfaceTransform,
  localizeSurfaceAnchors,
} from './surfaceAnchors';

function feature(id, x, y, descriptor) {
  return { id, x, y, descriptor, color: { r: 110, g: 130, b: 150 } };
}

const source = [
  feature('a', 0.18, 0.2, [1, 0, 0, 0, 0]),
  feature('b', 0.48, 0.19, [0, 1, 0, 0, 0]),
  feature('c', 0.2, 0.52, [0, 0, 1, 0, 0]),
  feature('d', 0.5, 0.5, [0, 0, 0, 1, 0]),
  feature('e', 0.34, 0.34, [0, 0, 0, 0, 1]),
];

const moved = source.map((point) => ({
  ...point,
  x: point.x * 1.08 + 0.07,
  y: point.y * 1.08 - 0.035,
}));

test('estimates a persistent surface transform from visual matches', () => {
  const matches = source.map((point, index) => ({ source: point, target: moved[index] }));
  const transform = estimateSurfaceTransform(matches);

  expect(transform).not.toBeNull();
  expect(transform.inlierCount).toBe(5);
  expect(transform.a).toBeCloseTo(1.08, 3);
  expect(transform.tx).toBeCloseTo(0.07, 3);
  expect(transform.ty).toBeCloseTo(-0.035, 3);
});

test('accepts a perspective-like affine surface change and rejects an outlier', () => {
  const target = source.map((point, index) => ({
    ...point,
    x: point.x * 1.06 + point.y * 0.16 + 0.03 + (index === 4 ? 0.28 : 0),
    y: point.x * -0.08 + point.y * 0.94 + 0.04 + (index === 4 ? -0.22 : 0),
  }));
  const matches = source.map((point, index) => ({ source: point, target: target[index] }));

  const transform = estimateSurfaceTransform(matches);

  expect(transform).not.toBeNull();
  expect(transform.inlierCount).toBe(4);
  expect(transform.b).toBeCloseTo(0.16, 2);
  expect(transform.c).toBeCloseTo(-0.08, 2);
});

test('uses a projective transform when a wall changes perspective', () => {
  const target = source.map((point) => {
    const denominator = 1 + point.x * 0.18 - point.y * 0.08;
    return {
      ...point,
      x: (1.04 * point.x + 0.09 * point.y + 0.035) / denominator,
      y: (-0.04 * point.x + 0.98 * point.y + 0.025) / denominator,
    };
  });
  const transform = estimateSurfaceTransform(source.map((point, index) => ({ source: point, target: target[index] })));

  expect(transform).not.toBeNull();
  expect(transform.g).toBeCloseTo(0.18, 2);
  expect(transform.h).toBeCloseTo(-0.08, 2);
});

test('creates scan stickers without requiring polygon geometry', () => {
  const features = [...source, feature('f', 0.66, 0.31, [0.5, 0.2, 0.1, 0.7, 0.3])]
    .map((item, index) => ({ ...item, score: 80 + index * 3 }));

  const anchor = createSurfaceAnchor({ id: 'chair', features, timestamp: 1 });

  expect(anchor).not.toBeNull();
  expect(anchor.stickers).toHaveLength(6);
  expect(anchor.stickers.every((sticker) => sticker.anchorId.startsWith('chair-tile-'))).toBe(true);
  expect(anchor.patches.length).toBeGreaterThan(0);
  expect(anchor.coverageCells.length).toBeGreaterThan(0);
  expect(anchor.coverageStickers.length).toBeGreaterThan(0);
  expect(anchor.coverageStickers.every((sticker) => sticker.trackable === false)).toBe(true);
});

test('reprojects saved stickers when the same surface returns to view', () => {
  const anchor = {
    id: 'wall-1',
    features: source,
    stickers: [{
      id: 'wall-sticker',
      anchorId: 'wall-1',
      confidence: 0.9,
      x: source[0].x,
      y: source[0].y,
      radius: 0.03,
    }],
  };

  const result = localizeSurfaceAnchors([anchor], moved);

  expect(result.localizations).toHaveLength(1);
  expect(result.stickers).toHaveLength(1);
  expect(result.stickers[0].x).toBeCloseTo(moved[0].x, 3);
  expect(result.stickers[0].y).toBeCloseTo(moved[0].y, 3);
  expect(result.patches).toHaveLength(1);
});

test('reprojects persistent surface coverage cells with the wall', () => {
  const features = [...source, feature('f', 0.66, 0.31, [0.5, 0.2, 0.1, 0.7, 0.3])]
    .map((item, index) => ({ ...item, score: 80 + index * 3 }));
  const anchor = createSurfaceAnchor({ id: 'wall-grid', features, timestamp: 1 });
  const result = localizeSurfaceAnchors([anchor], moved);

  expect(result.coverageCells.length).toBeGreaterThan(0);
  expect(result.coverageCells.every((cell) => cell.vertices.length === 4)).toBe(true);
  expect(result.coverageCells.every((cell) => cell.vertices.every((point) => (
    Number.isFinite(point.x) && Number.isFinite(point.y)
  )))).toBe(true);
});

test('does not leave a mesh floating when the surface cannot be recognized', () => {
  const result = localizeSurfaceAnchors([{
    id: 'wall-1',
    features: source,
    stickers: [],
  }], source.slice(0, 3));

  expect(result.localizations).toEqual([]);
  expect(result.stickers).toEqual([]);
});
