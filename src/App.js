import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import { APP_VERSION } from './appVersion';
import {
  DEFAULT_VIEWPOINT_THRESHOLDS,
  createDirectionalCoverage,
  getVisibleCellIds,
  selectBestKeyframes,
  updateDirectionalCoverage,
} from './scanner/coverageModel';
import {
  buildFrameEvidence,
  extractFrameFeatures,
  updateFeatureTracks,
} from './scanner/featureTracking';
import WebXRDepthScanner from './scanner/WebXRDepthScanner';
import { requestDepthSession } from './scanner/webxrDepth';
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
  webXRPointCloud: [],
  webXRMeshFaces: [],
  webXRScanStats: null,
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

function ScanScreen({ scanState, paused, onPause, onDone, onScanStateChange, cameraStream, cameraState, captureMode, xrSession, onXrError, onRetryCamera, onCancel, onImportCapture }) {
  const videoRef = useRef(null);
  const analysisCanvasRef = useRef(null);
  const scanRef = useRef(createEmptyScanState());
  const orientationRef = useRef({ yaw: 0, pitch: 0 });
  // Polycam-style capture starts as soon as the camera opens. The center
  // control can pause/resume it, while Done is always the user's choice.
  const [recording, setRecording] = useState(true);
  const recorderRef = useRef(null);
  const recorderChunksRef = useRef([]);
  const recordingStartedAtRef = useRef(0);
  const xrPublishAtRef = useRef(0);
  const xrPointCloudRef = useRef([]);
  const xrMeshFacesRef = useRef([]);
  const xrScanStatsRef = useRef(null);
  const [recordingError, setRecordingError] = useState('');
  const [finishing, setFinishing] = useState(false);
  const depthStats = scanState?.webXRScanStats;

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
    // Keep the renderer-owned cloud when an unrelated React update (pause,
    // recording, or a status change) causes this component to render again.
    // Otherwise the latest un-published depth points could be overwritten by
    // the previous React snapshot just before Done is pressed.
    if (xrPointCloudRef.current.length) {
      scanRef.current = {
        ...scanState,
        webXRPointCloud: xrPointCloudRef.current,
        webXRMeshFaces: xrMeshFacesRef.current,
        webXRScanStats: xrScanStatsRef.current,
      };
    } else {
      scanRef.current = scanState;
    }
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

  const publishXrPointCloud = useCallback((payload) => {
    const points = Array.isArray(payload) ? payload : payload?.points || [];
    const faces = Array.isArray(payload) ? [] : payload?.faces || [];
    const nextState = {
      ...scanRef.current,
      webXRPointCloud: points,
      webXRMeshFaces: faces,
      webXRScanStats: Array.isArray(payload) ? null : {
        pointCount: payload?.pointCount || points.length,
        faceCount: payload?.faceCount || faces.length,
        markerCount: payload?.markerCount || 0,
        depthFrameCount: payload?.depthFrameCount || 0,
        depthBatchCount: payload?.depthBatchCount || 0,
        depthSampleCount: payload?.depthSampleCount || 0,
        emptyDepthBatchCount: payload?.emptyDepthBatchCount || 0,
        consecutiveEmptyBatches: payload?.consecutiveEmptyBatches || 0,
        trackingState: payload?.trackingState || 'tracking',
        storageCapacityReached: Boolean(payload?.storageCapacityReached),
        sampleGrid: payload?.sampleGrid || 0,
        sampleIntervalMs: payload?.sampleIntervalMs || 0,
      },
    };
    xrPointCloudRef.current = points;
    xrMeshFacesRef.current = faces;
    xrScanStatsRef.current = nextState.webXRScanStats;
    scanRef.current = nextState;
    // The renderer owns the live point cloud. React only needs an occasional
    // snapshot for scan completion and status, not one update per depth batch.
    const now = performance.now();
    if (now - xrPublishAtRef.current < 1000) return;
    xrPublishAtRef.current = now;
    onScanStateChange(nextState);
  }, [onScanStateChange]);

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
      // Do not inflate the scan count on a timer. A saved view must either be
      // the first lock or contain demonstrably new camera evidence.
      const shouldCaptureKeyframe = recording && evidence.tracking
        && (isFirstKeyframe || evidence.usefulViewpoint)
        && current.cameraKeyframes.length < 96;
      let thumbnail = null;
      if (shouldCaptureKeyframe) {
        try {
          // JPEG encoding is relatively expensive on mobile. Only encode a
          // thumbnail after the frame has passed the capture-quality checks.
          thumbnail = canvas.toDataURL('image/jpeg', 0.72);
        } catch {
          // Canvas export can be unavailable in restricted browsers.
        }
      }
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
      const nextState = {
        ...current,
        directionalCoverage: nextCoverage,
        cameraKeyframes: nextKeyframes,
        featureTracks,
        frameCount: (current.frameCount || 0) + 1,
        distinctViewpoints: current.distinctViewpoints + (evidence.usefulViewpoint ? 1 : 0),
        meaningfulCameraMotion: current.meaningfulCameraMotion || evidence.usefulViewpoint,
        stableFeatures: evidence.stableFeatures,
        lastFrame: { ...currentFrame, viewpoint: evidence.viewpoint },
        lastViewpoint: evidence.viewpoint,
        lastEvidence: evidence,
      };
      scanRef.current = nextState;
      onScanStateChange(nextState);
    };

    const timer = window.setInterval(captureFrame, CAPTURE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [onScanStateChange, paused, recording, resumeCamera]);

  const handleDone = async () => {
    setFinishing(true);
    const capture = await stopCaptureRecording();
    setRecording(false);
    const finalScanState = scanRef.current;
    const selected = selectBestKeyframes(finalScanState.cameraKeyframes, 48);
    const resolved = await resolveKeyframeAssets(selected);
    onDone(resolved, capture, finalScanState);
  };

  return (
    <main className={`scan-screen${xrSession ? ' is-xr-scan' : ''}`} onPointerDown={resumeCamera}>
      <section className="scan-preview-frame" aria-label="Room camera preview">
        {xrSession
          ? <WebXRDepthScanner session={xrSession} onPointCloud={publishXrPointCloud} onSessionError={onXrError} />
          : <>
            <video ref={videoRef} className="camera-video" autoPlay playsInline muted onLoadedMetadata={resumeCamera} onCanPlay={resumeCamera} aria-label="Live room camera" />
            <CameraPlaceholder />
          </>}
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
          <button type="button" className="scan-icon-button scan-pause" onClick={onPause} aria-label={paused ? 'Resume scan' : 'Pause scan'}>
            <Icon name={paused ? 'play' : 'pause'} size={17} />
          </button>
          <button type="button" className="scan-icon-button" onClick={onCancel} aria-label="Close camera">
            <Icon name="close" size={17} />
          </button>
        </div>
      </header>

      <div className="scan-bottom-ui scan-reference-bottom">
        <div className="scan-reference-controls">
          <div className="scan-mode-button" aria-hidden="true">
            <span>Auto</span>
            <span className="mode-chevron">⌃</span>
          </div>
          <button
            type="button"
            className={`scan-map-control${recording ? ' is-active' : ''}`}
            aria-label={recording ? 'Pause capture recording' : 'Start capture recording'}
            onClick={() => setRecording((value) => !value)}
          >
            <span className="scan-map-control-core" aria-hidden="true"><Icon name="layers" size={21} /></span>
          </button>
          <button
            type="button"
            className="scan-done-button"
            onClick={handleDone}
            disabled={finishing}
            aria-label="Done scanning"
          >
            <span className="done-check" aria-hidden="true">✓</span>
            <span>{finishing ? 'Saving' : 'Done'}</span>
          </button>
        </div>
      </div>
      {captureMode === 'depth' && (
        <div className="scan-capture-mode scan-capture-mode-depth" role="status">
          <strong>{depthStats?.trackingState === 'waiting' ? 'Finding depth' : 'AR depth scan active'}</strong>
          {depthStats?.storageCapacityReached && <span>Depth map is full. Press Done to build it.</span>}
        </div>
      )}
      {captureMode === 'camera' && <div className="scan-capture-mode scan-capture-mode-fallback" role="status"><strong>Camera capture active</strong><span>AR depth is unavailable on this phone. A 3D room will be built after processing.</span></div>}
      {(cameraState === 'unavailable' || cameraState === 'blocked' || cameraState === 'requesting') && (
        <div className="camera-warning" role="alert">
          <strong>{cameraState === 'requesting' ? 'Allow camera access to begin mapping.' : 'Camera access is needed for live coverage.'}</strong>
          <span>{cameraState === 'requesting' ? 'Choose Allow in the browser prompt.' : 'Open PolyScan on HTTPS and allow camera access.'}</span>
          {(cameraState === 'unavailable' || cameraState === 'blocked') && <button type="button" onClick={onRetryCamera}>Retry camera</button>}
          {(cameraState === 'unavailable' || cameraState === 'blocked') && <label className="camera-upload-action"><span>Use a recorded video</span><input type="file" accept="video/*" onChange={(event) => { const [file] = event.target.files || []; if (file) onImportCapture(file); event.target.value = ''; }} /></label>}
        </div>
      )}
      {recordingError && <div className="capture-warning" role="status">{recordingError}</div>}
    </main>
  );
}

