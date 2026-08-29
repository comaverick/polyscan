# PolyScan

PolyScan is a mobile-web room capture interface backed by real photogrammetry. The phone records overlapping, full-size image keyframes and an optional video. A reconstruction worker turns those assets into a room mesh, and the React app opens the result in a touch-first first-person viewer.

The blue camera layer is capture guidance only. It is not depth data and it is not the reconstructed room.

## Run the web app

```powershell
npm install
npm start
```

Live camera capture requires HTTPS when opened from a phone. For desktop interface testing, open `http://localhost:3000/?mobilePreview=1`.

## Reconstruction architecture

```text
Mobile camera
  -> full-size JPEG keyframes and optional video
  -> reconstruction upload service
  -> COLMAP Structure-from-Motion and Multi-View Stereo
  -> PLY room mesh
  -> in-app Three.js first-person viewer
```

PolyScan does not manufacture local geometry if reconstruction fails. A completed job must return one of:

```json
{
  "modelUrl": "https://models.example.com/room.glb",
  "modelFormat": "glb",
  "modelKind": "mesh"
}
```

or:

```json
{
  "modelUrl": "https://models.example.com/room.ply",
  "modelFormat": "ply",
  "modelKind": "mesh",
  "coordinateSystem": "colmap-camera"
}
```

For camera-only models without a known measurement, the viewer estimates a comfortable room scale from the vertical extent. Return `metricScale` when the processing pipeline has a real unit conversion.

An existing hosted viewer can still be returned as `{ "viewerUrl": "https://..." }`.

## Run the reconstruction service

The repository includes a local service in `server/reconstruction-server.cjs`. It accepts image/video assets, queues a job, runs COLMAP, and serves the generated PLY mesh.

Requirements:

- COLMAP available as `colmap`, or set `COLMAP_PATH`
- An NVIDIA GPU is strongly recommended
- FFmpeg is required only when reconstructing an imported video without enough saved image keyframes
- At least 12 overlapping images; 40 or more is recommended for a room

Copy `.env.example` to `.env` for the local reconstruction worker. The worker loads this file automatically at startup. The React build only exposes variables beginning with `REACT_APP_`.

```powershell
$env:REACT_APP_RECONSTRUCTION_API_URL='http://127.0.0.1:8787'
npm run reconstruction-server
```

In a second terminal:

```powershell
npm start
```

For a Vercel deployment using a temporary tunnel, set `PUBLIC_BASE_URL` in the PC `.env` to the tunnel URL and set the same URL as Vercel's `REACT_APP_RECONSTRUCTION_API_URL` environment variable. Keep that `REACT_APP_` prefix: this URL must be available to the phone browser. Restart the worker after changing `.env`, and keep the tunnel running while scanning.

For a phone on the same network, `PUBLIC_BASE_URL` and `REACT_APP_RECONSTRUCTION_API_URL` must use the computer's reachable HTTPS address, not `127.0.0.1`.

## Reconstruction API

### `POST /uploads`

Accepts a manifest and an asset list. It returns a capture ID and one upload URL per asset.

### `PUT /uploads/:captureId/:assetId`

Receives an image or video directly.

### `POST /jobs`

Accepts `{ "captureId": "...", "manifest": {} }` and returns a queued job.

### `GET /jobs/:jobId`

Returns job status, progress, a message, and the final output.

## Capture guidance

- Walk around the room instead of rotating from one position.
- Keep 60-80% overlap between views.
- Move slowly to avoid motion blur.
- Keep corners, picture frames, furniture edges, and other textured details visible.
- Plain walls, mirrors, windows, and shiny surfaces are difficult for camera-only reconstruction.
- Include a known measurement if metric scale matters.

## Scripts

- `npm start`: start the React development server
- `npm test -- --watchAll=false`: run tests once
- `npm run build`: create a production build
- `npm run reconstruction-server`: start the local reconstruction API and COLMAP worker
