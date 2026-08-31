const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  hasUsableMesh,
  hasUsablePointCloud,
  readPlyHeader,
} = require('../../server/colmap-worker.cjs');

test('detects empty Poisson output and accepts a non-empty point cloud', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'polyscan-ply-'));
  const emptyMesh = path.join(directory, 'empty.ply');
  const pointCloud = path.join(directory, 'cloud.ply');
  const mesh = path.join(directory, 'mesh.ply');
  try {
    fs.writeFileSync(emptyMesh, [
      'ply',
      'format binary_little_endian 1.0',
      'element vertex 0',
      'element face 0',
      'end_header',
      '',
    ].join('\n'));
    fs.writeFileSync(pointCloud, [
      'ply',
      'format ascii 1.0',
      'element vertex 1',
      'property float x',
      'property float y',
      'property float z',
      'end_header',
      '0 0 0',
    ].join('\n'));
    fs.writeFileSync(mesh, [
      'ply',
      'format ascii 1.0',
      'element vertex 3',
      'element face 1',
      'end_header',
    ].join('\n'));

    expect(readPlyHeader(emptyMesh)).toEqual({ vertexCount: 0, faceCount: 0 });
    expect(hasUsableMesh(emptyMesh)).toBe(false);
    expect(hasUsablePointCloud(pointCloud)).toBe(true);
    expect(hasUsableMesh(mesh)).toBe(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
