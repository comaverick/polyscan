import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { APP_VERSION } from './appVersion';
import {
  DEFAULT_VIEWPOINT_THRESHOLDS,
  createDirectionalCoverage,
  getVisibleCellIds,
  hasCompleteRoomCoverage,
  isReconstructionViable,
  selectBestKeyframes,
  updateDirectionalCoverage,
} from './scanner/coverageModel';
import {
  buildFrameEvidence,
  extractFrameFeatures,
  updateFeatureTracks,
} from './scanner/featureTracking';
import {
  appendSurfaceAnchor,
  createSurfaceAnchor,
  localizeSurfaceAnchors,
} from './scanner/surfaceAnchors';
import {
  grayscaleFromImageData,
  trackSurfaceStickerGroups,
} from './scanner/surfaceFlow';
import {
  createVisionFrame,
  loadVisionRuntime,
  trackPointsWithVision,
} from './scanner/visionRuntime';
import { getScanCoachAdvice } from './scanner/scanCoach';
import {
  captureVideoKeyframe,
  countCapturedKeyframes,
  resolveKeyframeAssets,
} from './scanner/keyframeCapture';
import {
  checkReconstructionService,
  createCaptureManifest,
  getReconstructionJob,
  hasReconstructionEndpoint,
  submitCapture,
} from './scanner/reconstructionClient';
import RoomModelViewer from './viewer/RoomModelViewer';

const CAPTURE_INTERVAL_MS = 520;
const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 240;
const MAX_SURFACE_ANCHORS = 56;
const SURFACE_LOCK_OPTIONS = Object.freeze({
  minimumTransformConfidence: 0.5,
  minimumInliers: 5,
  inlierThreshold: 0.04,
});

function getReconstructionViewerUrl(result) {
  const value = result?.viewerUrl || result?.viewer?.url;
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function getReconstructionModelAsset(result) {
  const value = result?.modelUrl || result?.model?.url || result?.glbUrl || result?.plyUrl;
  if (!value) return null;
  try {
    const url = new URL(value, window.location.href);
    if (!['http:', 'https:', 'blob:'].includes(url.protocol)) return null;
    return {
      url: url.href,
      format: result?.modelFormat || result?.model?.format || (result?.plyUrl ? 'ply' : undefined),
      kind: result?.modelKind || result?.model?.kind || 'mesh',
      pointSize: result?.pointSize || result?.model?.pointSize,
      coordinateSystem: result?.coordinateSystem || result?.model?.coordinateSystem,
      metricScale: result?.metricScale || result?.model?.metricScale,
    };
  } catch {
    return null;
  }
}

function isMobileScanDevice() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const previewOverride = process.env.NODE_ENV !== 'production'
    && new URLSearchParams(window.location.search).get('mobilePreview') === '1';
  const mobileUserAgent = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  const iPadDesktopMode = /Macintosh/i.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1;
  return previewOverride || mobileUserAgent || iPadDesktopMode;
}

function isCameraScanDevice() {
  if (isMobileScanDevice()) return true;
  // Keep the scanner usable on a desktop browser with a webcam. This is also
  // useful for development because the same camera code path can be exercised
  // without pretending a desktop has phone motion sensors.
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

const createEmptyScanState = () => ({
  directionalCoverage: createDirectionalCoverage(),
  cameraKeyframes: [],
  featureTracks: [],
  distinctViewpoints: 0,
  meaningfulCameraMotion: false,
  stableFeatures: [],
  surfaceAnchors: [],
  visibleSurfaceStickers: [],
  visibleSurfacePatches: [],
  visibleSurfaceAnchorCount: 0,
  lastFrame: null,
  lastViewpoint: null,
  lastEvidence: null,
  frameCount: 0,
});

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">P</span>;
}

function Wordmark({ compact = false }) {
  return (
    <div className={`wordmark${compact ? ' wordmark-compact' : ''}`}>
      <BrandMark />
      <span>PolyScan</span>
    </div>
  );
}

function VersionBadge({ className = '' }) {
  return <span className={`app-version ${className}`.trim()} aria-label={`PolyScan version ${APP_VERSION}`}>v{APP_VERSION}</span>;
}

function CameraPlaceholder() {
  return (
    <div className="camera-placeholder" aria-hidden="true">
      <div className="placeholder-ceiling" />
      <div className="placeholder-wall placeholder-wall-left" />
      <div className="placeholder-wall placeholder-wall-back" />
      <div className="placeholder-wall placeholder-wall-right" />
      <div className="placeholder-floor" />
      <div className="placeholder-window" />
      <div className="placeholder-console" />
      <div className="placeholder-console-top" />
      <div className="placeholder-light" />
    </div>
  );
}

function shiftTrackedPatches(patches, previousStickers, nextStickers) {
  if (!patches.length || !previousStickers.length || !nextStickers.length) return patches;
  const previousById = new Map(previousStickers.map((point) => [point.id, point]));
  const shifts = new Map();
  nextStickers.forEach((point) => {
    if (point.trackable === false) return;
    const previous = previousById.get(point.id);
    if (!previous) return;
    const key = point.anchorId || 'active-surface';
    shifts.set(key, [...(shifts.get(key) || []), { x: point.x - previous.x, y: point.y - previous.y }]);
  });
  const median = (values) => {
    const ordered = [...values].sort((first, second) => first - second);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  };
  return patches.map((patch) => {
    const motion = shifts.get(patch.id) || shifts.get(patch.anchorId);
    if (!motion || motion.length < 2) return patch;
    const dx = median(motion.map((point) => point.x));
    const dy = median(motion.map((point) => point.y));
    return {
      ...patch,
      vertices: patch.vertices.map((vertex) => ({ x: vertex.x + dx, y: vertex.y + dy })),
    };
  });
}

