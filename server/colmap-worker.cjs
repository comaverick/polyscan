const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function run(binary, args, options = {}) {
  try {
    return await execFileAsync(binary, args, {
      cwd: options.cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: process.env,
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    throw new Error(`${path.basename(binary)} failed${detail ? `: ${detail}` : ''}`);
  }
}

function readPlyHeader(filename) {
  if (!fs.existsSync(filename)) return { vertexCount: 0, faceCount: 0 };
  const file = fs.openSync(filename, 'r');
  try {
    // PLY headers are small even for binary files. Reading a bounded prefix
    // avoids loading a potentially large point cloud just to validate it.
    const buffer = Buffer.alloc(256 * 1024);
    const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
    const header = buffer.toString('utf8', 0, bytesRead);
    const vertexMatch = header.match(/\belement\s+vertex\s+(\d+)\b/i);
    const faceMatch = header.match(/\belement\s+face\s+(\d+)\b/i);
    return {
      vertexCount: vertexMatch ? Number(vertexMatch[1]) : 0,
      faceCount: faceMatch ? Number(faceMatch[1]) : 0,
    };
  } finally {
    fs.closeSync(file);
  }
}

function hasUsablePointCloud(filename) {
  return readPlyHeader(filename).vertexCount > 0;
}

function hasUsableMesh(filename) {
  const header = readPlyHeader(filename);
  return header.vertexCount > 0 && header.faceCount > 0;
}

function existingAssets(captureDirectory, assets, kind) {
  return (assets || [])
    .filter((asset) => asset.kind === kind)
    .map((asset) => ({ ...asset, path: path.join(captureDirectory, asset.storedName) }))
    .filter((asset) => fs.existsSync(asset.path));
}

async function prepareImages({ captureDirectory, assets, workspace, onProgress }) {
  const imagesDirectory = path.join(workspace, 'images');
  fs.mkdirSync(imagesDirectory, { recursive: true });
  const photos = existingAssets(captureDirectory, assets, 'image');
  photos.forEach((photo, index) => {
    const extension = path.extname(photo.filename || photo.storedName) || '.jpg';
    fs.copyFileSync(photo.path, path.join(imagesDirectory, `frame-${String(index + 1).padStart(4, '0')}${extension}`));
  });

  if (photos.length < 12) {
    const [video] = existingAssets(captureDirectory, assets, 'video');
    if (video) {
      const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
      onProgress(5, 'Extracting sharp video frames');
      await run(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-i', video.path,
        '-vf', 'fps=2,scale=1600:-2:force_original_aspect_ratio=decrease',
        '-q:v', '2', path.join(imagesDirectory, 'video-%04d.jpg'),
      ], { cwd: workspace });
    }
  }

  const imageCount = fs.readdirSync(imagesDirectory).filter((name) => /\.(jpe?g|png)$/i.test(name)).length;
  if (imageCount < 12) throw new Error('At least 12 overlapping room images are required for reconstruction.');
  return { imagesDirectory, imageCount };
}

async function runDepthPipeline({ captureDirectory, assets, workspace, onProgress = () => {} }) {
  const [measuredMesh] = existingAssets(captureDirectory, assets, 'mesh');
  const [pointCloud] = existingAssets(captureDirectory, assets, 'pointcloud');
  if (!measuredMesh && !pointCloud) throw new Error('The depth scan did not include a point cloud or mesh asset.');
  fs.mkdirSync(workspace, { recursive: true });
  const modelPath = path.join(workspace, 'room.ply');
  if (measuredMesh && hasUsableMesh(measuredMesh.path)) {
    fs.copyFileSync(measuredMesh.path, modelPath);
    onProgress(100, 'Measured depth mesh ready');
    return { modelPath, imageCount: 0, format: 'ply', kind: 'mesh', coordinateSystem: 'world' };
  }
  if (!pointCloud || !hasUsablePointCloud(pointCloud.path)) {
    throw new Error('The depth scan mesh and point cloud are empty. Scan more surfaces and try again.');
  }
  const colmap = process.env.COLMAP_PATH || 'colmap';
  onProgress(25, 'Preparing the measured depth surface');
  try {
    // COLMAP can close an oriented depth cloud into a surface when its
    // Poisson mesher is available. The uploaded PLY includes normals from the
    // browser depth grid, so this path does not need camera images.
    await run(colmap, ['poisson_mesher', '--input_path', pointCloud.path, '--output_path', modelPath], { cwd: workspace });
    if (hasUsableMesh(modelPath)) {
      onProgress(100, 'Depth room mesh ready');
      return { modelPath, imageCount: 0, format: 'ply', kind: 'mesh', coordinateSystem: 'world' };
    }
  } catch {
    // A raw point cloud remains a valid geometric preview when COLMAP is not
    // installed or cannot close an incomplete room surface.
  }
  // Poisson can exit successfully while writing a zero-vertex (or
  // zero-face) file when the measured surface is too sparse. Never expose
  // that file to the viewer; the original measured cloud is still renderable.
  fs.copyFileSync(pointCloud.path, modelPath);
  onProgress(100, 'Depth point cloud ready');
  return { modelPath, imageCount: 0, format: 'ply', kind: 'pointcloud', pointSize: 0.018, coordinateSystem: 'world' };
}

async function runColmapPipeline({ captureDirectory, assets, workspace, onProgress = () => {} }) {
  if (existingAssets(captureDirectory, assets, 'mesh').length || existingAssets(captureDirectory, assets, 'pointcloud').length) {
    return runDepthPipeline({ captureDirectory, assets, workspace, onProgress });
  }
  const colmap = process.env.COLMAP_PATH || 'colmap';
  fs.mkdirSync(workspace, { recursive: true });
  const { imagesDirectory, imageCount } = await prepareImages({ captureDirectory, assets, workspace, onProgress });
  const databasePath = path.join(workspace, 'database.db');
  const sparseDirectory = path.join(workspace, 'sparse');
  const denseDirectory = path.join(workspace, 'dense');
  fs.mkdirSync(sparseDirectory, { recursive: true });
  fs.mkdirSync(denseDirectory, { recursive: true });

  onProgress(12, `Finding features in ${imageCount} images`);
  await run(colmap, [
    'feature_extractor', '--database_path', databasePath, '--image_path', imagesDirectory,
    '--ImageReader.single_camera', '1', '--ImageReader.camera_model', 'SIMPLE_RADIAL',
    '--SiftExtraction.use_gpu', process.env.COLMAP_USE_GPU === '0' ? '0' : '1',
  ], { cwd: workspace });

  onProgress(27, 'Matching overlapping viewpoints');
  await run(colmap, [
    'sequential_matcher', '--database_path', databasePath,
    '--SiftMatching.guided_matching', '1',
    '--SiftMatching.use_gpu', process.env.COLMAP_USE_GPU === '0' ? '0' : '1',
  ], { cwd: workspace });

  onProgress(42, 'Solving camera positions');
  await run(colmap, [
    'mapper', '--database_path', databasePath, '--image_path', imagesDirectory,
    '--output_path', sparseDirectory,
  ], { cwd: workspace });

  const sparseModels = fs.readdirSync(sparseDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (!sparseModels.length) throw new Error('The images did not have enough overlap to solve a room model.');
  const sparseModel = path.join(sparseDirectory, sparseModels[0].name);

  onProgress(58, 'Preparing dense reconstruction');
  await run(colmap, [
    'image_undistorter', '--image_path', imagesDirectory, '--input_path', sparseModel,
    '--output_path', denseDirectory, '--output_type', 'COLMAP', '--max_image_size', '1600',
  ], { cwd: workspace });

  onProgress(66, 'Estimating depth');
  await run(colmap, [
    'patch_match_stereo', '--workspace_path', denseDirectory,
    '--workspace_format', 'COLMAP', '--PatchMatchStereo.geom_consistency', 'true',
  ], { cwd: workspace });

  const fusedPath = path.join(denseDirectory, 'fused.ply');
  onProgress(82, 'Fusing the room surface');
  await run(colmap, [
    'stereo_fusion', '--workspace_path', denseDirectory, '--workspace_format', 'COLMAP',
    '--input_type', 'geometric', '--output_path', fusedPath,
  ], { cwd: workspace });

  const modelPath = path.join(workspace, 'room.ply');
  onProgress(91, 'Building the walkable mesh');
  try {
    await run(colmap, ['poisson_mesher', '--input_path', fusedPath, '--output_path', modelPath], { cwd: workspace });
  } catch (error) {
    // A dense fused cloud is still useful when Poisson cannot close a surface
    // (common with plain walls, glass, or a short phone capture). Returning it
    // lets the first-person viewer open instead of throwing away the build.
    if (!hasUsablePointCloud(fusedPath)) throw error;
    fs.copyFileSync(fusedPath, modelPath);
    onProgress(96, 'Surface mesh incomplete; preparing the scanned point cloud');
    return { modelPath, imageCount, format: 'ply', kind: 'pointcloud', pointSize: 0.022 };
  }
  if (!hasUsableMesh(modelPath)) {
    if (!hasUsablePointCloud(fusedPath)) throw new Error('COLMAP completed without producing a usable room model.');
    fs.copyFileSync(fusedPath, modelPath);
    onProgress(96, 'Surface mesh incomplete; preparing the scanned point cloud');
    return { modelPath, imageCount, format: 'ply', kind: 'pointcloud', pointSize: 0.022 };
  }
  onProgress(100, 'Room ready');
  return { modelPath, imageCount, format: 'ply', kind: 'mesh' };
}

module.exports = {
  runColmapPipeline,
  readPlyHeader,
  hasUsablePointCloud,
  hasUsableMesh,
};
