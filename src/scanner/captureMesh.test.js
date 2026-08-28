import { buildCaptureMesh } from './captureMesh';

const blueSurface = { r: 70, g: 112, b: 160 };
const warmSurface = { r: 210, g: 156, b: 88 };

function point(id, x, y, color = blueSurface, confidence = 0.82) {
  return { id, x, y, color, confidence };
}

test('builds short local triangles that follow a tracked surface', () => {
  const mesh = buildCaptureMesh([
    point('a', 0.2, 0.2),
    point('b', 0.29, 0.2),
    point('c', 0.22, 0.29),
    point('d', 0.31, 0.3),
    point('e', 0.38, 0.23),
  ]);

  expect(mesh.length).toBeGreaterThan(0);
  expect(mesh.every((patch) => patch.vertices.length === 3)).toBe(true);
  expect(mesh.every((patch) => patch.vertices.every((vertex) => Number.isFinite(vertex.depth)))).toBe(true);
  expect(mesh.every((patch) => patch.area <= 0.009)).toBe(true);
});

test('does not bridge differently colored object regions', () => {
  const mesh = buildCaptureMesh([
    point('blue-a', 0.2, 0.2),
    point('blue-b', 0.29, 0.2),
    point('warm-a', 0.23, 0.29, warmSurface),
    point('warm-b', 0.32, 0.3, warmSurface),
  ], { maximumColorDistance: 0.12 });

  expect(mesh).toEqual([]);
});

test('caps polygon count for mobile rendering', () => {
  const dense = Array.from({ length: 49 }, (_, index) => point(
    `point-${index}`,
    0.18 + (index % 7) * 0.055,
    0.18 + Math.floor(index / 7) * 0.055,
  ));

  expect(buildCaptureMesh(dense, { maximumTriangles: 24 })).toHaveLength(24);
});
