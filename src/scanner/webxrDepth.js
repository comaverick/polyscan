const DEFAULT_OPTIONS = Object.freeze({
  sampleGrid: 20,
  minimumDepth: 0.2,
  maximumDepth: 12,
  voxelSize: 0.025,
  maximumPoints: 80000,
  markerVoxelSize: 0.08,
  maximumMarkers: 6000,
  markerConfirmationFrames: 2,
  markerStabilizationFrames: 3,
});

function isFinitePoint(point) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) && Number.isFinite(point?.z);
}

function voxelKey(point, voxelSize) {
  return [
    Math.round(point.x / voxelSize),
    Math.round(point.y / voxelSize),
    Math.round(point.z / voxelSize),
  ].join('|');
}

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

function createDepthReader(depthInfo) {
  if (typeof depthInfo?.getDepthInMeters === 'function') {
    return (x, y) => {
      try {
        return depthInfo.getDepthInMeters(x, y);
      } catch {
        return null;
      }
    };
  }
  const width = Number(depthInfo?.width || 0);
  const height = Number(depthInfo?.height || 0);
  const scale = Number(depthInfo?.rawValueToMeters || 0);
  const data = depthInfo?.data;
  if (!width || !height || !scale || !data) return null;
  let values;
  try {
    // Create this view once per depth frame. Creating a typed-array view for
    // every sample used to cause avoidable allocations on CPU-depth devices.
    values = depthInfo.depthDataFormat === 'float32'
      ? new Float32Array(data)
      : new Uint16Array(data);
  } catch {
    return null;
  }
  return (x, y) => {
    const column = Math.max(0, Math.min(width - 1, Math.round(x * (width - 1))));
    const row = Math.max(0, Math.min(height - 1, Math.round(y * (height - 1))));
    return values[column + row * width] * scale;
  };
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
  // XRView.transform places the view in the requested reference space. Its
  // inverse is the view matrix (world -> camera), which is the opposite of
  // what depth samples need here.
  const viewToWorld = view.transform?.matrix;
  const projection = view.projectionMatrix;
  if (!depthInfo || !viewToWorld || !projection) return points;
  const readDepth = createDepthReader(depthInfo);
  if (!readDepth) return points;
  const step = Math.max(4, Math.round(settings.sampleGrid));
  for (let row = 0; row <= step; row += 1) {
    const y = row / step;
    for (let column = 0; column <= step; column += 1) {
      const x = column / step;
      const depth = readDepth(x, y);
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
    if (!isFinitePoint(point)) return;
    const key = voxelKey(point, settings.voxelSize);
    voxels.set(key, point);
  });
  nextPoints.forEach((point) => {
    if (!isFinitePoint(point)) return;
    const key = voxelKey(point, settings.voxelSize);
    if (!voxels.has(key)) voxels.set(key, point);
  });
  return [...voxels.values()].slice(0, settings.maximumPoints);
}

/**
 * Keeps the long-lived scan map incremental. The old mergePointCloud helper
 * remains available for imports and tests, but the live XR loop should never
 * rebuild a map from all historical points on every frame.
 */
export class IncrementalDepthStore {
  constructor(options = {}) {
    this.settings = { ...DEFAULT_OPTIONS, ...options };
    this.voxels = new Map();
    this.markers = new Map();
    this.points = [];
    this.confirmedMarkerCount = 0;
  }

  addPoints(nextPoints = []) {
    const addedPoints = [];
    const addedMarkers = [];
    const updatedMarkers = [];
    const seenMarkerKeys = new Set();
    const confirmationFrames = Math.max(1, Math.round(this.settings.markerConfirmationFrames));
    const stabilizationFrames = Math.max(confirmationFrames, Math.round(this.settings.markerStabilizationFrames));

    nextPoints.forEach((point) => {
      if (!isFinitePoint(point)) return;

      const pointKey = voxelKey(point, this.settings.voxelSize);
      if (!this.voxels.has(pointKey) && this.points.length < this.settings.maximumPoints) {
        const stablePoint = {
          x: point.x,
          y: point.y,
          z: point.z,
          r: point.r ?? 118,
          g: point.g ?? 211,
          b: point.b ?? 255,
        };
        const index = this.points.length;
        this.voxels.set(pointKey, index);
        this.points.push(stablePoint);
        addedPoints.push({ point: stablePoint, index });
      }

      const markerKey = voxelKey(point, this.settings.markerVoxelSize);
      if (seenMarkerKeys.has(markerKey)) return;
      seenMarkerKeys.add(markerKey);

      let marker = this.markers.get(markerKey);
      if (!marker) {
        // Keep a small candidate buffer, but only confirmed markers receive a
        // render index. This prevents unconfirmed candidates from creating
        // gaps in InstancedMesh's contiguous draw range.
        if (this.markers.size >= this.settings.maximumMarkers * 2) return;
        marker = {
          index: null,
          count: 0,
          sumX: 0,
          sumY: 0,
          sumZ: 0,
          x: point.x,
          y: point.y,
          z: point.z,
          confirmed: false,
          frozen: false,
        };
        this.markers.set(markerKey, marker);
      }
      if (marker.frozen) return;

      marker.count += 1;
      marker.sumX += point.x;
      marker.sumY += point.y;
      marker.sumZ += point.z;
      const sampleCount = Math.min(marker.count, stabilizationFrames);
      marker.x = marker.sumX / sampleCount;
      marker.y = marker.sumY / sampleCount;
      marker.z = marker.sumZ / sampleCount;

      const markerPoint = { x: marker.x, y: marker.y, z: marker.z, index: marker.index };
      if (!marker.confirmed && marker.count >= confirmationFrames) {
        if (this.confirmedMarkerCount >= this.settings.maximumMarkers) {
          marker.frozen = true;
          return;
        }
        marker.confirmed = true;
        marker.index = this.confirmedMarkerCount;
        this.confirmedMarkerCount += 1;
        addedMarkers.push({ ...markerPoint, index: marker.index });
      } else if (marker.confirmed) {
        updatedMarkers.push(markerPoint);
      }
      if (marker.count >= stabilizationFrames) marker.frozen = true;
    });

    return {
      points: this.points,
      addedPoints,
      addedMarkers,
      updatedMarkers,
      pointCount: this.points.length,
      markerCount: this.confirmedMarkerCount,
    };
  }

  getPoints() {
    return this.points;
  }

  getMarkers() {
    return [...this.markers.values()]
      .filter((marker) => marker.confirmed)
      .map((marker) => ({ x: marker.x, y: marker.y, z: marker.z, index: marker.index }));
  }
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
    if (!isFinitePoint(point)) return;
    const key = voxelKey(point, settings.markerVoxelSize);
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