function ReviewScreen({ selectedKeyframes, capture, scanState, processingAvailable, onProcess, onScanAgain }) {
  const preview = selectedKeyframes.find((frame) => frame.thumbnail)?.thumbnail;
  const hasVideo = Boolean(capture?.blob);
  const imageCount = countCapturedKeyframes(selectedKeyframes);
  const depthPointCount = Array.isArray(scanState?.webXRPointCloud) ? scanState.webXRPointCloud.length : 0;
  const depthFaceCount = Array.isArray(scanState?.webXRMeshFaces)
    ? scanState.webXRMeshFaces.length
    : Number(scanState?.webXRScanStats?.faceCount || 0);
  const hasDepth = depthPointCount >= 100;
  const hasCapture = hasVideo || imageCount >= 8 || hasDepth;
  const duration = capture?.durationMs ? `${Math.max(1, Math.round(capture.durationMs / 1000))}s` : hasVideo ? 'Video' : imageCount ? 'Images' : 'None';
  return (
    <main className="review-screen capture-review-screen">
      <header className="review-header"><Wordmark /><span className="review-top-label">Capture review</span></header>
      <section className="capture-review-content">
        <div className="review-preview-card">
          {capture?.url ? <video className="review-capture-video" src={capture.url} controls playsInline preload="metadata" aria-label="Recorded room capture" /> : preview ? <img src={preview} alt="Selected room viewpoint" /> : <div className="review-preview-placeholder" aria-hidden="true"><div /><span /></div>}
          <div className="review-preview-overlay"><span className="scan-live-dot" /> {hasDepth ? 'Measured depth map ready' : hasVideo ? 'Video and images ready' : hasCapture ? 'Image set ready' : 'Capture incomplete'}</div>
        </div>
        <div className="review-copy-block">
          <p className="eyebrow">Scan complete</p>
          <h1>Review your<br /><span>room capture.</span></h1>
          <p>{hasDepth ? (depthFaceCount > 0 ? 'Your measured room surface is ready. The stable depth triangles will open directly as a first-person model.' : 'Your measured depth points are ready. Scan a little longer across connected surfaces to create a room surface.') : hasCapture ? 'Your overlapping camera views are ready for server-side photogrammetry and a real room mesh.' : 'Scan more overlapping views before PolyScan can reconstruct the room.'}</p>
          <div className="review-stats" aria-label="Capture summary">
            <span><strong>{selectedKeyframes.length || 0}</strong> viewpoints</span>
            <span><strong>{imageCount}</strong> full-size images</span>
            {hasDepth && <span><strong>{depthPointCount.toLocaleString()}</strong> depth points</span>}
            {hasDepth && depthFaceCount > 0 && <span><strong>{depthFaceCount.toLocaleString()}</strong> surface triangles</span>}
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
  const [captureMode, setCaptureMode] = useState('idle');
  const [xrSession, setXrSession] = useState(null);
  const cameraRequestRef = useRef(null);
  const cameraSessionRef = useRef(0);
  const captureUrlRef = useRef(null);
  const xrSessionRef = useRef(null);
  const localModelUrlRef = useRef(null);
  const buildAbortRef = useRef(null);

  const clearCapture = useCallback(() => {
    if (captureUrlRef.current) {
      URL.revokeObjectURL(captureUrlRef.current);
      captureUrlRef.current = null;
    }
    setCapture(null);
  }, []);

  const clearLocalModel = useCallback(() => {
    if (localModelUrlRef.current) {
      URL.revokeObjectURL(localModelUrlRef.current);
      localModelUrlRef.current = null;
    }
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
    if (localModelUrlRef.current) URL.revokeObjectURL(localModelUrlRef.current);
    xrSessionRef.current?.end?.().catch?.(() => {});
    buildAbortRef.current?.abort();
  }, []);

  const endXrSession = useCallback(() => {
    const session = xrSessionRef.current;
    xrSessionRef.current = null;
    setXrSession(null);
    if (session) session.end?.().catch?.(() => {});
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

  useEffect(() => {
    xrSessionRef.current = xrSession;
    if (!xrSession) return undefined;
    const handleEnd = () => {
      if (xrSessionRef.current !== xrSession) return;
      xrSessionRef.current = null;
      setXrSession(null);
      setCameraState('idle');
      // A browser or XR runtime can end an immersive session when the tab is
      // backgrounded, the camera is interrupted, or depth sensing is paused.
      // Recover to the normal camera path instead of leaving a dead scan UI.
      if (captureMode === 'depth') {
        setCaptureMode('camera');
        requestCamera(cameraSessionRef.current);
      }
    };
    xrSession.addEventListener?.('end', handleEnd);
    return () => xrSession.removeEventListener?.('end', handleEnd);
  }, [captureMode, requestCamera, xrSession]);

  const retryCamera = useCallback(() => {
    cameraSessionRef.current += 1;
    stopCamera();
    setCaptureMode('camera');
    requestCamera(cameraSessionRef.current);
  }, [requestCamera, stopCamera]);

  const handleXrError = useCallback(() => {
    const session = xrSessionRef.current;
    xrSessionRef.current = null;
    setXrSession(null);
    session?.end?.().catch?.(() => {});
    setCaptureMode('camera');
    requestCamera(cameraSessionRef.current);
  }, [requestCamera]);

  const cancelScan = () => {
    cameraSessionRef.current += 1;
    stopCamera();
    endXrSession();
    clearLocalModel();
    setCaptureMode('idle');
    setCameraState('idle');
    setScreen('launch');
  };

  const startScan = () => {
    if (!isCameraScanDevice()) return;
    cameraSessionRef.current += 1;
    stopCamera();
    endXrSession();
    clearLocalModel();
    buildAbortRef.current?.abort();
    clearCapture();
    setReconstruction(null);
    setBuildState({ status: 'idle', progress: 0, jobId: null, error: null });
    setCameraState('requesting');
    setCaptureMode('checking-depth');
    if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
      window.DeviceOrientationEvent.requestPermission().catch(() => {});
    }
    setScanState(createEmptyScanState());
    setPaused(false);
    setScreen('scan');
    const sessionId = cameraSessionRef.current;
    if (!navigator.xr?.requestSession) {
      setCaptureMode('camera');
      requestCamera(sessionId);
      return;
    }
    requestDepthSession().then((session) => {
      if (session && cameraSessionRef.current === sessionId) {
        xrSessionRef.current = session;
        setXrSession(session);
        setCaptureMode('depth');
        setCameraState('live');
        return;
      }
      session?.end?.().catch?.(() => {});
      if (cameraSessionRef.current === sessionId) {
        setCaptureMode('camera');
        requestCamera(sessionId);
      }
    });
  };

  const finishScan = (keyframes, recordedCapture, scanSnapshot) => {
    cameraSessionRef.current += 1;
    stopCamera();
    endXrSession();
    setCameraState('idle');
    setCaptureMode('idle');
    // Commit the renderer's final snapshot before showing review. Depth
    // samples are published on a throttled cadence, so the snapshot passed
    // by ScanScreen can be newer than the last React state update.
    setScanState(scanSnapshot || createEmptyScanState());
    setSelectedKeyframes(keyframes);
    saveCapture(recordedCapture);
    setReconstruction(null);
    clearLocalModel();
    setBuildState({ status: 'idle', progress: 0, jobId: null, error: null, manifest: createCaptureManifest(scanSnapshot, keyframes) });
    // A depth cloud is input to reconstruction, not a finished room. Keeping
    // it on review prevents the old behavior where a raw curled cloud opened
    // as if it were a completed first-person room.
    setScreen('review');
  };

  const importCapture = (file) => {
    if (!file || !file.type.startsWith('video/')) return;
    cameraSessionRef.current += 1;
    stopCamera();
    endXrSession();
    clearLocalModel();
    setCaptureMode('idle');
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
    const pointCloud = Array.isArray(scanState.webXRPointCloud) ? scanState.webXRPointCloud : [];
    const faces = Array.isArray(scanState.webXRMeshFaces) ? scanState.webXRMeshFaces : [];
    const hasDepth = pointCloud.length >= 100;
    if (!capture?.blob && imageCount < 8 && !hasDepth) {
      setBuildState({ status: 'error', progress: 0, jobId: null, error: 'Scan more of the room before building. A depth scan needs at least 100 measured points, or eight full-size viewpoints.', manifest });
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
      pointCloud,
      faces,
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
        captureMode={captureMode}
        xrSession={xrSession}
        onXrError={handleXrError}
        onPause={() => setPaused((value) => !value)}
        onDone={finishScan}
        onRetryCamera={retryCamera}
        onCancel={cancelScan}
        onImportCapture={importCapture}
        onScanStateChange={setScanState}
      />
    );
  } else if (screen === 'review') {
    activeScreen = <ReviewScreen selectedKeyframes={selectedKeyframes} capture={capture} scanState={scanState} processingAvailable={hasReconstructionEndpoint()} onProcess={startBuild} onScanAgain={startScan} />;
  } else if (screen === 'processing') {
    activeScreen = <ProcessingScreen buildState={buildState} onOpenViewer={openViewer} onRetry={startBuild} onBack={backToReview} />;
  } else activeScreen = <RoomViewerScreen selectedKeyframes={selectedKeyframes} reconstruction={reconstruction} onBack={() => setScreen('review')} />;

  return <div className={`App${xrSession ? ' is-xr-scan' : ''}`}>{activeScreen}</div>;
}

export { App, RoomViewerScreen, ScanScreen, createEmptyScanState, isMobileScanDevice };
export default App;
