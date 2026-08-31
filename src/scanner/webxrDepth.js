const DEFAULT_OPTIONS = Object.freeze({
  sampleGrid: 20,
  minimumDepth: 0.2,
  maximumDepth: 12,
  voxelSize: 0.05,
  maximumPoints: 180000,
  markerVoxelSize: 0.08,
  maximumMarkers: 6000,
  maximumStoredMarkers: 100000,
  markerConfirmationFrames: 1,
  markerStabilizationFrames: 8,
  markerMergeDistance: 0.11,
  pointMergeDistance: 0.065,
  markerMatchCellSize: 0.2,
  visibilityCellSize: 2,
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

function stableHash(value) {
  let hash = 2166136261;
  for (let index = 0; index < String(value).length; index += 1) {
    hash ^= String(value).charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function spatialCellKey(point, cellSize) {
  return [
    Math.floor(point.x / cellSize),
    Math.floor(point.y / cellSize),
    Math.floor(point.z / cellSize),
  ].join('|');
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
export function sampleDepthSurface(frame, pose, options = {}) {
  const settings = { ...DEFAULT_OPTIONS, ...options };
  const points = [];
  const view = pose?.views?.[0];
  const emptySurface = { points, gridPoints: [], gridSide: 0, step: 0, cameraPosition: { x: 0, y: 0, z: 0 } };
  if (!frame || !view || typeof frame.getDepthInformation !== 'function') return emptySurface;
  let depthInfo;
  try {
    depthInfo = frame.getDepthInformation(view);
  } catch {
    return emptySurface;
  }
  // XRView.transform places the view in the requested reference space. Its
  // inverse is the view matrix (world -> camera), which is the opposite of
  // what depth samples need here.
  const viewToWorld = view.transform?.matrix;
  const depthTransform = depthInfo?.transform?.matrix || viewToWorld;
  const projection = depthInfo?.projectionMatrix || view.projectionMatrix;
  if (!depthInfo || !depthTransform || !projection) return emptySurface;
  const readDepth = createDepthReader(depthInfo);
  if (!readDepth) return emptySurface;
  const step = Math.max(4, Math.round(settings.sampleGrid));
  const rowSize = step + 1;
  const depths = new Float32Array(rowSize * rowSize);
  const worldPoints = new Array(rowSize * rowSize);
  const phase = ((Math.trunc(settings.samplePhase || 0) % 4) + 4) % 4;
  const xOffset = phase === 1 || phase === 3 ? 0.45 : 0;
  const yOffset = phase === 2 || phase === 3 ? 0.45 : 0;
  const sampleCoordinate = (index, offset) => Math.min(1, Math.max(0, (index + offset) / step));

  // Read each depth sample once, then reuse it for point and normal
  // estimation. This keeps neighboring surface samples coherent without
  // multiplying calls into the device depth provider.
  for (let row = 0; row <= step; row += 1) {
    const y = sampleCoordinate(row, yOffset);
    for (let column = 0; column <= step; column += 1) {
      const x = sampleCoordinate(column, xOffset);
      const depth = readDepth(x, y);
      if (!Number.isFinite(depth) || depth < settings.minimumDepth || depth > settings.maximumDepth) continue;
      depths[row * rowSize + column] = depth;
    }
  }

  for (let row = 0; row <= step; row += 1) {
    const y = sampleCoordinate(row, yOffset);
    for (let column = 0; column <= step; column += 1) {
      const depth = depths[row * rowSize + column];
      if (!depth) continue;
      const x = sampleCoordinate(column, xOffset);
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
      const depth = depths[index];
      const rightIndex = row * rowSize + (column < step ? column + 1 : column - 1);
      const downIndex = (row < step ? row + 1 : row - 1) * rowSize + column;
      const right = worldPoints[rightIndex];
      const down = worldPoints[downIndex];
      let normal = null;
      const rightDepth = depths[rightIndex];
      const downDepth = depths[downIndex];
      const maxDepthJump = Math.max(0.08, Math.min(0.28, depth * 0.1));
      const rightGap = right ? Math.hypot(right.x - worldPoint.x, right.y - worldPoint.y, right.z - worldPoint.z) : Infinity;
      const downGap = down ? Math.hypot(down.x - worldPoint.x, down.y - worldPoint.y, down.z - worldPoint.z) : Infinity;
      if (right && down && rightDepth && downDepth
        && Math.abs(rightDepth - depth) <= maxDepthJump
        && Math.abs(downDepth - depth) <= maxDepthJump
        && rightGap <= 0.28 && downGap <= 0.28) {
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
  return {
    points,
    gridPoints: worldPoints,
    gridSide: rowSize,
    step,
    cameraPosition,
  };
}

export function sampleDepthPointCloud(frame, pose, options = {}) {
  return sampleDepthSurface(frame, pose, options).points;
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
    this.pointCells = new Map();
    this.pointRecords = [];
    this.markers = new Map();
    this.markerMatchCells = new Map();
    this.markerVisibilityCells = new Map();
    this.points = [];
    this.confirmedMarkerCount = 0;
    this.storageCapacityReached = false;
    this.pointCapacityReached = false;
    this.batchNumber = 0;
  }

  findNearest(cellMap, point, cellSize, maxDistance, normalThreshold = -1) {
    const centerX = Math.floor(point.x / cellSize);
    const centerY = Math.floor(point.y / cellSize);
    const centerZ = Math.floor(point.z / cellSize);
    const maxDistanceSquared = maxDistance * maxDistance;
    let nearest = null;
    let nearestDistance = maxDistanceSquared;
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
          const bucket = cellMap.get(`${centerX + offsetX}|${centerY + offsetY}|${centerZ + offsetZ}`);
          if (!bucket) continue;
          for (let candidateIndex = 0; candidateIndex < bucket.length; candidateIndex += 1) {
            const candidate = bucket[candidateIndex];
            const dx = candidate.x - point.x;
            const dy = candidate.y - point.y;
            const dz = candidate.z - point.z;
            const distanceSquared = dx * dx + dy * dy + dz * dz;
            if (distanceSquared >= nearestDistance) continue;
            if (normalThreshold >= 0
              && Number.isFinite(candidate.nx) && Number.isFinite(candidate.ny) && Number.isFinite(candidate.nz)
              && Number.isFinite(point.nx) && Number.isFinite(point.ny) && Number.isFinite(point.nz)
              && Math.hypot(candidate.nx, candidate.ny, candidate.nz) > 0.5
              && Math.hypot(point.nx, point.ny, point.nz) > 0.5) {
              const dot = candidate.nx * point.nx + candidate.ny * point.ny + candidate.nz * point.nz;
              if (dot < normalThreshold) continue;
            }
            nearest = candidate;
            nearestDistance = distanceSquared;
          }
        }
      }
    }
    return nearest;
  }

  addToCell(cellMap, point, cellSize, value) {
    const key = spatialCellKey(point, cellSize);
    const bucket = cellMap.get(key);
    if (bucket) bucket.push(value);
    else cellMap.set(key, [value]);
  }

  updatePoint(existing, point) {
    const current = this.points[existing.index];
    existing.observations += 1;
    // Use a quick average while a point is settling, then a slow running
    // average. This removes one-frame depth spikes without making revisits
    // visibly slide across the room.
    const alpha = existing.observations <= 8 ? 1 / existing.observations : 0.06;
    current.x += (point.x - current.x) * alpha;
    current.y += (point.y - current.y) * alpha;
    current.z += (point.z - current.z) * alpha;
    if (Number.isFinite(point.nx) && Number.isFinite(point.ny) && Number.isFinite(point.nz)) {
      const normal = normalizeVector(
        (current.nx || 0) * (1 - alpha) + point.nx * alpha,
        (current.ny || 0) * (1 - alpha) + point.ny * alpha,
        (current.nz || 0) * (1 - alpha) + point.nz * alpha,
      );
      if (normal) {
        current.nx = normal.x;
        current.ny = normal.y;
        current.nz = normal.z;
      }
    }
    existing.x = current.x;
    existing.y = current.y;
    existing.z = current.z;
    existing.nx = current.nx;
    existing.ny = current.ny;
    existing.nz = current.nz;
    existing.revision += 1;
    return current;
  }

  addPoints(nextPoints = []) {
    const addedPoints = [];
    const updatedPoints = [];
    const addedMarkers = [];
    const updatedMarkers = [];
    const seenMarkers = new Set();
    const confirmationFrames = Math.max(1, Math.round(this.settings.markerConfirmationFrames));
    this.batchNumber += 1;

    nextPoints.forEach((point) => {
      if (!isFinitePoint(point)) return;

      const existingPoint = this.findNearest(
        this.pointCells,
        point,
        this.settings.voxelSize,
        this.settings.pointMergeDistance,
        0.25,
      );
      if (existingPoint) {
        updatedPoints.push({ point: this.updatePoint(existingPoint, point), index: existingPoint.index });
      } else if (this.points.length < this.settings.maximumPoints) {
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
        const pointKey = voxelKey(stablePoint, this.settings.voxelSize);
        this.voxels.set(pointKey, index);
        this.points.push(stablePoint);
        const pointRecord = { index, x: stablePoint.x, y: stablePoint.y, z: stablePoint.z, nx: stablePoint.nx, ny: stablePoint.ny, nz: stablePoint.nz, observations: 1, revision: 1 };
        this.pointRecords.push(pointRecord);
        this.addToCell(this.pointCells, pointRecord, this.settings.voxelSize, pointRecord);
        addedPoints.push({ point: stablePoint, index });
      } else {
        this.pointCapacityReached = true;
      }

      let marker = this.findNearest(
        this.markerMatchCells,
        point,
        this.settings.markerMatchCellSize,
        this.settings.markerMergeDistance,
        0.35,
      );
      if (!marker) {
        if (this.markers.size >= this.settings.maximumStoredMarkers) {
          this.storageCapacityReached = true;
          return;
        }
        const markerKey = `${voxelKey(point, this.settings.markerVoxelSize)}:${this.markers.size}`;
        marker = {
          key: markerKey,
          index: null,
          observations: 0,
          confidence: 0,
          x: point.x,
          y: point.y,
          z: point.z,
          nx: point.nx ?? 0,
          ny: point.ny ?? 0,
          nz: point.nz ?? 0,
          confirmed: false,
          revision: 0,
          lastSeenBatch: 0,
        };
        this.markers.set(marker.key, marker);
        this.addToCell(this.markerMatchCells, marker, this.settings.markerMatchCellSize, marker);
        this.addToCell(this.markerVisibilityCells, marker, this.settings.visibilityCellSize, marker);
      }

      // A dense depth grid can hit one coarse surfel many times in one batch.
      // Count one observation per depth batch so confirmation represents time,
      // not the number of neighboring pixels in a single frame.
      if (seenMarkers.has(marker.key)) return;
      seenMarkers.add(marker.key);
      marker.observations += 1;
      marker.confidence = Math.min(1, marker.confidence + 0.22);
      const alpha = marker.observations <= 8 ? 1 / marker.observations : 0.06;
      marker.x += (point.x - marker.x) * alpha;
      marker.y += (point.y - marker.y) * alpha;
      marker.z += (point.z - marker.z) * alpha;
      if (Number.isFinite(point.nx) && Number.isFinite(point.ny) && Number.isFinite(point.nz)) {
        const normal = normalizeVector(
          marker.nx * (1 - alpha) + point.nx * alpha,
          marker.ny * (1 - alpha) + point.ny * alpha,
          marker.nz * (1 - alpha) + point.nz * alpha,
        );
        if (normal) {
          marker.nx = normal.x;
          marker.ny = normal.y;
          marker.nz = normal.z;
        }
      }
      marker.lastSeenBatch = this.batchNumber;
      marker.revision += 1;

      const markerPoint = {
        key: marker.key,
        x: marker.x,
        y: marker.y,
        z: marker.z,
        nx: marker.nx,
        ny: marker.ny,
        nz: marker.nz,
        index: marker.index,
        revision: marker.revision,
      };
      if (!marker.confirmed && marker.observations >= confirmationFrames) {
        marker.confirmed = true;
        marker.index = this.confirmedMarkerCount;
        this.confirmedMarkerCount += 1;
        addedMarkers.push({ ...markerPoint, index: marker.index });
      } else if (marker.confirmed) {
        updatedMarkers.push(markerPoint);
      }
    });

    return {
      points: this.points,
      addedPoints,
      updatedPoints,
      addedMarkers,
      updatedMarkers,
      pointCount: this.points.length,
      markerCount: this.confirmedMarkerCount,
      storageCapacityReached: this.storageCapacityReached || this.pointCapacityReached,
    };
  }

  getPoints() {
    return this.points;
  }

  getMarkers() {
    return [...this.markers.values()]
      .filter((marker) => marker.confirmed)
      .map((marker) => ({
        key: marker.key,
        x: marker.x,
        y: marker.y,
        z: marker.z,
        nx: marker.nx,
        ny: marker.ny,
        nz: marker.nz,
        index: marker.index,
        revision: marker.revision,
      }));
  }

  getVisibleMarkers(cameraPosition = {}, maximumMarkers = this.settings.maximumMarkers) {
    const cx = Number(cameraPosition.x) || 0;
    const cy = Number(cameraPosition.y) || 0;
    const cz = Number(cameraPosition.z) || 0;
    const radius = 14;
    const cellSize = this.settings.visibilityCellSize;
    const centerX = Math.floor(cx / cellSize);
    const centerY = Math.floor(cy / cellSize);
    const centerZ = Math.floor(cz / cellSize);
    const cellRadius = Math.ceil(radius / cellSize);
    const visible = [];
    const seen = new Set();
    for (let offsetX = -cellRadius; offsetX <= cellRadius; offsetX += 1) {
      for (let offsetY = -cellRadius; offsetY <= cellRadius; offsetY += 1) {
        for (let offsetZ = -cellRadius; offsetZ <= cellRadius; offsetZ += 1) {
          const bucket = this.markerVisibilityCells.get(`${centerX + offsetX}|${centerY + offsetY}|${centerZ + offsetZ}`);
          if (!bucket) continue;
          bucket.forEach((marker) => {
            if (!marker.confirmed || seen.has(marker.key)) return;
            seen.add(marker.key);
            const distanceSquared = (marker.x - cx) ** 2 + (marker.y - cy) ** 2 + (marker.z - cz) ** 2;
            if (distanceSquared <= radius * radius) visible.push({ marker, distanceSquared });
          });
        }
      }
    }
    if (visible.length > maximumMarkers) {
      // Nearest-first selection is deterministic for a stationary camera and
      // naturally prioritizes nearby detail as the user walks around.
      visible.sort((a, b) => a.distanceSquared - b.distanceSquared || stableHash(a.marker.key) - stableHash(b.marker.key));
      visible.length = maximumMarkers;
    }
    return visible.map(({ marker }) => ({
      key: marker.key,
      x: marker.x,
      y: marker.y,
      z: marker.z,
      nx: marker.nx,
      ny: marker.ny,
      nz: marker.nz,
      index: marker.index,
      revision: marker.revision,
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
