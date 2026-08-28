const endpoint = (process.env.REACT_APP_RECONSTRUCTION_API_URL || '').replace(/\/$/, '');

export function hasReconstructionEndpoint() {
  return Boolean(endpoint);
}

export function getReconstructionEndpoint() {
  return endpoint;
}

function requestJson(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
    },
  }).then(async (response) => {
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      throw new Error(body?.message || `Reconstruction service returned ${response.status}`);
    }
    return body || {};
  });
}

function uploadWithProgress(url, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', url);
    request.setRequestHeader('Content-Type', blob.type || 'video/mp4');
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
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
    const finish = (callback) => (value) => {
      signal?.removeEventListener('abort', abortUpload);
      callback(value);
    };
    request.onload = finish(request.onload);
    request.onerror = finish(request.onerror);
    request.onabort = finish(request.onabort);
    request.send(blob);
  });
}

export async function submitCapture({ blob, manifest, onProgress = () => {}, signal } = {}) {
  if (!endpoint) throw new Error('No reconstruction endpoint is configured.');
  if (!blob) throw new Error('There is no recorded capture to upload.');

  const upload = await requestJson(`${endpoint}/uploads`, {
    method: 'POST',
    body: JSON.stringify({
      filename: `polyscan-capture-${Date.now()}.${blob.type.includes('webm') ? 'webm' : 'mp4'}`,
      contentType: blob.type || 'video/mp4',
      size: blob.size,
      manifest,
    }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  });
  if (!upload.uploadUrl || !upload.captureId) throw new Error('The upload service returned an incomplete upload session.');

  await uploadWithProgress(upload.uploadUrl, blob, (percentage) => onProgress(Math.max(1, Math.min(92, percentage * 0.92))), signal);
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
    version: 1,
    source: 'polyscan-web',
    createdAt: new Date().toISOString(),
    frameCount: scanState.frameCount || 0,
    viewpointCount: keyframes.length,
    coverage: (scanState.directionalCoverage || []).map((cell) => ({
      id: cell.id,
      coverage: Number(cell.coverage || 0),
      status: cell.status || 'unknown',
    })),
    keyframes: keyframes.map((frame) => ({
      id: frame.id,
      timestamp: frame.timestamp,
      viewpoint: frame.viewpoint,
      featureCount: frame.featureCount,
      stableTrackCount: frame.stableTrackCount,
    })),
  };
}
