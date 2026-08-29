const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { runColmapPipeline } = require('./colmap-worker.cjs');

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, '');
const dataRoot = path.resolve(process.env.POLYSCAN_DATA_DIR || path.join(__dirname, 'data'));
const captureRoot = path.join(dataRoot, 'captures');
const jobRoot = path.join(dataRoot, 'jobs');
fs.mkdirSync(captureRoot, { recursive: true });
fs.mkdirSync(jobRoot, { recursive: true });

const jobs = new Map();
const captures = new Map();

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  });
  response.end(body);
}

function safeName(value, fallback) {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return cleaned || fallback;
}

function readJson(request, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body is too large.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Request body must be valid JSON.')); }
    });
    request.on('error', reject);
  });
}

function streamFile(response, filename) {
  if (!fs.existsSync(filename)) {
    sendJson(response, 404, { message: 'Model file not found.' });
    return;
  }
  const stat = fs.statSync(filename);
  response.writeHead(200, {
    'Content-Type': filename.endsWith('.ply') ? 'application/octet-stream' : 'model/gltf-binary',
    'Content-Length': stat.size,
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
  });
  fs.createReadStream(filename).pipe(response);
}

async function startJob(job, capture) {
  job.status = 'processing';
  job.progress = 1;
  job.message = 'Preparing reconstruction';
  try {
    const result = await runColmapPipeline({
      captureDirectory: capture.directory,
      assets: capture.assets,
      workspace: job.directory,
      onProgress: (progress, message) => {
        job.progress = progress;
        job.message = message;
      },
    });
    job.status = 'complete';
    job.progress = 100;
    job.message = 'Room ready';
    job.output = {
      modelUrl: `${publicBaseUrl}/models/${job.id}/room.ply`,
      modelFormat: result.format,
      modelKind: result.kind,
      coordinateSystem: 'colmap-camera',
      imageCount: result.imageCount,
    };
  } catch (error) {
    job.status = 'failed';
    job.progress = 0;
    job.message = error.message || 'Reconstruction failed.';
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, publicBaseUrl);
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Headers': 'Content-Type, bypass-tunnel-reminder',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    });
    response.end();
    return;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true, service: 'polyscan-reconstruction' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/uploads') {
      const body = await readJson(request);
      const inputAssets = Array.isArray(body.assets) && body.assets.length
        ? body.assets
        : [{ id: 'video', kind: 'video', filename: body.filename, contentType: body.contentType, size: body.size }];
      const captureId = crypto.randomUUID();
      const directory = path.join(captureRoot, captureId);
      fs.mkdirSync(directory, { recursive: true });
      const assets = inputAssets.map((asset, index) => {
        const id = safeName(asset.id, `asset-${index + 1}`);
        const filename = safeName(asset.filename, `${id}.bin`);
        return { ...asset, id, filename, storedName: `${id}-${filename}` };
      });
      captures.set(captureId, { id: captureId, directory, assets, manifest: body.manifest || {} });
      sendJson(response, 200, {
        captureId,
        uploads: assets.map((asset) => ({
          id: asset.id,
          uploadUrl: `${publicBaseUrl}/uploads/${captureId}/${encodeURIComponent(asset.id)}`,
        })),
      });
      return;
    }

    const uploadMatch = url.pathname.match(/^\/uploads\/([^/]+)\/([^/]+)$/);
    if (request.method === 'PUT' && uploadMatch) {
      const capture = captures.get(uploadMatch[1]);
      const asset = capture?.assets.find((candidate) => candidate.id === decodeURIComponent(uploadMatch[2]));
      if (!capture || !asset) {
        sendJson(response, 404, { message: 'Upload session not found.' });
        return;
      }
      const filename = path.join(capture.directory, asset.storedName);
      const file = fs.createWriteStream(filename, { flags: 'w' });
      request.pipe(file);
      file.on('finish', () => sendJson(response, 200, { ok: true }));
      file.on('error', () => sendJson(response, 500, { message: 'Could not save the capture asset.' }));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/jobs') {
      const body = await readJson(request);
      const capture = captures.get(body.captureId);
      if (!capture) {
        sendJson(response, 404, { message: 'Capture not found.' });
        return;
      }
      const id = crypto.randomUUID();
      const job = { id, captureId: capture.id, directory: path.join(jobRoot, id), status: 'queued', progress: 0, message: 'Queued' };
      jobs.set(id, job);
      sendJson(response, 202, { id, status: job.status, progress: job.progress });
      setImmediate(() => startJob(job, capture));
      return;
    }

    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
    if (request.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(response, 404, { message: 'Reconstruction job not found.' });
        return;
      }
      sendJson(response, 200, {
        id: job.id,
        status: job.status,
        progress: job.progress,
        message: job.message,
        output: job.output,
      });
      return;
    }

    const modelMatch = url.pathname.match(/^\/models\/([^/]+)\/room\.(ply|glb)$/);
    if (request.method === 'GET' && modelMatch) {
      const job = jobs.get(modelMatch[1]);
      streamFile(response, path.join(job?.directory || '', `room.${modelMatch[2]}`));
      return;
    }

    sendJson(response, 404, { message: 'Route not found.' });
  } catch (error) {
    sendJson(response, 400, { message: error.message || 'Request failed.' });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`PolyScan reconstruction service listening on ${publicBaseUrl}\n`);
});
