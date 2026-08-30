const DEFAULT_OPTIONS = Object.freeze({
  sampleGrid: 28,
  minimumDepth: 0.2,
  maximumDepth: 12,
  voxelSize: 0.025,
  maximumPoints: 80000,
  markerVoxelSize: 0.08,
  maximumMarkers: 12000,
});

function canUseNavigatorXR() {
  return typeof navigator !== 'undefined' && Boolean(navigator.xr?.requestSession);
}

/**
 * Requests an Android WebXR session only when it can provide CPU depth.
 * Calling requestSession directly preserves the user gesture required by
 * immersive AR. Unsupported phones simply return null for the camera fallback.
 */
export function requestDepthSession() {
  if (!canUseNavigatorXR()) return Promise.resolve(null);
  const options = {
    requiredFeatures: ['local', 'depth-sensing'],
    optionalFeatures: ['local-floor', 'hit-test', 'anchors', 'dom-overlay'],
    depthSensing: {
      usagePreference: ['cpu-optimized'],
      dataFormatPreference: ['luminance-alpha', 'float32'],
    },
    domOverlay: { root: document.body },
  };
  return navigator.xr.requestSession('immersive-ar', options).catch(() => null);
}

function transformPoint(matrix, point) {
  if (!matrix || matrix.length < 16) return null;
  const x = point.x;
  const y = point.y;
  const z = point.z;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (Math.abs(w) < 0.000001) return null;
  return {
    x: (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
    y: (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
    z: (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w,
  };
}

function readDepth(depthInfo, x, y) {
  if (typeof depthInfo?.getDepthInMeters === 'function') {
    try {
      return depthInfo.getDepthInMeters(x, y);
    } catch {
      return null;
    }
  }
  const width = Number(depthInfo?.width || 0);
  const height = Number(depthInfo?.height || 0);
  const scale = Number(depthInfo?.rawValueToMeters || 0);
  const data = depthInfo?.data;
  if (!width || !height || !scale || !data) return null;
  const column = Math.max(0, Math.min(width - 1, Math.round(x * (width - 1))));
  const row = Math.max(0, Math.min(height - 1, Math.round(y * (height - 1))));
  const index = column + row * width;
  if (depthInfo.depthDataFormat === 'float32') return new Float32Array(data)[index] * scale;
  return new Uint16Array(data)[index] * scale;
}

/**
 * Samples a CPU depth buffer and converts it into points in the XR reference
 * space. The camera pose comes from WebXR, so returning to a surface keeps the
 * same world coordinates rather than redrawing a screen-space sticker.
 */
export function sampleDepthPointCloud(frame, pose, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const points = [];
  const view = pose?.views?.[0];
  if (!frame || !view || typeof frame.getDepthInformation !== 'function') return points;
  let depthInfo;
  try {
    depthInfo = frame.getDepthInformation(view);
  } catch {
    return points;
  }
  const viewToWorld = view.transform?.inverse?.matrix;
  const projection = view.projectionMatrix;
  if (!depthInfo || !viewToWorld || !projection) return points;
  const step = Math.max(4, Math.round(settings.sampleGrid));
  for (let row = 0; row <= step; row += 1) {
    const y = row / step;
    for (let column = 0; column <= step; column += 1) {
      const x = column / step;
      const depth = readDepth(depthInfo, x, y);
      if (!Number.isFinite(depth) || depth < settings.minimumDepth || depth > settings.maximumDepth) continue;
      // WebXR projection matrices are column-major. Depth is measured along
      // the view's optical axis, so unproject the normalized sample at -depth.
      // For a perspective matrix, NDC = -(focal * viewCoordinate / z) -
      // projectionOffset. Substituting z = -depth gives the expressions below.
      const viewPoint = {
        x: ((x * 2 - 1 + projection[8]) / projection[0]) * depth,
        y: ((1 - y * 2 + projection[9]) / projection[5]) * depth,
        z: -depth,
      };
      const worldPoint = transformPoint(viewToWorld, viewPoint);
      if (worldPoint) points.push({ ...worldPoint, r: 118, g: 211, b: 255 });
    }
  }
  return points;
}

export function mergePointCloud(previousPoints = [], nextPoints = [], options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const voxels = new Map();
  previousPoints.forEach((point) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || !Number.isFinite(point?.z)) return;
    const key = [Math.round(point.x / settings.voxelSize), Math.round(point.y / settings.voxelSize), Math.round(point.z / settings.voxelSize)].join(':');
    voxels.set(key, point);
  });
  nextPoints.forEach((point) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || !Number.isFinite(point?.z)) return;
    const key = [Math.round(point.x / settings.voxelSize), Math.round(point.y / settings.voxelSize), Math.round(point.z / settings.voxelSize)].join(':');
    if (!voxels.has(key)) voxels.set(key, point);
  });
  return [...voxels.values()].slice(0, settings.maximumPoints);
}

/**
 * Produces a coarser, stable subset for the live scan visualization. The
 * marker key is derived from an already merged world-space point, so returning
 * to a surface reuses the same marker instead of moving a screen overlay.
 */
export function getStableScanMarkers(points = [], options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const markers = new Map();
  points.forEach((point) => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y) || !Number.isFinite(point?.z)) return;
    const key = [
      Math.round(point.x / settings.markerVoxelSize),
      Math.round(point.y / settings.markerVoxelSize),
      Math.round(point.z / settings.markerVoxelSize),
    ].join(':');
    if (!markers.has(key)) markers.set(key, {
      x: point.x,
      y: point.y,
      z: point.z,
    });
  });
  return [...markers.values()].slice(0, settings.maximumMarkers);
}

export function serializePointCloudToPly(points = []) {
  const validPoints = points.filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z));
  const header = [
    'ply',
    'format ascii 1.0',
    `element vertex ${validPoints.length}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header',
  ].join('\n');
  const rows = validPoints.map((point) => `${point.x.toFixed(5)} ${point.y.toFixed(5)} ${point.z.toFixed(5)} ${Math.round(point.r ?? 118)} ${Math.round(point.g ?? 211)} ${Math.round(point.b ?? 255)}`);
  return `${header}\n${rows.join('\n')}\n`;
}

export { DEFAULT_OPTIONS as WEBXR_DEPTH_OPTIONS };
