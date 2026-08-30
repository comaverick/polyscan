import {
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

test('reprojects a saved mesh when the same surface returns to view', () => {
  const anchor = {
    id: 'wall-1',
    features: source,
    patches: [{
      id: 'triangle',
      confidence: 0.9,
      vertices: source.slice(0, 3).map(({ x, y }) => ({ x, y, depth: 0.5 })),
      centroid: { x: 0.2867, y: 0.3033, depth: 0.5 },
    }],
  };

  const result = localizeSurfaceAnchors([anchor], moved);

  expect(result.localizations).toHaveLength(1);
  expect(result.patches).toHaveLength(1);
  expect(result.patches[0].vertices[0].x).toBeCloseTo(moved[0].x, 3);
  expect(result.patches[0].vertices[0].y).toBeCloseTo(moved[0].y, 3);
});

test('does not leave a mesh floating when the surface cannot be recognized', () => {
  const result = localizeSurfaceAnchors([{
    id: 'wall-1',
    features: source,
    patches: [],
  }], source.slice(0, 3));

  expect(result.localizations).toEqual([]);
  expect(result.patches).toEqual([]);
});