function SurfaceStickerCanvas({ stickers, patches = [], videoRef }) {
  const canvasRef = useRef(null);
  const activeStickersRef = useRef([]);
  const activePatchesRef = useRef([]);
  const lastExternalLockRef = useRef(0);

  useEffect(() => {
    if (!stickers.length) {
      activeStickersRef.current = [];
      return;
    }
    const activeById = new Map(activeStickersRef.current.map((sticker) => [sticker.id, sticker]));
    activeStickersRef.current = stickers.map((sticker) => {
      const active = activeById.get(sticker.id);
      if (!active || Math.hypot(active.x - sticker.x, active.y - sticker.y) > 0.13) return sticker;
      return {
        ...sticker,
        // Optical flow is the frame-to-frame lock. The descriptor relock is
        // only a correction, so a noisy match cannot yank a marker across the
        // wall on every analysis tick.
        x: active.x * 0.82 + sticker.x * 0.18,
        y: active.y * 0.82 + sticker.y * 0.18,
        confidence: Math.max(active.confidence || 0, sticker.confidence || 0),
      };
    });
    lastExternalLockRef.current = performance.now();
  }, [stickers]);

  useEffect(() => {
    if (!patches.length) {
      activePatchesRef.current = [];
      return;
    }
    const activeById = new Map(activePatchesRef.current.map((patch) => [patch.id, patch]));
    activePatchesRef.current = patches.map((patch) => {
      const active = activeById.get(patch.id);
      if (!active || active.vertices.length !== patch.vertices.length) return patch;
      return {
        ...patch,
        vertices: patch.vertices.map((vertex, index) => ({
          x: active.vertices[index].x * 0.82 + vertex.x * 0.18,
          y: active.vertices[index].y * 0.82 + vertex.y * 0.18,
        })),
        confidence: Math.max(active.confidence || 0, patch.confidence || 0),
      };
    });
    lastExternalLockRef.current = performance.now();
  }, [patches]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    const trackedVideo = videoRef?.current;
    const trackingCanvas = document.createElement('canvas');
    const trackingWidth = 192;
    const trackingHeight = 144;
    trackingCanvas.width = trackingWidth;
    trackingCanvas.height = trackingHeight;
    const trackingContext = trackingCanvas.getContext('2d', { willReadFrequently: true });
    let previousGray = null;
    let lastProcessedAt = 0;
    let lastGoodFlowAt = performance.now();
    let animationHandle = null;
    let videoFrameHandle = null;
    let cancelled = false;
    let vision = null;
    let previousVisionFrame = null;
    loadVisionRuntime().then((runtime) => {
      if (!cancelled) vision = runtime;
    }).catch(() => {
      // The lightweight fallback remains available if WebAssembly cannot load.
    });

    const draw = (visibleStickers = activeStickersRef.current) => {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      const renderWidth = Math.round(width * pixelRatio);
      const renderHeight = Math.round(height * pixelRatio);
      if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
        canvas.width = renderWidth;
        canvas.height = renderHeight;
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const video = trackedVideo;
      const sourceWidth = video?.videoWidth || width;
      const sourceHeight = video?.videoHeight || height;
      const coverScale = Math.max(width / sourceWidth, height / sourceHeight);
      const drawnWidth = sourceWidth * coverScale;
      const drawnHeight = sourceHeight * coverScale;
      const cropX = (width - drawnWidth) / 2;
      const cropY = (height - drawnHeight) / 2;
      const projectPoint = (point) => ({
        x: cropX + point.x * drawnWidth,
        y: cropY + point.y * drawnHeight,
      });

      const projectedPatches = activePatchesRef.current
        .map((patch) => patch.vertices.map(projectPoint))
        .filter((vertices) => vertices.length >= 4 && vertices.every((point) => (
          Number.isFinite(point.x) && Number.isFinite(point.y)
        )));

      // The filled region is the scan result: unscanned camera pixels remain
      // natural, while this surface-tied blue mask returns when the same wall
      // is recognized again.
      context.save();
      context.fillStyle = 'rgba(64, 145, 255, .34)';
      context.strokeStyle = 'rgba(196, 231, 255, .52)';
      context.lineWidth = 1;
      projectedPatches.forEach((vertices) => {
        context.beginPath();
        context.moveTo(vertices[0].x, vertices[0].y);
        vertices.slice(1).forEach((point) => context.lineTo(point.x, point.y));
        context.closePath();
        context.fill();
        context.stroke();
      });
      context.restore();

      if (!visibleStickers.length) return;

      // Small blue squares remain as precise lock guides on top of the broad
      // surface mask, making it easy to see what is driving the attachment.
      context.save();
      context.lineWidth = 1;
      visibleStickers.forEach((sticker) => {
        const point = projectPoint(sticker);
        const side = Math.max(8, Math.min(16, sticker.radius * Math.min(drawnWidth, drawnHeight) * 0.42));
        const isCoverage = sticker.kind === 'surface-coverage';
        context.fillStyle = isCoverage ? 'rgba(64, 145, 255, .3)' : 'rgba(64, 145, 255, .56)';
        context.strokeStyle = isCoverage ? 'rgba(196, 231, 255, .54)' : 'rgba(196, 231, 255, .88)';
        context.fillRect(point.x - side / 2, point.y - side / 2, side, side);
        context.strokeRect(point.x - side / 2, point.y - side / 2, side, side);
      });
      context.restore();
    };

    const processFrame = (timestamp) => {
      if (cancelled) return;
      const video = trackedVideo;
      if (trackingContext && video?.readyState >= 2 && timestamp - lastProcessedAt >= 66) {
        lastProcessedAt = timestamp;
        try {
          trackingContext.drawImage(video, 0, 0, trackingWidth, trackingHeight);
          const imageData = trackingContext.getImageData(0, 0, trackingWidth, trackingHeight);
          const currentGray = grayscaleFromImageData(imageData);
          let acceptCurrentReference = true;
          if (vision) {
            if (previousVisionFrame && activeStickersRef.current.length) {
              const flow = trackPointsWithVision(
                vision,
                previousVisionFrame,
                imageData,
                trackingWidth,
                trackingHeight,
                activeStickersRef.current,
              );
              if (flow?.points.length >= 3) {
                activePatchesRef.current = shiftTrackedPatches(
                  activePatchesRef.current,
                  activeStickersRef.current,
                  flow.points,
                );
                previousVisionFrame.delete();
                previousVisionFrame = flow.currentGray;
                activeStickersRef.current = flow.points;
                lastGoodFlowAt = timestamp;
              } else {
                flow?.currentGray?.delete();
                if (timestamp - Math.max(lastGoodFlowAt, lastExternalLockRef.current) > 650) {
                  activeStickersRef.current = [];
                  activePatchesRef.current = [];
                }
              }
            } else {
              previousVisionFrame?.delete();
              previousVisionFrame = createVisionFrame(vision, imageData);
            }
          } else if (previousGray && activeStickersRef.current.length) {
            const flow = trackSurfaceStickerGroups(
              previousGray,
              currentGray,
              trackingWidth,
              trackingHeight,
              activeStickersRef.current,
            );
            if (flow.trackedCount >= 3 && flow.confidence >= 0.66) {
              activePatchesRef.current = shiftTrackedPatches(
                activePatchesRef.current,
                activeStickersRef.current,
                flow.stickers,
              );
              activeStickersRef.current = flow.stickers;
              lastGoodFlowAt = timestamp;
            } else if (timestamp - Math.max(lastGoodFlowAt, lastExternalLockRef.current) > 650) {
              activeStickersRef.current = [];
              activePatchesRef.current = [];
            } else {
              // Keep the last sharp reference through a brief blur or autofocus
              // pulse so the next good frame can recover the same surface.
              acceptCurrentReference = false;
            }
          }
          if (acceptCurrentReference) previousGray = currentGray;
        } catch {
          previousGray = null;
          previousVisionFrame?.delete();
          previousVisionFrame = null;
          activeStickersRef.current = [];
          activePatchesRef.current = [];
        }
      }
      draw();
      if (video?.requestVideoFrameCallback) {
        videoFrameHandle = video.requestVideoFrameCallback(processFrame);
      } else {
        animationHandle = window.requestAnimationFrame(processFrame);
      }
    };

    draw();
    const handleResize = () => draw();
    const resizeObserver = window.ResizeObserver ? new ResizeObserver(handleResize) : null;
    resizeObserver?.observe(canvas);
    window.addEventListener('resize', handleResize);
    processFrame(performance.now());
    return () => {
      cancelled = true;
      if (animationHandle != null) window.cancelAnimationFrame(animationHandle);
      if (videoFrameHandle != null && trackedVideo?.cancelVideoFrameCallback) trackedVideo.cancelVideoFrameCallback(videoFrameHandle);
      previousVisionFrame?.delete();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleResize);
    };
  }, [videoRef]);

  return (
    <canvas
      ref={canvasRef}
      className="capture-mesh-canvas surface-sticker-canvas"
      data-mesh-patches={patches.length}
      data-surface-patches={patches.length}
      data-surface-stickers={stickers.length}
      aria-hidden="true"
    />
  );
}

