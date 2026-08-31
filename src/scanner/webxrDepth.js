const DEFAULT_OPTIONS = Object.freeze({
  sampleGrid: 20,
  minimumDepth: 0.2,
  maximumDepth: 12,
  voxelSize: 0.04,
  maximumPoints: 180000,
  markerVoxelSize: 0.08,
  maximumMarkers: 6000,
  maximumStoredMarkers: 100000,
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

function normalizeVector(x, y, z) {
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < 0.000001) return null;
  return { x: x / length, y: y / length, z: z / length };
}

function transformNormalizedDepthCoordinates(matrix, x, y) {
  if (!matrix || matrix.length < 16) return { x, y };
  const w = matrix[3] * x + matrix[7] * y + matrix[15];
  if (Math.abs(w) < 0.000001) return { x, y };
  return {
    x: (matrix[0] * x + matrix[4] * y + matrix[12]) / w,
    y: (matrix[1] * x + matrix[5] * y + matrix[13]) / w,
  };
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
      depthTypeRequest: ['smooth', 'raw'],
      matchDepthView: true,
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
  const uvTransform = depthInfo.normDepthBufferFromNormView?.matrix;
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
    const normalized = transformNormalizedDepthCoordinates(uvTransform, x, y);
    const column = Math.max(0, Math.min(width - 1, Math.trunc(normalized.x * width)));
    const row = Math.max(0, Math.min(height - 1, Math.trunc(normalized.y * height)));
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
  const depthTransform = depthInfo?.transform?.matrix || viewToWorld;
  const projection = depthInfo?.projectionMatrix || view.projectionMatrix;
  if (!depthInfo || !depthTransform || !projection) return points;
  const readDepth = createDepthReader(depthInfo);
  if (!readDepth) return points;
  const step = Math.max(4, Math.round(settings.sampleGrid));
  const rowSize = step + 1;
  const depths = new Float32Array(rowSize * rowSize);
  const worldPoints = new Array(rowSize * rowSize);

  // Read each depth sample once, then reuse it for point and normal
  // estimation. This keeps neighboring surface samples coherent without
  // multiplying calls into the device depth provider.
  for (let row = 0; row <= step; row += 1) {
    const y = row / step;
    for (let column = 0; column <= step; column += 1) {
      const x = column / step;
      const depth = readDepth(x, y);
      if (!Number.isFinite(depth) || depth < settings.minimumDepth || depth > settings.maximumDepth) continue;
      depths[row * rowSize + column] = depth;
    }
  }

  for (let row = 0; row <= step; row += 1) {
    const y = row / step;
    for (let column = 0; column <= step; column += 1) {
      const depth = depths[row * rowSize + column];
      if (!depth) continue;
      const x = column / step;
      // WebXR projection matrices are column-major. Depth is measured along
      // the view's optical axis, so unproject the normalized sample at -depth.
      // For a perspective matrix, NDC = -(focal * viewCoordinate / z) -
      // projectionOffset. Substituting z = -depth gives the expressions below.
      const viewPoint = {
        x: ((x * 2 - 1 + projection[8]) / projection[0]) * depth,
        y: ((1 - y * 2 + projection[9]) / projection[5]) * depth,
        z: -depth,
      };
      const index = row * rowSize + column;
      worldPoints[index] = transformPoint(depthTransform, viewPoint);
    }
  }

  const cameraPosition = {
    x: depthTransform[12] || 0,
    y: depthTransform[13] || 0,
    z: depthTransform[14] || 0,
  };
  for (let row = 0; row <= step; row += 1) {
    for (let column = 0; column <= step; column += 1) {
      const index = row * rowSize + column;
      const worldPoint = worldPoints[index];
      if (!worldPoint) continue;
      const rightIndex = row * rowSize + (column < step ? column + 1 : column - 1);
      const downIndex = (row < step ? row + 1 : row - 1) * rowSize + column;
      const right = worldPoints[rightIndex];
      const down = worldPoints[downIndex];
      let normal = null;
      if (right && down && Math.hypot(right.x - worldPoint.x, right.y - worldPoint.y, right.z - worldPoint.z) < 0.65
        && Math.hypot(down.x - worldPoint.x, down.y - worldPoint.y, down.z - worldPoint.z) < 0.65) {
        const edgeX = { x: right.x - worldPoint.x, y: right.y - worldPoint.y, z: right.z - worldPoint.z };
        const edgeY = { x: down.x - worldPoint.x, y: down.y - worldPoint.y, z: down.z - worldPoint.z };
        normal = normalizeVector(
          edgeX.y * edgeY.z - edgeX.z * edgeY.y,
          edgeX.z * edgeY.x - edgeX.x * edgeY.z,
          edgeX.x * edgeY.y - edgeX.y * edgeY.x,
        );
        if (normal) {
          const toCamera = {
            x: cameraPosition.x - worldPoint.x,
            y: cameraPosition.y - worldPoint.y,
            z: cameraPosition.z - worldPoint.z,
          };
          if (normal.x * toCamera.x + normal.y * toCamera.y + normal.z * toCamera.z < 0) {
            normal = { x: -normal.x, y: -normal.y, z: -normal.z };
          }
        }
      }
      points.push({
        ...worldPoint,
        ...(normal ? { nx: normal.x, ny: normal.y, nz: normal.z } : {}),
        r: 118,
        g: 211,
        b: 255,
      });
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
    this.storageCapacityReached = false;
    this.renderCursor = 0;
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
          nx: point.nx,
          ny: point.ny,
          nz: point.nz,
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
        if (this.markers.size >= this.settings.maximumStoredMarkers) {
          this.storageCapacityReached = true;
          return;
        }
        marker = {
          index: null,
          count: 0,
          sumX: 0,
          sumY: 0,
          sumZ: 0,
          sumNX: 0,
          sumNY: 0,
          sumNZ: 0,
          x: point.x,
          y: point.y,
          z: point.z,
          nx: point.nx ?? 0,
          ny: point.ny ?? 0,
          nz: point.nz ?? 0,
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
      if (Number.isFinite(point.nx) && Number.isFinite(point.ny) && Number.isFinite(point.nz)) {
        marker.sumNX += point.nx;
        marker.sumNY += point.ny;
        marker.sumNZ += point.nz;
      }
      const sampleCount = Math.min(marker.count, stabilizationFrames);
      marker.x = marker.sumX / sampleCount;
      marker.y = marker.sumY / sampleCount;
      marker.z = marker.sumZ / sampleCount;
      const normal = normalizeVector(marker.sumNX, marker.sumNY, marker.sumNZ);
      if (normal) {
        marker.nx = normal.x;
        marker.ny = normal.y;
        marker.nz = normal.z;
      }

      const markerPoint = {
        x: marker.x,
        y: marker.y,
        z: marker.z,
        nx: marker.nx,
        ny: marker.ny,
        nz: marker.nz,
        index: marker.index,
      };
      if (!marker.confirmed && marker.count >= confirmationFrames) {
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
      storageCapacityReached: this.storageCapacityReached,
    };
  }

  getPoints() {
    return this.points;
  }

  getMarkers() {
    return [...this.markers.values()]
      .filter((marker) => marker.confirmed)
      .map((marker) => ({
        x: marker.x,
        y: marker.y,
        z: marker.z,
        nx: marker.nx,
        ny: marker.ny,
        nz: marker.nz,
        index: marker.index,
      }));
  }

  getVisibleMarkers(cameraPosition = {}, maximumMarkers = this.settings.maximumMarkers) {
    const cx = Number(cameraPosition.x) || 0;
    const cy = Number(cameraPosition.y) || 0;
    const cz = Number(cameraPosition.z) || 0;
    const visible = [];
    for (const marker of this.markers.values()) {
      if (!marker.confirmed) continue;
      const distanceSquared = (marker.x - cx) ** 2 + (marker.y - cy) ** 2 + (marker.z - cz) ** 2;
      // A room-scale radius keeps far-away history out of the mobile draw
      // list while the full marker map remains available for revisits.
      if (distanceSquared <= 14 * 14) visible.push(marker);
    }
    if (visible.length <= maximumMarkers) {
      return visible.map((marker) => ({
        x: marker.x,
        y: marker.y,
        z: marker.z,
        nx: marker.nx,
        ny: marker.ny,
        nz: marker.nz,
      }));
    }
    // A rotating stride gives new and old parts of a large room a chance to
    // render without sorting tens of thousands of markers every depth batch.
    const stride = Math.ceil(visible.length / maximumMarkers);
    const offset = this.renderCursor % stride;
    this.renderCursor += 1;
    return visible
      .filter((_, index) => index % stride === offset)
      .slice(0, maximumMarkers)
      .map((marker) => ({
        x: marker.x,
        y: marker.y,
        z: marker.z,
        nx: marker.nx,
        ny: marker.ny,
        nz: marker.nz,
      }));
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
  const hasNormals = validPoints.some((point) => Number.isFinite(point?.nx) && Number.isFinite(point?.ny) && Number.isFinite(point?.nz));
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
    ...(hasNormals ? ['property float nx', 'property float ny', 'property float nz'] : []),
    'end_header',
  ].join('\n');
  const rows = validPoints.map((point) => {
    const values = [point.x.toFixed(5), point.y.toFixed(5), point.z.toFixed(5), Math.round(point.r ?? 118), Math.round(point.g ?? 211), Math.round(point.b ?? 255)];
    if (hasNormals) values.push(
      Number.isFinite(point.nx) ? point.nx.toFixed(5) : '0',
      Number.isFinite(point.ny) ? point.ny.toFixed(5) : '0',
      Number.isFinite(point.nz) ? point.nz.toFixed(5) : '0',
    );
    return values.join(' ');
  });
  return `${header}\n${rows.join('\n')}\n`;
}

export { DEFAULT_OPTIONS as WEBXR_DEPTH_OPTIONS };
