import { clamp } from './coverageModel';

function triangleArea(first, second, third) {
  return Math.abs(
    (first.x * (second.y - third.y)
      + second.x * (third.y - first.y)
      + third.x * (first.y - second.y)) / 2,
  );
}

function colorDistance(first = {}, second = {}) {
  const red = (first.r || 0) - (second.r || 0);
  const green = (first.g || 0) - (second.g || 0);
  const blue = (first.b || 0) - (second.b || 0);
  return Math.sqrt(red ** 2 + green ** 2 + blue ** 2) / 441.7;
}

function pointDepth(point) {
  const color = point.color || {};
  const luminance = ((color.r || 0) * 0.2126 + (color.g || 0) * 0.7152 + (color.b || 0) * 0.0722) / 255;
  return clamp(0.2 + (1 - luminance) * 0.42 + (point.confidence || 0) * 0.24 + (0.5 - point.y) * 0.06);
}

/**
 * Creates a compact capture-feedback mesh from nearby, similarly colored image
 * features. It follows local image detail and intentionally does not represent
 * measured world geometry.
 */
export function buildCaptureMesh(features = [], options = {}) {
  const minimumConfidence = options.minimumConfidence ?? 0.24;
  const maximumEdge = options.maximumEdge ?? 0.17;
  const maximumColorDistance = options.maximumColorDistance ?? 0.34;
  const minimumArea = options.minimumArea ?? 0.00018;
  const maximumArea = options.maximumArea ?? 0.009;
  const maximumTriangles = options.maximumTriangles ?? 84;
  const maximumPerAnchor = options.maximumPerAnchor ?? 3;
  const points = features
    .filter((feature) => Number.isFinite(feature.x)
      && Number.isFinite(feature.y)
      && feature.x >= 0 && feature.x <= 1
      && feature.y >= 0 && feature.y <= 1
      && (feature.confidence || 0) >= minimumConfidence)
    .map((feature, index) => ({ ...feature, meshId: feature.id || `capture-point-${index}` }));
  const used = new Set();
  const triangles = [];

  points.forEach((anchor) => {
    const neighbors = points
      .filter((point) => point !== anchor)
      .map((point) => ({
        point,
        distance: Math.hypot(point.x - anchor.x, point.y - anchor.y),
        angle: Math.atan2(point.y - anchor.y, point.x - anchor.x),
        colorDifference: colorDistance(anchor.color, point.color),
      }))
      .filter(({ distance, colorDifference }) => distance <= maximumEdge && colorDifference <= maximumColorDistance)
      .sort((first, second) => first.angle - second.angle);

    let trianglesForAnchor = 0;
    for (let index = 0; index < neighbors.length; index += 1) {
      const first = neighbors[index]?.point;
      const second = neighbors[(index + 1) % neighbors.length]?.point;
      if (!first || !second || first === second) continue;
      if (Math.hypot(first.x - second.x, first.y - second.y) > maximumEdge * 1.18) continue;

      const key = [anchor.meshId, first.meshId, second.meshId].sort().join('|');
      if (used.has(key)) continue;
      const area = triangleArea(anchor, first, second);
      const longestEdge = Math.max(
        Math.hypot(anchor.x - first.x, anchor.y - first.y),
        Math.hypot(anchor.x - second.x, anchor.y - second.y),
        Math.hypot(first.x - second.x, first.y - second.y),
      );
      const shapeQuality = area / Math.max(longestEdge * longestEdge, 0.000001);
      if (area < minimumArea || area > maximumArea || shapeQuality < 0.055) continue;

      used.add(key);
      const source = [anchor, first, second];
      const vertices = source.map((point) => ({ x: point.x, y: point.y, depth: pointDepth(point) }));
      const confidence = clamp(source.reduce((sum, point) => sum + (point.confidence || 0), 0) / 3);
      const centroid = {
        x: vertices.reduce((sum, vertex) => sum + vertex.x, 0) / 3,
        y: vertices.reduce((sum, vertex) => sum + vertex.y, 0) / 3,
        depth: vertices.reduce((sum, vertex) => sum + vertex.depth, 0) / 3,
      };
      triangles.push({ id: `capture-mesh-${key}`, confidence, vertices, centroid, area });
      trianglesForAnchor += 1;
      if (trianglesForAnchor >= maximumPerAnchor || triangles.length >= maximumTriangles) break;
    }
  });

  return triangles
    .sort((first, second) => second.confidence - first.confidence || first.area - second.area)
    .slice(0, maximumTriangles);
}