function Icon({ name, size = 18 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  };
  const paths = {
    back: <><path d="m15 5-7 7 7 7" /><path d="M8 12h11" /></>,
    close: <><path d="m7 7 10 10" /><path d="m17 7-10 10" /></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    share: <><circle cx="18" cy="5" r="2" /><circle cx="6" cy="12" r="2" /><circle cx="18" cy="19" r="2" /><path d="m8 11 8-5M8 13l8 5" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
    walk: <><circle cx="13" cy="4.5" r="2" /><path d="m12 7-2 5 3 2 1 6M10 12l-4 3M13 10l4 2 2 4M10 20l-3 1M14 20l3 1" /></>,
    mesh: <><path d="m4 7 8-4 8 4-8 4-8-4Z" /><path d="M4 7v10l8 4 8-4V7M12 11v10" /></>,
    camera: <><path d="M4 8h3l1.5-2h7L17 8h3v11H4Z" /><circle cx="12" cy="13.5" r="3.5" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
    measure: <><path d="M4 4h16v16H4z" /><path d="M8 4v4M12 4v2M16 4v4M8 20v-4M12 20v-2M16 20v-4M4 8h4M4 12h2M4 16h4M20 8h-4M20 12h-2M20 16h-4" /></>,
    eye: <><path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" /><circle cx="12" cy="12" r="2" /></>,
    video: <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></>,
    comment: <><path d="M5 5h14v10H9l-4 4V5Z" /><path d="M8 9h8M8 12h5" /></>,
    pause: <><path d="M8 5v14M16 5v14" /></>,
    play: <path d="m9 5 10 7-10 7V5Z" fill="currentColor" stroke="none" />,
    tip: <><path d="M9 18h6M10 21h4" /><path d="M8 14.5a6 6 0 1 1 8 0c-.8.6-1 1.2-1 2.5H9c0-1.3-.2-1.9-1-2.5Z" /><path d="M12 2v1" /></>,
  };
  return <svg {...common}>{paths[name] || paths.more}</svg>;
}


function RoomViewerScreen({ selectedKeyframes, reconstruction, onBack }) {
  const viewerUrl = getReconstructionViewerUrl(reconstruction);
  const modelAsset = getReconstructionModelAsset(reconstruction);
  const roomAvailable = Boolean(modelAsset || viewerUrl);

  return (
    <main className="room-viewer-screen">
      <header className="viewer-header">
        <button type="button" className="viewer-header-button" onClick={onBack} aria-label="Back to capture review"><Icon name="back" size={19} /></button>
        <div className="viewer-title">
          <strong>{roomAvailable ? 'Reconstructed room' : 'Room unavailable'}</strong>
          <span>{roomAvailable ? `${selectedKeyframes.length || reconstruction?.imageCount || 0} source viewpoints` : 'No reconstructed geometry'}</span>
        </div>
      </header>
      <section className="viewer-stage" aria-label={roomAvailable ? 'Reconstructed room viewer' : 'Reconstructed room unavailable'}>
        {modelAsset
          ? <RoomModelViewer asset={modelAsset} spawn={reconstruction?.spawn || reconstruction?.model?.spawn} />
          : viewerUrl
            ? <iframe className="viewer-remote-frame" src={viewerUrl} title="Reconstructed 3D room viewer" allow="fullscreen; xr-spatial-tracking" />
          : (
            <div className="viewer-missing-model" role="alert">
              <strong>No 3D model was produced.</strong>
              <span>PolyScan only opens this viewer after the reconstruction service returns real room geometry.</span>
              <button type="button" onClick={onBack}>Back to capture</button>
            </div>
          )}
      </section>
    </main>
  );
}


function LaunchScreen({ onStart, onImportCapture, scanAvailable }) {
  return (
    <main className="launch-screen">
      <header className="launch-header">
        <Wordmark />
        <span className="launch-kicker">Phone web room capture</span>
      </header>

      <section className="launch-content">
        <div className="launch-copy">
          <p className="eyebrow">Spatial camera</p>
          <h1>Capture the room.<br /><span>Reconstruct it for real.</span></h1>
          <p className="launch-description">
            Collect overlapping camera views from your phone or webcam, then build a walkable room model with photogrammetry.
          </p>
          {scanAvailable ? (
            <div className="launch-actions">
              <button type="button" className="primary-action" onClick={onStart}>
                <span>Start scan</span>
                <span className="action-arrow" aria-hidden="true">↗</span>
              </button>
              <label className="launch-import-action">
                <span>Use a recorded video</span>
                <input
                  type="file"
                  accept="video/*"
                  capture="environment"
                  onChange={(event) => {
                    const [file] = event.target.files || [];
                    if (file) onImportCapture(file);
                    event.target.value = '';
                  }}
                />
              </label>
            </div>
          ) : (
            <div className="desktop-scan-note" role="status">
              <strong>Open PolyScan on your phone</strong>
              <span>Live scanning uses a phone camera or a desktop webcam.</span>
            </div>
          )}
        </div>

        <div className="launch-visual" aria-label="Room scan preview">
          <div className="visual-orbit visual-orbit-one" />
          <div className="visual-orbit visual-orbit-two" />
          <div className="visual-point visual-point-one" />
          <div className="visual-point visual-point-two" />
          <div className="visual-point visual-point-three" />
          <div className="visual-room-plane visual-room-plane-back" />
          <div className="visual-room-plane visual-room-plane-floor" />
          <div className="visual-room-edge visual-room-edge-left" />
          <div className="visual-room-edge visual-room-edge-right" />
          <div className="visual-crosshair" />
          <div className="visual-caption">Full-size keyframes record the room. Geometry is built after upload.</div>
        </div>
      </section>

      <footer className="launch-footer">
        <span className="footer-signal"><span className="signal-dot" /> Camera-led mapping</span>
        <span className="launch-version">Web build <VersionBadge /></span>
      </footer>
    </main>
  );
}

