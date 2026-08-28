import { buildScreenMesh } from './featureTracking';

const trackedSurface = [
  { id: 'a', x: 0.2, y: 0.2, confidence: 0.88 },
  { id: 'b', x: 0.31, y: 0.21, confidence: 0.82 },
  { id: 'c', x: 0.24, y: 0.31, confidence: 0.8 },
  { id: 'd', x: 0.35, y: 0.34, confidence: 0.76 },
  { id: 'e', x: 0.42, y: 0.25, confidence: 0.72 },
];

test('builds compact screen-space polygons from stable tracked features', () => {
  const mesh = buildScreenMesh(trackedSurface);
  expect(mesh.length).toBeGreaterThan(0);
  expect(mesh.every((patch) => patch.screenVertices.length === 3)).toBe(true);
  expect(mesh.every((patch) => patch.confidence >= 0.18)).toBe(true);
});

test('does not reveal untracked or degenerate image regions', () => {
  expect(buildScreenMesh(trackedSurface.map((point) => ({ ...point, confidence: 0.05 })))).toEqual([]);
  expect(buildScreenMesh([
    { id: 'a', x: 0.1, y: 0.1, confidence: 0.9 },
    { id: 'b', x: 0.2, y: 0.2, confidence: 0.9 },
    { id: 'c', x: 0.3, y: 0.3, confidence: 0.9 },
  ])).toEqual([]);
});

test('respects the mesh complexity limit for mobile rendering', () => {
  const dense = Array.from({ length: 36 }, (_, index) => ({
    id: `point-${index}`,
    x: 0.18 + (index % 6) * 0.065,
    y: 0.18 + Math.floor(index / 6) * 0.065,
    confidence: 0.8,
  }));
  expect(buildScreenMesh(dense, { maximumTriangles: 18 })).toHaveLength(18);
});
