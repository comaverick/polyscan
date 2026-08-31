import { serializePointCloudToPly } from './webxrDepth';

const endpoint = (process.env.REACT_APP_RECONSTRUCTION_API_URL || '').replace(/\/$/, '');

export function hasReconstructionEndpoint() {
  return Boolean(endpoint);
}

export function getReconstructionEndpoint() {
  return endpoint;
}

export async function checkReconstructionService({ signal } = {}) {
  if (!endpoint) throw new Error('No reconstruction endpoint is configured.');
  let response;
  try {
    response = await fetch(`${endpoint}/health`, {
      headers: { Accept: 'application/json', 'bypass-tunnel-reminder': 'true' },
      signal,
    });
  } catch {
    throw new Error('The reconstruction PC cannot be reached. Start the reconstruction server and its tunnel, then try again.');
  }
  if (!response.ok) throw new Error(`The reconstruction service is unavailable (status ${response.status}). Start the PC server and tunnel, then try again.`);
  return response.json().catch(() => ({}));
}

function requestJson(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'bypass-tunnel-reminder': 'true',
      ...(options.headers || {}),
    },
  }).then(async (response) => {
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) throw new Error(body?.message || `Reconstruction service returned ${response.status}`);
    return body || {};
  });
}

function uploadWithProgress(url, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    request.setRequestHeader('bypass-tunnel-reminder', 'true');
    request.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : blob.size);
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error(`Capture upload returned ${request.status}`));
    };
    request.onerror = () => reject(new Error('The capture upload was interrupted.'));
    request.onabort = () => {
      const error = new Error('The capture upload was cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    const abortUpload = () => request.abort();
    signal?.addEventListener('abort', abortUpload, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', abortUpload);
    request.addEventListener('loadend', cleanup, { once: true });
    request.send(blob);
  });
}

export function buildCaptureAssets({ capture, keyframes = [], pointCloud = [], faces = [] } = {}) {
  const assets = [];
  if (capture?.blob) {
    const isWebm = String(capture.blob.type || '').includes('webm');
    assets.push({
      id: 'capture-video',
      kind: 'video',
      filename: `capture.${isWebm ? 'webm' : 'mp4'}`,
      contentType: capture.blob.type || 'video/mp4',
      blob: capture.blob,
    });
  }
  keyframes.forEach((frame, index) => {
    const blob = frame.capture?.blob;
    if (!blob) return;
    assets.push({
      id: `keyframe-${String(index + 1).padStart(4, '0')}`,
      kind: 'image',
      filename: `keyframe-${String(index + 1).padStart(4, '0')}.jpg`,
      contentType: blob.type || frame.capture.contentType || 'image/jpeg',
      blob,
      keyframeId: frame.id,
    });
  });
  if (pointCloud.length >= 100) {
    const hasMesh = Array.isArray(faces) && faces.length > 0;
    const ply = serializePointCloudToPly(pointCloud, { faces: hasMesh ? faces : [] });
    const blob = new Blob([ply], { type: 'application/octet-stream' });
    assets.push({
      id: 'depth-pointcloud',
      kind: hasMesh ? 'mesh' : 'pointcloud',
      filename: 'depth-scan.ply',
      contentType: 'application/octet-stream',
      blob,
    });
  }
  return assets;
}

async function uploadAssets(uploadSession, assets, onProgress, signal) {
  const uploadTargets = Array.isArray(uploadSession.uploads)
    ? uploadSession.uploads
    : uploadSession.uploadUrl && assets.length === 1
      ? [{ id: assets[0].id, uploadUrl: uploadSession.uploadUrl }]
      : [];
  if (!uploadTargets.length) throw new Error('The upload service returned an incomplete upload session.');

  const totalBytes = Math.max(1, assets.reduce((sum, asset) => sum + asset.blob.size, 0));
  const loadedById = new Map();
  const report = () => {
    const loaded = [...loadedById.values()].reduce((sum, value) => sum + value, 0);
    onProgress(Math.max(1, Math.min(92, Math.round((loaded / totalBytes) * 92))));
  };
  const queue = [...uploadTargets];
  const worker = async () => {
    while (queue.length) {
      const target = queue.shift();
      const asset = assets.find((candidate) => candidate.id === target.id) || (assets.length === 1 ? assets[0] : null);
      if (!asset || !target.uploadUrl) throw new Error('The upload service did not provide a target for every capture asset.');
      await uploadWithProgress(target.uploadUrl, asset.blob, (loaded) => {
        loadedById.set(asset.id, loaded);
        report();
      }, signal);
      loadedById.set(asset.id, asset.blob.size);
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
}

export async function submitCapture({ capture, keyframes = [], pointCloud = [], faces = [], manifest, onProgress = () => {}, signal } = {}) {
  if (!endpoint) throw new Error('No reconstruction endpoint is configured.');
  const assets = buildCaptureAssets({ capture, keyframes, pointCloud, faces });
  if (!assets.length) throw new Error('There are no room images, video, or measured depth points to upload.');

  const upload = await requestJson(`${endpoint}/uploads`, {
    method: 'POST',
    body: JSON.stringify({
      assets: assets.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        filename: asset.filename,
        contentType: asset.contentType,
        size: asset.blob.size,
        keyframeId: asset.keyframeId,
      })),
      manifest,
    }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  });
  if (!upload.captureId) throw new Error('The upload service did not return a capture id.');

  await uploadAssets(upload, assets, onProgress, signal);
  onProgress(94);
  const job = await requestJson(`${endpoint}/jobs`, {
    method: 'POST',
    body: JSON.stringify({ captureId: upload.captureId, manifest }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  });
  onProgress(100);
  return { ...job, captureId: upload.captureId };
}

export async function getReconstructionJob(jobId, { signal } = {}) {
  if (!endpoint || !jobId) throw new Error('A reconstruction job is required.');
  return requestJson(`${endpoint}/jobs/${encodeURIComponent(jobId)}`, { signal });
}

export function createCaptureManifest(scanState = {}, keyframes = []) {
  return {
    version: 2,
    source: 'polyscan-web-photogrammetry',
    createdAt: new Date().toISOString(),
    frameCount: scanState.frameCount || 0,
    viewpointCount: keyframes.length,
    imageCount: keyframes.filter((frame) => Boolean(frame.capture?.blob)).length,
    depthPointCount: Array.isArray(scanState.webXRPointCloud) ? scanState.webXRPointCloud.length : 0,
    depthFaceCount: Array.isArray(scanState.webXRMeshFaces) ? scanState.webXRMeshFaces.length : 0,
    depthMarkerCount: Number(scanState.webXRScanStats?.markerCount || 0),
    coverage: (scanState.directionalCoverage || []).map((cell) => ({
      id: cell.id,
      coverage: Number(cell.coverage || 0),
      status: cell.status || 'unknown',
    })),
    keyframes: keyframes.map((frame, index) => ({
      id: frame.id,
      filename: frame.capture?.blob ? `keyframe-${String(index + 1).padStart(4, '0')}.jpg` : null,
      timestamp: frame.timestamp,
      viewpoint: frame.viewpoint,
      featureCount: frame.featureCount,
      stableTrackCount: frame.stableTrackCount,
      width: frame.capture?.width || null,
      height: frame.capture?.height || null,
    })),
  };
}