function ScanScreen({ scanState, paused, onPause, onDone, onScanStateChange, cameraStream, cameraState, onRetryCamera, onCancel, onImportCapture }) {
  const videoRef = useRef(null);
  const analysisCanvasRef = useRef(null);
  const scanRef = useRef(createEmptyScanState());
  const orientationRef = useRef({ yaw: 0, pitch: 0 });
  const [trackingState, setTrackingState] = useState('searching');
  const [captureState, setCaptureState] = useState('waiting');
  // Capture starts with the scan surface. Pause is the only capture toggle;
  // the central control is visual feedback rather than a second workflow.
  const [recording, setRecording] = useState(true);
  const [modeOpen, setModeOpen] = useState(false);
  const recorderRef = useRef(null);
  const recorderChunksRef = useRef([]);
  const recordingStartedAtRef = useRef(0);
  const [recordingError, setRecordingError] = useState('');
  const [finishing, setFinishing] = useState(false);

  const resumeCamera = useCallback(() => {
    const video = videoRef.current;
    if (!video || (!video.paused && video.readyState >= 2)) return;
    try {
      const playAttempt = video.play();
      if (playAttempt?.catch) playAttempt.catch(() => {});
    } catch {
      // Some test environments expose a video element without media playback.
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !cameraStream) return undefined;
    video.srcObject = cameraStream;
    const resumeWhenReady = () => resumeCamera();
    video.addEventListener('loadedmetadata', resumeWhenReady);
    video.addEventListener('canplay', resumeWhenReady);
    video.addEventListener('playing', resumeWhenReady);
    resumeCamera();
    return () => {
      video.removeEventListener('loadedmetadata', resumeWhenReady);
      video.removeEventListener('canplay', resumeWhenReady);
      video.removeEventListener('playing', resumeWhenReady);
      video.pause();
      if (video.srcObject === cameraStream) video.srcObject = null;
    };
  }, [cameraStream, resumeCamera]);

  useEffect(() => {
    if (!window.DeviceOrientationEvent) return undefined;
    const handleOrientation = (event) => {
      const yaw = Number.isFinite(event.alpha) ? event.alpha : 0;
      const pitch = Number.isFinite(event.beta) ? Math.max(-58, Math.min(58, event.beta - 90)) : 0;
      orientationRef.current = { yaw, pitch };
    };
    window.addEventListener('deviceorientation', handleOrientation, true);
    return () => window.removeEventListener('deviceorientation', handleOrientation, true);
  }, []);

  useEffect(() => {
    scanRef.current = scanState;
  }, [scanState]);

  useEffect(() => {
    if (!cameraStream) return undefined;
    if (!window.MediaRecorder) {
      setRecordingError('Video recording is unavailable in this browser. Keyframes will still be saved.');
      return undefined;
    }

    const supportedTypes = [
      'video/mp4;codecs=h264',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mimeType = supportedTypes.find((type) => {
      try {
        return !window.MediaRecorder.isTypeSupported || window.MediaRecorder.isTypeSupported(type);
      } catch {
        return false;
      }
    });

    let recorder;
    try {
      recorder = new window.MediaRecorder(cameraStream, mimeType ? { mimeType } : undefined);
    } catch {
      setRecordingError('Video recording is unavailable in this browser. Keyframes will still be saved.');
      return undefined;
    }

    recorderChunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data?.size) recorderChunksRef.current.push(event.data);
    };
    recorder.onerror = () => setRecordingError('The browser stopped recording. Your saved viewpoints are still available.');
    recorderRef.current = recorder;
    recordingStartedAtRef.current = performance.now();
    setRecordingError('');
    try {
      recorder.start(1000);
    } catch {
      recorderRef.current = null;
      setRecordingError('Video recording could not start. Your saved viewpoints are still available.');
    }

    return () => {
      if (recorderRef.current !== recorder) return;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* The browser may already have stopped the stream. */ }
      }
      recorderRef.current = null;
    };
  }, [cameraStream]);

  useEffect(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    try {
      const shouldRecord = recording && !paused;
      if (!shouldRecord && recorder.state === 'recording') recorder.pause();
      if (shouldRecord && recorder.state === 'paused') recorder.resume();
    } catch {
      setRecordingError('The browser could not pause or resume the video. Your saved viewpoints are still available.');
    }
  }, [paused, recording]);

  const stopCaptureRecording = useCallback(() => new Promise((resolve) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      const chunks = recorderChunksRef.current;
      recorderChunksRef.current = [];
      resolve(chunks.length ? { blob: new Blob(chunks, { type: recorder?.mimeType || chunks[0].type || 'video/webm' }), durationMs: Math.max(0, performance.now() - recordingStartedAtRef.current) } : null);
      return;
    }
    const finalize = () => {
      const chunks = recorderChunksRef.current;
      recorderChunksRef.current = [];
      recorderRef.current = null;
      if (!chunks.length) {
        resolve(null);
        return;
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0].type || 'video/webm' });
      resolve({ blob, durationMs: Math.max(0, performance.now() - recordingStartedAtRef.current) });
    };
    recorder.addEventListener('stop', finalize, { once: true });
    try { recorder.stop(); } catch { finalize(); }
  }), []);

  useEffect(() => {
    if (paused) return undefined;

    const captureFrame = () => {
      const video = videoRef.current;
      const canvas = analysisCanvasRef.current;
      if (!video || !canvas) return;
      if (video.readyState < 2 || !video.videoWidth) {
        resumeCamera();
        return;
      }
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return;

      canvas.width = ANALYSIS_WIDTH;
      canvas.height = ANALYSIS_HEIGHT;
      context.drawImage(video, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
      setCaptureState('frames');
      const currentFrame = {
        width: ANALYSIS_WIDTH,
        height: ANALYSIS_HEIGHT,
        timestamp: performance.now(),
        features: extractFrameFeatures(context, ANALYSIS_WIDTH, ANALYSIS_HEIGHT),
      };
      const current = scanRef.current;
      const orientation = orientationRef.current;
      const evidence = buildFrameEvidence({
        previousFrame: current.lastFrame,
        currentFrame,
        orientation,
        referenceViewpoint: current.cameraKeyframes[current.cameraKeyframes.length - 1]?.viewpoint,
        referenceFeatures: current.cameraKeyframes[current.cameraKeyframes.length - 1]?.image?.features || [],
        thresholds: DEFAULT_VIEWPOINT_THRESHOLDS,
      });
      const featureTracks = updateFeatureTracks(current.featureTracks, evidence.matches, currentFrame.timestamp);
      const nextCoverage = updateDirectionalCoverage(current.directionalCoverage, {
        visibleCellIds: getVisibleCellIds({
          yaw: orientation.yaw,
          pitch: orientation.pitch,
          yawBins: 20,
        }),
        usefulViewpoint: evidence.usefulViewpoint,
        featureConfidence: evidence.featureConfidence,
        parallax: evidence.parallax,
      });
      const isFirstKeyframe = current.cameraKeyframes.length === 0;
      let thumbnail = null;
      try {
        thumbnail = canvas.toDataURL('image/jpeg', 0.72);
      } catch {
        // Canvas export can be unavailable in restricted browsers.
      }
      // Do not inflate the scan count on a timer. A saved view must either be
      // the first lock or contain demonstrably new camera evidence.
      const shouldCaptureKeyframe = evidence.tracking
        && (isFirstKeyframe || evidence.usefulViewpoint)
        && current.cameraKeyframes.length < 96;
      const keyframeId = `keyframe-${current.cameraKeyframes.length + 1}`;
      const nextKeyframes = shouldCaptureKeyframe
        ? [...current.cameraKeyframes, {
          id: keyframeId,
          timestamp: currentFrame.timestamp,
          viewpoint: evidence.viewpoint,
          featureCount: currentFrame.features.length,
          stableTrackCount: evidence.stableTrackCount,
          sharpness: currentFrame.features.reduce((sum, feature) => sum + feature.score, 0),
          image: currentFrame,
          thumbnail,
          capturePromise: captureVideoKeyframe(video),
        }]
        : current.cameraKeyframes;
      // Keep a surface snapshot for each genuinely new camera viewpoint. A
      // single anchor can follow a wall for a short pan, but it cannot describe
      // the new section that enters the frame later. These snapshots are what
      // let a blue region come back when the user returns to that exact view.
      const shouldCreateSurfaceAnchor = shouldCaptureKeyframe
        && currentFrame.features.length >= 6
        && (current.surfaceAnchors || []).length < MAX_SURFACE_ANCHORS;
      const newSurfaceAnchor = shouldCreateSurfaceAnchor
        ? createSurfaceAnchor({
          id: keyframeId,
          features: currentFrame.features,
          viewpoint: evidence.viewpoint,
          timestamp: currentFrame.timestamp,
        })
        : null;
      const surfaceAnchors = appendSurfaceAnchor(current.surfaceAnchors || [], newSurfaceAnchor, MAX_SURFACE_ANCHORS);
      const surfaceMap = localizeSurfaceAnchors(surfaceAnchors, currentFrame.features, SURFACE_LOCK_OPTIONS);
      const hasCurrentSurfaceLock = surfaceMap.localizations.length > 0 || Boolean(newSurfaceAnchor);
      const currentSurfaceCoverage = surfaceMap.coverageCells?.length
        ? surfaceMap.coverageCells
        : surfaceMap.patches;
      const newSurfaceCoverage = newSurfaceAnchor?.coverageCells?.length
        ? newSurfaceAnchor.coverageCells
        : (newSurfaceAnchor?.patches || []);
      const visibleSurfaceStickers = hasCurrentSurfaceLock && newSurfaceAnchor
        && !surfaceMap.localizations.some(({ anchor }) => anchor.id === newSurfaceAnchor.id)
        ? [
          ...surfaceMap.stickers,
          ...newSurfaceAnchor.stickers,
        ]
        : hasCurrentSurfaceLock
          ? surfaceMap.stickers
          : (current.visibleSurfaceStickers || []);
      const visibleSurfacePatches = hasCurrentSurfaceLock && newSurfaceAnchor
        && !surfaceMap.localizations.some(({ anchor }) => anchor.id === newSurfaceAnchor.id)
        ? [
          ...currentSurfaceCoverage,
          ...newSurfaceCoverage,
        ]
        : hasCurrentSurfaceLock
          ? currentSurfaceCoverage
          : (current.visibleSurfacePatches || []);
      const visibleSurfaceAnchorCount = hasCurrentSurfaceLock
        ? surfaceMap.localizations.length
          + (newSurfaceAnchor && !surfaceMap.localizations.some(({ anchor }) => anchor.id === newSurfaceAnchor.id) ? 1 : 0)
        : (current.visibleSurfaceAnchorCount || 0);

      const nextState = {
        ...current,
        directionalCoverage: nextCoverage,
        cameraKeyframes: nextKeyframes,
        featureTracks,
        frameCount: (current.frameCount || 0) + 1,
        distinctViewpoints: current.distinctViewpoints + (evidence.usefulViewpoint ? 1 : 0),
        meaningfulCameraMotion: current.meaningfulCameraMotion || evidence.usefulViewpoint,
        stableFeatures: evidence.stableFeatures,
        surfaceAnchors,
        visibleSurfaceStickers,
        visibleSurfacePatches,
        visibleSurfaceAnchorCount,
        lastFrame: { ...currentFrame, viewpoint: evidence.viewpoint },
        lastViewpoint: evidence.viewpoint,
        lastEvidence: evidence,
      };
      scanRef.current = nextState;
      onScanStateChange(nextState);
      setTrackingState(evidence.tracking ? 'tracking' : current.lastFrame ? 'lost' : 'searching');
    };

    const timer = window.setInterval(captureFrame, CAPTURE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [onScanStateChange, paused, resumeCamera]);

  const keyframeCount = scanState.cameraKeyframes.length;
  const stableTrackCount = scanState.featureTracks.filter((track) => track.observations.length >= 2).length;
  const viable = isReconstructionViable({
    keyframes: keyframeCount,
    distinctViewpoints: scanState.distinctViewpoints,
    featureTracks: stableTrackCount,
    meaningfulCameraMotion: scanState.meaningfulCameraMotion,
  }) || (keyframeCount >= 8 && scanState.frameCount >= 20);
  const mappingReady = keyframeCount > 0;
  const surfaceStickers = scanState.visibleSurfaceStickers || [];
  const surfacePatches = scanState.visibleSurfacePatches || [];
  const minimumViews = 28;
  const roomShellCovered = hasCompleteRoomCoverage(scanState.directionalCoverage);
  const fullRoomReady = keyframeCount >= minimumViews && viable && roomShellCovered;
  const captureProgress = Math.min(100, Math.round((keyframeCount / minimumViews) * 100));
  const coach = getScanCoachAdvice({
    directionalCoverage: scanState.directionalCoverage,
    keyframes: keyframeCount,
    evidence: scanState.lastEvidence,
    roomShellCovered,
    trackingState,
  });
  const visibleDetailCount = scanState.lastFrame?.features?.length || 0;
  const instruction = paused
    ? 'Paused'
    : visibleDetailCount > 0 && visibleDetailCount < 10
      ? 'Aim at an edge, corner, pattern, or piece of furniture'
      : trackingState === 'lost'
        ? 'Slow down and hold a detailed surface in view'
        : coach.instruction;
  const cameraMessage = cameraState === 'unavailable'
    ? 'Camera preview unavailable'
    : cameraState === 'blocked'
      ? 'Camera permission is waiting'
      : cameraState === 'requesting'
        ? 'Allow camera access'
        : cameraState === 'live'
          ? 'Camera live'
          : 'Starting camera';
  const statusLabel = trackingState === 'lost'
    ? 'Tracking lost'
    : cameraState === 'unavailable' || cameraState === 'blocked'
      ? 'Preview only'
      : cameraState === 'requesting'
        ? 'Allow camera'
        : recording
          ? 'Recording'
          : 'Ready';
  const handleDone = async () => {
    setFinishing(true);
    const capture = await stopCaptureRecording();
    setRecording(false);
    const selected = selectBestKeyframes(scanState.cameraKeyframes, 48);
    const resolved = await resolveKeyframeAssets(selected);
    onDone(resolved, capture, scanState);
  };

  return (
    <main className="scan-screen" onPointerDown={resumeCamera}>
      <section className="scan-preview-frame" aria-label="Room camera preview">
        <video ref={videoRef} className="camera-video" autoPlay playsInline muted onLoadedMetadata={resumeCamera} onCanPlay={resumeCamera} aria-label="Live room camera" />
        <CameraPlaceholder />
        {/* Keep the last recognized surface visible through a brief tracking
            dropout. Clearing it on one blurry frame made a wall look like it
            had been unscanned again even though the lock was still valid. */}
        <SurfaceStickerCanvas
          stickers={surfaceStickers}
          patches={surfacePatches}
          videoRef={videoRef}
        />
        <canvas ref={analysisCanvasRef} className="analysis-canvas" aria-hidden="true" />
        <div className="camera-corners" aria-hidden="true">
          <span className="corner corner-top-left" />
          <span className="corner corner-top-right" />
          <span className="corner corner-bottom-left" />
          <span className="corner corner-bottom-right" />
        </div>
      </section>

      <header className="scan-hud scan-reference-top">
        <div className="scan-branding"><Wordmark compact /><VersionBadge /></div>
        <div className="scan-top-actions">
          <button type="button" className="scan-pill-button" onClick={() => setModeOpen((value) => !value)} aria-expanded={modeOpen}>
            <Icon name="tip" size={15} />
            <span>Tips</span>
          </button>
          <button type="button" className="scan-icon-button scan-pause" onClick={onPause} aria-label={paused ? 'Resume scan' : 'Pause scan'}>
            <Icon name={paused ? 'play' : 'pause'} size={17} />
          </button>
          <button type="button" className="scan-icon-button" onClick={onCancel} aria-label="Close camera">
            <Icon name="close" size={17} />
          </button>
        </div>
      </header>

      {modeOpen && (
        <div className="scan-tip-card" role="status">
          <strong>Scan the room slowly</strong>
          <span>Natural-color areas are unscanned. Blue squares mark surfaces already locked.</span>
        </div>
      )}

      <aside className="scan-capture-coach" aria-live="polite">
        <div className="scan-capture-coach-heading">
          <span className={`scan-coach-state${fullRoomReady ? ' is-ready' : ''}`}>{fullRoomReady ? 'Full room target reached' : roomShellCovered ? 'Room shell covered' : 'Adaptive scan guide'}</span>
          <strong>{keyframeCount} / {minimumViews} views</strong>
        </div>
        <div className="scan-progress-meter" aria-label={`${keyframeCount} of ${minimumViews} minimum room views captured`}>
          <span style={{ width: `${captureProgress}%` }} />
        </div>
        <strong className="scan-coach-title">{coach.title}</strong>
        <p>{paused ? 'Resume when you are ready to continue the guided capture.' : fullRoomReady ? 'Make one optional final pass over anything you skipped, then finish the scan.' : coach.reason}</p>
      </aside>

      <div className="scan-status-row" role="status" aria-live="polite">
        <span className={`scan-live-dot ${recording ? 'is-recording' : ''}`} />
        <span>{statusLabel}</span>
        <span className="scan-frame-count">{mappingReady
          ? scanState.visibleSurfaceAnchorCount > 0
            ? trackingState === 'tracking' && scanState.visibleSurfaceAnchorCount > 0
              ? `Surface locked / ${surfaceStickers.length} scan marks`
              : 'Reacquiring surface lock'
            : `${keyframeCount} views saved / point back to restore marks`
          : 'Natural color = unscanned / blue squares = scanned'}</span>
      </div>

      <div className="scan-bottom-ui scan-reference-bottom">
        <div className="scan-guidance" role="status" aria-live="polite">
          <span className="guidance-toast">{instruction}</span>
          {cameraMessage === 'Camera preview unavailable' && <small>Use a supported phone browser for live capture.</small>}
        </div>

        <div className="scan-reference-controls">
          <button type="button" className="scan-mode-button" onClick={() => setModeOpen((value) => !value)} aria-label="Scan mode Auto">
            <span>Auto</span>
            <span className="mode-chevron">⌃</span>
          </button>
          <div className={`scan-map-control${recording ? ' is-active' : ''}`} aria-label="Capture recording active">
            <span className="scan-map-control-core" aria-hidden="true"><Icon name="layers" size={21} /></span>
          </div>
          <button
            type="button"
            className="scan-done-button"
            onClick={handleDone}
            disabled={!fullRoomReady || finishing}
            aria-label={fullRoomReady ? 'Done scanning' : 'Done scanning, waiting for full room coverage'}
          >
            <span className="done-check" aria-hidden="true">✓</span>
            <span>{finishing ? 'Saving' : fullRoomReady ? 'Finish scan' : keyframeCount < minimumViews ? `Need ${Math.max(0, minimumViews - keyframeCount)} views` : 'Cover room shell'}</span>
          </button>
        </div>
      </div>
      {(cameraState === 'unavailable' || cameraState === 'blocked' || cameraState === 'requesting') && (
        <div className="camera-warning" role="alert">
          <strong>{cameraState === 'requesting' ? 'Allow camera access to begin mapping.' : 'Camera access is needed for live coverage.'}</strong>
          <span>{cameraState === 'requesting' ? 'Choose Allow in the browser prompt.' : 'Open PolyScan on HTTPS and allow camera access.'}</span>
          {(cameraState === 'unavailable' || cameraState === 'blocked') && <button type="button" onClick={onRetryCamera}>Retry camera</button>}
          {(cameraState === 'unavailable' || cameraState === 'blocked') && <label className="camera-upload-action"><span>Use a recorded video</span><input type="file" accept="video/*" onChange={(event) => { const [file] = event.target.files || []; if (file) onImportCapture(file); event.target.value = ''; }} /></label>}
        </div>
      )}
      {recordingError && <div className="capture-warning" role="status">{recordingError}</div>}
      <span className="capture-note" role="status">{mappingReady ? 'Mapping active' : captureState === 'frames' ? 'Camera frames active' : ''}</span>
    </main>
  );
}

function ReviewScreen({ selectedKeyframes, capture, processingAvailable, onProcess, onScanAgain }) {
  const preview = selectedKeyframes.find((frame) => frame.thumbnail)?.thumbnail;
  const hasVideo = Boolean(capture?.blob);
  const imageCount = countCapturedKeyframes(selectedKeyframes);
  const hasCapture = hasVideo || imageCount >= 8;
  const duration = capture?.durationMs ? `${Math.max(1, Math.round(capture.durationMs / 1000))}s` : hasVideo ? 'Video' : imageCount ? 'Images' : 'None';
  return (
    <main className="review-screen capture-review-screen">
      <header className="review-header"><Wordmark /><span className="review-top-label">Capture review</span></header>
      <section className="capture-review-content">
        <div className="review-preview-card">
          {capture?.url ? <video className="review-capture-video" src={capture.url} controls playsInline preload="metadata" aria-label="Recorded room capture" /> : preview ? <img src={preview} alt="Selected room viewpoint" /> : <div className="review-preview-placeholder" aria-hidden="true"><div /><span /></div>}
          <div className="review-preview-overlay"><span className="scan-live-dot" /> {hasVideo ? 'Video and images ready' : hasCapture ? 'Image set ready' : 'Capture incomplete'}</div>
        </div>
        <div className="review-copy-block">
          <p className="eyebrow">Scan complete</p>
          <h1>Review your<br /><span>room capture.</span></h1>
          <p>{hasCapture ? 'Your overlapping camera views are ready for server-side photogrammetry and a real room mesh.' : 'Scan more overlapping views before PolyScan can reconstruct the room.'}</p>
          <div className="review-stats" aria-label="Capture summary">
            <span><strong>{selectedKeyframes.length || 0}</strong> viewpoints</span>
            <span><strong>{imageCount}</strong> full-size images</span>
            <span><strong>{duration}</strong> capture</span>
          </div>
          <div className="review-actions">
            <button type="button" className="primary-action" onClick={onProcess} disabled={!hasCapture || !processingAvailable}>
              <span>{!hasCapture ? 'More views required' : processingAvailable ? 'Reconstruct 3D room' : '3D processing not connected'}</span>
              <span className="action-arrow" aria-hidden="true">↗</span>
            </button>
            {!processingAvailable && <small className="build-note">Connect the reconstruction API before this capture can become a 3D model.</small>}
            <button type="button" className="text-action" onClick={onScanAgain}>Scan again</button>
          </div>
        </div>
      </section>
    </main>
  );
}

function ProcessingScreen({ buildState, onOpenViewer, onRetry, onBack }) {
  const isWorking = buildState.status === 'uploading' || buildState.status === 'processing';
  const title = buildState.status === 'error'
      ? 'The room is not built yet.'
      : buildState.status === 'ready'
        ? 'Your room is ready.'
        : 'Building your room.';
  const description = buildState.status === 'error'
      ? buildState.error
      : isWorking
        ? 'Keep this page open while the capture uploads and the room is reconstructed.'
        : 'A room viewer will appear here when processing is complete.';
  return (
    <main className="build-screen">
      <header className="build-header"><button type="button" className="viewer-header-button" onClick={onBack} aria-label="Back to capture review"><Icon name="back" size={19} /></button><div className="build-branding"><Wordmark compact /><VersionBadge /></div><span className="build-header-label">Room build</span></header>
      <section className="build-content">
        <div className="build-visual" aria-hidden="true">
          <div className="build-orbit build-orbit-one" />
          <div className="build-orbit build-orbit-two" />
          <div className="build-room-outline" />
          <span className="build-scan-line" />
        </div>
        <div className="build-copy">
          <p className="eyebrow">Spatial processing</p>
          <h1>{title}</h1>
          <p>{description}</p>
          {isWorking && (
            <div className="build-processing-status" role="status" aria-live="polite">
              <span className="build-processing-dot" aria-hidden="true" />
              <span>{buildState.status === 'uploading' ? 'Uploading capture' : 'Reconstructing room'}{Number.isFinite(buildState.progress) ? ` ${Math.round(buildState.progress)}%` : ''}</span>
            </div>
          )}
          {buildState.status === 'error' && <button type="button" className="primary-action" onClick={onRetry}><span>Try again</span><span className="action-arrow" aria-hidden="true">↗</span></button>}
          {buildState.status === 'ready' && <button type="button" className="primary-action" onClick={onOpenViewer}><span>Open room viewer</span><span className="action-arrow" aria-hidden="true">↗</span></button>}
        </div>
      </section>
      <button type="button" className="build-back-link" onClick={onBack}>Back to capture review</button>
    </main>
  );
}

function App() {
  const scanAvailable = isCameraScanDevice();
  const [screen, setScreen] = useState('launch');
  const [paused, setPaused] = useState(false);
  const [scanState, setScanState] = useState(createEmptyScanState);
  const [selectedKeyframes, setSelectedKeyframes] = useState([]);
  const [capture, setCapture] = useState(null);
  const [reconstruction, setReconstruction] = useState(null);
  const [buildState, setBuildState] = useState({ status: 'idle', progress: 0, jobId: null, error: null });
  const [cameraStream, setCameraStream] = useState(null);
  const [cameraState, setCameraState] = useState('idle');
  const cameraRequestRef = useRef(null);
  const cameraSessionRef = useRef(0);
  const captureUrlRef = useRef(null);
  const buildAbortRef = useRef(null);

  const clearCapture = useCallback(() => {
    if (captureUrlRef.current) {
      URL.revokeObjectURL(captureUrlRef.current);
      captureUrlRef.current = null;
    }
    setCapture(null);
  }, []);

  const saveCapture = useCallback((nextCapture) => {
    if (captureUrlRef.current) URL.revokeObjectURL(captureUrlRef.current);
    if (!nextCapture?.blob) {
      captureUrlRef.current = null;
      setCapture(null);
      return;
    }
    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(nextCapture.blob) : null;
    captureUrlRef.current = url;
    setCapture({ ...nextCapture, url });
  }, []);

  useEffect(() => () => {
    if (captureUrlRef.current) URL.revokeObjectURL(captureUrlRef.current);
    buildAbortRef.current?.abort();
  }, []);

  const stopCamera = useCallback(() => {
    setCameraStream((stream) => {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      return null;
    });
  }, []);

  const requestCamera = useCallback((sessionId) => {
    if (cameraRequestRef.current) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraState('unavailable');
      return;
    }
    setCameraState('requesting');
    let request;
    const preferredConstraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
    try {
      request = navigator.mediaDevices.getUserMedia(preferredConstraints).catch((error) => {
        if (error?.name !== 'OverconstrainedError' && error?.name !== 'NotFoundError') throw error;
        return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      });
    } catch {
      setCameraState('unavailable');
      return;
    }
    /*
     * Some phones reject ideal rear-camera constraints even though they can
     * open a normal camera stream. The fallback above keeps the scanner useful
     * instead of leaving the user on an endless loading state.
     */
    if (!request) {
      setCameraState('unavailable');
      return;
    }
    cameraRequestRef.current = request;
    let requestActive = true;
    const timeout = window.setTimeout(() => {
      if (cameraRequestRef.current === request && cameraSessionRef.current === sessionId) {
        requestActive = false;
        cameraRequestRef.current = null;
        setCameraState('blocked');
      }
    }, 6000);
    request.then((stream) => {
      window.clearTimeout(timeout);
      cameraRequestRef.current = null;
      if (!requestActive || cameraSessionRef.current !== sessionId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      setCameraStream(stream);
      setCameraState('live');
    }).catch(() => {
      window.clearTimeout(timeout);
      cameraRequestRef.current = null;
      if (requestActive && cameraSessionRef.current === sessionId) setCameraState('unavailable');
    });
  }, []);

  const retryCamera = useCallback(() => {
    cameraSessionRef.current += 1;
    stopCamera();
    requestCamera(cameraSessionRef.current);
  }, [requestCamera, stopCamera]);

  const cancelScan = () => {
    cameraSessionRef.current += 1;
    stopCamera();
    setCameraState('idle');
    setScreen('launch');
  };

  const startScan = () => {
    if (!isCameraScanDevice()) return;
    cameraSessionRef.current += 1;
    stopCamera();
    buildAbortRef.current?.abort();
    clearCapture();
    setReconstruction(null);
    setBuildState({ status: 'idle', progress: 0, jobId: null, error: null });
    setCameraState('requesting');
    if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
      window.DeviceOrientationEvent.requestPermission().catch(() => {});
    }
    setScanState(createEmptyScanState());
    setPaused(false);
    setScreen('scan');
    requestCamera(cameraSessionRef.current);
  };

  const finishScan = (keyframes, recordedCapture, scanSnapshot) => {
    cameraSessionRef.current += 1;
    stopCamera();
    setCameraState('idle');
    setSelectedKeyframes(keyframes);
    saveCapture(recordedCapture);
    setReconstruction(null);
    setBuildState({ status: 'idle', progress: 0, jobId: null, error: null, manifest: createCaptureManifest(scanSnapshot, keyframes) });
    setScreen('review');
  };

  const importCapture = (file) => {
    if (!file || !file.type.startsWith('video/')) return;
    cameraSessionRef.current += 1;
    stopCamera();
    clearCapture();
    saveCapture({ blob: file, mimeType: file.type, durationMs: 0, imported: true });
    setSelectedKeyframes([]);
    setReconstruction(null);
    setBuildState({ status: 'idle', progress: 0, jobId: null, error: null });
    setScreen('review');
  };

  const openViewer = () => setScreen('viewer');
  const backToReview = () => {
    buildAbortRef.current?.abort();
    setScreen('review');
  };

  const pollReconstruction = useCallback(async (jobId, controller) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30 * 60 * 1000) {
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(resolve, 1600);
        controller.signal.addEventListener('abort', () => {
          window.clearTimeout(timer);
          reject(new DOMException('Build cancelled', 'AbortError'));
        }, { once: true });
      });
      const job = await getReconstructionJob(jobId, { signal: controller.signal });
      const status = String(job.status || 'processing').toLowerCase();
      const progress = Math.max(0, Math.min(99, Number(job.progress ?? job.percent ?? 0)));
      setBuildState((current) => ({ ...current, status: 'processing', progress, jobId }));
      if (['complete', 'completed', 'ready', 'succeeded'].includes(status)) {
        const output = job.output || job;
        if (!getReconstructionModelAsset(output) && !getReconstructionViewerUrl(output)) throw new Error('Reconstruction finished without a usable room model.');
        setReconstruction(output);
        setBuildState({ status: 'ready', progress: 100, jobId, error: null });
        return;
      }
      if (['failed', 'error', 'cancelled'].includes(status)) throw new Error(job.message || 'The reconstruction service could not build this room.');
    }
    throw new Error('The reconstruction is taking longer than expected. You can try again without losing the capture.');
  }, []);

  const startBuild = useCallback(() => {
    buildAbortRef.current?.abort();
    const manifest = createCaptureManifest(scanState, selectedKeyframes);
    setScreen('processing');
    const imageCount = countCapturedKeyframes(selectedKeyframes);
    if (!capture?.blob && imageCount < 8) {
      setBuildState({ status: 'error', progress: 0, jobId: null, error: 'At least eight full-size room viewpoints or a recorded video are required.', manifest });
      return;
    }
    if (!hasReconstructionEndpoint()) {
      setBuildState({ status: 'error', progress: 0, jobId: null, error: 'The reconstruction API is not connected. PolyScan will not substitute a fake room model.', manifest });
      return;
    }

    const controller = new AbortController();
    buildAbortRef.current = controller;
    setBuildState({ status: 'uploading', progress: 0, jobId: null, error: null, manifest });
    checkReconstructionService({ signal: controller.signal }).then(() => submitCapture({
      capture,
      keyframes: selectedKeyframes,
      manifest,
      signal: controller.signal,
      onProgress: (progress) => setBuildState((current) => ({ ...current, status: 'uploading', progress })),
    })).then(async (job) => {
      const jobId = job.id || job.jobId;
      if (!jobId) throw new Error('The reconstruction service did not return a job id.');
      const status = String(job.status || '').toLowerCase();
      if (job.output || ['complete', 'completed', 'ready', 'succeeded'].includes(status)) {
        const output = job.output || job;
        if (!getReconstructionModelAsset(output) && !getReconstructionViewerUrl(output)) throw new Error('Reconstruction finished without a usable room model.');
        setReconstruction(output);
        setBuildState({ status: 'ready', progress: 100, jobId, error: null });
        return;
      }
      setBuildState({ status: 'processing', progress: Math.max(94, Number(job.progress || 0)), jobId, error: null });
      await pollReconstruction(jobId, controller);
    }).catch((error) => {
      if (error?.name === 'AbortError') return;
      setBuildState({ status: 'error', progress: 0, jobId: null, error: error.message || 'The room could not be built.', manifest });
    });
  }, [capture, pollReconstruction, scanState, selectedKeyframes]);

  let activeScreen;
  if (screen === 'launch') activeScreen = <LaunchScreen onStart={startScan} onImportCapture={importCapture} scanAvailable={scanAvailable} />;
  else if (screen === 'scan') {
    activeScreen = (
      <ScanScreen
        scanState={scanState}
        paused={paused}
        cameraStream={cameraStream}
        cameraState={cameraState}
        onPause={() => setPaused((value) => !value)}
        onDone={finishScan}
        onRetryCamera={retryCamera}
        onCancel={cancelScan}
        onImportCapture={importCapture}
        onScanStateChange={setScanState}
      />
    );
  } else if (screen === 'review') {
    activeScreen = <ReviewScreen selectedKeyframes={selectedKeyframes} capture={capture} processingAvailable={hasReconstructionEndpoint()} onProcess={startBuild} onScanAgain={startScan} />;
  } else if (screen === 'processing') {
    activeScreen = <ProcessingScreen buildState={buildState} onOpenViewer={openViewer} onRetry={startBuild} onBack={backToReview} />;
  } else activeScreen = <RoomViewerScreen selectedKeyframes={selectedKeyframes} reconstruction={reconstruction} onBack={() => setScreen('review')} />;

  return <div className="App">{activeScreen}</div>;
}

export { App, RoomViewerScreen, ScanScreen, createEmptyScanState, isMobileScanDevice };
export default App;
