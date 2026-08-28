import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  DEFAULT_VIEWPOINT_THRESHOLDS,
  coverageOpacity,
  createDirectionalCoverage,
  getVisibleCellIds,
  isReconstructionViable,
  selectBestKeyframes,
  updateDirectionalCoverage,
} from './scanner/coverageModel';
import {
  buildFrameEvidence,
  extractFrameFeatures,
  updateFeatureTracks,
} from './scanner/featureTracking';

const CAPTURE_INTERVAL_MS = 520;
const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 240;

const createEmptyScanState = () => ({
  directionalCoverage: createDirectionalCoverage(),
  cameraKeyframes: [],
  featureTracks: [],
  distinctViewpoints: 0,
  meaningfulCameraMotion: false,
  sparsePoints: [],
  surfacePatches: [],
  stableFeatures: [],
  lastFrame: null,
  lastViewpoint: null,
  lastEvidence: null,
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

function CoverageCanvas({
  cells,
  mappingReady,
  view,
  stableFeatures,
  sparsePoints,
  surfacePatches,
  parallax,
}) {
  const canvasRef = useRef(null);
  const coverageTargetsRef = useRef(new Map());
  const displayedRef = useRef(new Map());

  useEffect(() => {
    coverageTargetsRef.current = new Map(cells.map((cell) => [cell.id, cell.coverage]));
  }, [cells]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let frameId;
    let active = true;

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
    };

    const drawTrackedFeatures = (context, width, height) => {
      const visible = stableFeatures.filter((feature) => feature.confidence >= 0.42);
      context.save();
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(209, 245, 255, 0.16)';
      for (let index = 0; index < visible.length; index += 1) {
        for (let nextIndex = index + 1; nextIndex < visible.length; nextIndex += 1) {
          const first = visible[index];
          const second = visible[nextIndex];
          const distance = Math.hypot(first.x - second.x, first.y - second.y);
          if (distance < 0.18) {
            context.beginPath();
            context.moveTo(first.x * width, first.y * height);
            context.lineTo(second.x * width, second.y * height);
            context.stroke();
          }
        }
      }

      visible.forEach((feature) => {
        const x = feature.x * width;
        const y = feature.y * height;
        const radius = 2.5 + Math.min(feature.confidence, 1) * 2;
        context.beginPath();
        context.arc(x, y, radius + 4, 0, Math.PI * 2);
        context.strokeStyle = 'rgba(193, 242, 255, 0.18)';
        context.stroke();
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = 'rgba(230, 250, 255, 0.86)';
        context.fill();
      });
      context.restore();
    };

    const drawGeometry = (context, width, height) => {
      context.save();
      surfacePatches
        .filter((patch) => patch.confidence >= 0.64 && patch.screenVertices)
        .forEach((patch) => {
          context.beginPath();
          patch.screenVertices.forEach((vertex, index) => {
            const x = vertex.x * width;
            const y = vertex.y * height;
            if (index === 0) context.moveTo(x, y);
            else context.lineTo(x, y);
          });
          context.closePath();
          context.fillStyle = 'rgba(194, 238, 255, 0.13)';
          context.strokeStyle = 'rgba(219, 249, 255, 0.42)';
          context.lineWidth = 1;
          context.fill();
          context.stroke();
        });

      sparsePoints
        .filter((point) => point.confidence >= 0.62 && point.screen)
        .forEach((point) => {
          const x = point.screen.x * width;
          const y = point.screen.y * height;
          context.beginPath();
          context.arc(x, y, 7, 0, Math.PI * 2);
          context.strokeStyle = 'rgba(218, 249, 255, 0.28)';
          context.stroke();
          context.beginPath();
          context.arc(x, y, 2.4, 0, Math.PI * 2);
          context.fillStyle = 'rgba(233, 252, 255, 0.95)';
          context.fill();
        });
      context.restore();
    };

    const draw = () => {
      if (!active) return;
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const context = canvas.getContext('2d');
      if (!context || !width || !height) {
        frameId = window.requestAnimationFrame(draw);
        return;
      }

      if (canvas.width !== Math.round(width * pixelRatio) || canvas.height !== Math.round(height * pixelRatio)) {
        resizeCanvas();
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      if (!mappingReady) {
        const initialWash = context.createLinearGradient(0, 0, width, height);
        initialWash.addColorStop(0, 'rgba(24, 93, 246, 0.46)');
        initialWash.addColorStop(0.55, 'rgba(33, 115, 255, 0.56)');
        initialWash.addColorStop(1, 'rgba(19, 62, 188, 0.48)');
        context.fillStyle = initialWash;
        context.fillRect(0, 0, width, height);
      } else {
        const yawBins = cells[0]?.yawBins || 20;
        const yawSize = 360 / yawBins;
        cells.forEach((cell) => {
          const coverageTarget = coverageTargetsRef.current.get(cell.id) ?? cell.coverage;
          const current = displayedRef.current.get(cell.id) ?? 0;
          const next = current + (coverageTarget - current) * 0.14;
          displayedRef.current.set(cell.id, Math.abs(coverageTarget - next) < 0.002 ? coverageTarget : next);

          const cellYaw = cell.yawIndex * yawSize + yawSize / 2;
          const yawDelta = ((cellYaw - view.yaw + 540) % 360) - 180;
          const pitchSize = 46;
          const pitchCenter = cell.pitchBand === 0 ? 24 : cell.pitchBand === 1 ? 0 : -24;
          const x = width / 2 + (yawDelta / 82) * width;
          const y = height / 2 - ((pitchCenter - view.pitch) / 58) * height;
          const cellWidth = width * (yawSize / 82) * 1.08;
          const cellHeight = height * (pitchSize / 58) * 1.08;
          if (x + cellWidth < 0 || x - cellWidth > width || y + cellHeight < 0 || y - cellHeight > height) return;

          const coverage = displayedRef.current.get(cell.id) ?? 0;
          const opacity = coverageOpacity(coverage);
          context.fillStyle = `rgba(37, 105, 255, ${opacity})`;
          context.fillRect(x - cellWidth / 2, y - cellHeight / 2, cellWidth, cellHeight);
        });
      }

      if (parallax > 0.04) {
        context.fillStyle = `rgba(169, 233, 255, ${Math.min(0.08, parallax * 0.18)})`;
        context.fillRect(0, 0, width, height);
      }

      drawTrackedFeatures(context, width, height);
      drawGeometry(context, width, height);
      frameId = window.requestAnimationFrame(draw);
    };

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    draw();
    return () => {
      active = false;
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', resizeCanvas);
    };
  }, [cells, mappingReady, parallax, sparsePoints, stableFeatures, surfacePatches, view]);

  return <canvas ref={canvasRef} className="coverage-canvas" data-coverage-state={mappingReady ? 'directional' : 'initial-blue'} aria-hidden="true" />;
}

function LaunchScreen({ onStart }) {
  return (
    <main className="launch-screen">
      <header className="launch-header">
        <Wordmark />
        <span className="launch-kicker">Phone web room capture</span>
      </header>

      <section className="launch-content">
        <div className="launch-copy">
          <p className="eyebrow">Spatial camera</p>
          <h1>See the room<br /><span>take shape.</span></h1>
          <p className="launch-description">
            Move through the space and watch the blue field clear as useful viewpoints accumulate.
          </p>
          <button type="button" className="primary-action" onClick={onStart}>
            <span>Start scan</span>
            <span className="action-arrow" aria-hidden="true">↗</span>
          </button>
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
          <div className="visual-caption">Coverage follows the room, not a checklist.</div>
        </div>
      </section>

      <footer className="launch-footer">
        <span className="footer-signal"><span className="signal-dot" /> Camera-led mapping</span>
        <span>Browser-native foundation</span>
      </footer>
    </main>
  );
}

function ScanScreen({ scanState, paused, onPause, onDone, onScanStateChange }) {
  const videoRef = useRef(null);
  const analysisCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const scanRef = useRef(createEmptyScanState());
  const [view, setView] = useState({ yaw: 0, pitch: 0 });
  const [orientation, setOrientation] = useState({ yaw: 0, pitch: 0 });
  const [mapVersion, setMapVersion] = useState(0);
  const [cameraState, setCameraState] = useState('starting');
  const [trackingState, setTrackingState] = useState('searching');
  const [cameraMessage, setCameraMessage] = useState('Starting camera');

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    const requestCamera = async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraState('unavailable');
        setCameraMessage('Camera preview unavailable');
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (!mounted) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraState('live');
        setCameraMessage('Camera live');
      } catch (error) {
        if (mounted) {
          setCameraState('unavailable');
          setCameraMessage('Camera preview unavailable');
        }
      }
    };

    requestCamera();
    return () => {
      mounted = false;
      stopCamera();
    };
  }, [stopCamera]);

  useEffect(() => {
    if (!window.DeviceOrientationEvent) return undefined;
    const handleOrientation = (event) => {
      const yaw = Number.isFinite(event.alpha) ? event.alpha : 0;
      const pitch = Number.isFinite(event.beta) ? Math.max(-58, Math.min(58, event.beta - 90)) : 0;
      setOrientation({ yaw, pitch });
    };
    window.addEventListener('deviceorientation', handleOrientation, true);
    return () => window.removeEventListener('deviceorientation', handleOrientation, true);
  }, []);

  useEffect(() => {
    scanRef.current = scanState;
  }, [scanState]);

  useEffect(() => {
    if (paused) return undefined;

    const captureFrame = () => {
      const video = videoRef.current;
      const canvas = analysisCanvasRef.current;
      if (!video || !canvas || video.readyState < 2 || !video.videoWidth) return;
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
      const evidence = buildFrameEvidence({
        previousFrame: current.lastFrame,
        currentFrame,
        orientation,
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

      const nextKeyframes = evidence.tracking
        ? [...current.cameraKeyframes, {
          id: `keyframe-${current.cameraKeyframes.length + 1}`,
          timestamp: currentFrame.timestamp,
          viewpoint: evidence.viewpoint,
          featureCount: currentFrame.features.length,
          stableTrackCount: evidence.stableTrackCount,
          sharpness: currentFrame.features.reduce((sum, feature) => sum + feature.score, 0),
          image: currentFrame,
        }]
        : current.cameraKeyframes;

      const nextState = {
        ...current,
        directionalCoverage: nextCoverage,
        cameraKeyframes: nextKeyframes,
        featureTracks,
        distinctViewpoints: current.distinctViewpoints + (evidence.usefulViewpoint ? 1 : 0),
        meaningfulCameraMotion: current.meaningfulCameraMotion || evidence.usefulViewpoint,
        stableFeatures: evidence.stableFeatures,
        lastFrame: { ...currentFrame, viewpoint: evidence.viewpoint },
        lastViewpoint: evidence.viewpoint,
        lastEvidence: evidence,
      };
      scanRef.current = nextState;
      onScanStateChange(nextState);
      setTrackingState(evidence.tracking ? 'tracking' : current.lastFrame ? 'lost' : 'searching');
      setView({ yaw: orientation.yaw, pitch: orientation.pitch });
      setMapVersion((version) => version + 1);
    };

    const timer = window.setInterval(captureFrame, CAPTURE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [onScanStateChange, orientation, paused]);

  const keyframeCount = scanState.cameraKeyframes.length;
  const stableTrackCount = scanState.featureTracks.filter((track) => track.observations.length >= 2).length;
  const viable = isReconstructionViable({
    keyframes: keyframeCount,
    distinctViewpoints: scanState.distinctViewpoints,
    featureTracks: stableTrackCount,
    meaningfulCameraMotion: scanState.meaningfulCameraMotion,
  });
  const mappingReady = keyframeCount > 0;
  const instruction = paused
    ? 'Paused'
    : trackingState === 'lost'
      ? 'Look at a scanned area'
      : mappingReady
        ? 'Scan the blue areas'
        : 'Move around the room';
  const statusLabel = trackingState === 'lost'
    ? 'Tracking lost'
    : cameraState === 'unavailable'
      ? 'Preview only'
      : trackingState === 'tracking'
        ? 'Tracking'
        : 'Searching';

  return (
    <main className="scan-screen">
      <video ref={videoRef} className="camera-video" autoPlay playsInline muted aria-label="Live room camera" />
      <CameraPlaceholder />
      <CoverageCanvas
        cells={scanState.directionalCoverage}
        mappingReady={mappingReady}
        view={view}
        stableFeatures={scanState.stableFeatures}
        sparsePoints={scanState.sparsePoints}
        surfacePatches={scanState.surfacePatches}
        parallax={scanState.lastEvidence?.parallax || 0}
      />
      <canvas ref={analysisCanvasRef} className="analysis-canvas" aria-hidden="true" />

      <header className="scan-hud">
        <Wordmark compact />
        <div className={`tracking-status tracking-${trackingState}`} aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
      </header>

      <div className="camera-corners" aria-hidden="true">
        <span className="corner corner-top-left" />
        <span className="corner corner-top-right" />
        <span className="corner corner-bottom-left" />
        <span className="corner corner-bottom-right" />
      </div>

      <div className="scan-bottom-ui">
        <div className="scan-guidance" role="status" aria-live="polite">
          <span className="guidance-mark" aria-hidden="true">+</span>
          <span>{instruction}</span>
          {cameraMessage === 'Camera preview unavailable' && <small>Use a supported phone browser for live capture.</small>}
        </div>

        <div className="scan-controls">
          <button type="button" className="control-button pause-button" onClick={onPause}>
            <span className="pause-icon" aria-hidden="true">{paused ? '▶' : 'Ⅱ'}</span>
            <span>{paused ? 'Resume' : 'Pause'}</span>
          </button>
          <button
            type="button"
            className="control-button done-button"
            onClick={() => onDone(selectBestKeyframes(scanState.cameraKeyframes))}
            disabled={!viable}
            aria-label={viable ? 'Done scanning' : 'Done scanning, waiting for basic map'}
          >
            <span>Done</span>
            <span className="done-arrow" aria-hidden="true">↗</span>
          </button>
        </div>
      </div>
      <span className="capture-note" aria-hidden="true">{mapVersion > 0 && 'Local map active'}</span>
    </main>
  );
}

function ReviewScreen({ selectedKeyframes, onProcess, onScanAgain }) {
  return (
    <main className="review-screen">
      <header className="review-header"><Wordmark /></header>
      <section className="review-content">
      <div className="review-icon" aria-hidden="true"><span /><span /><span /></div>
        <p className="eyebrow">Capture held</p>
        <h1>Ready to process.</h1>
        <p>
          PolyScan will use the strongest viewpoints you captured. Areas you did not visit will stay open for reconstruction.
        </p>
        <div className="review-actions">
          <button type="button" className="primary-action" onClick={onProcess}>
            <span>Process scan</span>
            <span className="action-arrow" aria-hidden="true">↗</span>
          </button>
          <button type="button" className="text-action" onClick={onScanAgain}>Scan again</button>
        </div>
        <span className="review-footnote">{selectedKeyframes.length ? 'Best viewpoints held locally for the next step.' : 'No keyframes were captured yet.'}</span>
      </section>
    </main>
  );
}

function ProcessingScreen({ onBack }) {
  return (
    <main className="processing-screen">
      <header className="review-header"><Wordmark /></header>
      <section className="processing-content">
        <div className="processing-orbit" aria-hidden="true"><span /><span /><span /></div>
        <p className="eyebrow">Reconstruction handoff</p>
        <h1>Your room is<br /><span>ready to build.</span></h1>
        <p>The capture is held without inventing the regions you did not scan. Connect the reconstruction service to create the final model.</p>
        <button type="button" className="text-action" onClick={onBack}>Back to start</button>
      </section>
    </main>
  );
}

function App() {
  const [screen, setScreen] = useState('launch');
  const [paused, setPaused] = useState(false);
  const [scanState, setScanState] = useState(createEmptyScanState);
  const [selectedKeyframes, setSelectedKeyframes] = useState([]);

  const startScan = () => {
    if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
      window.DeviceOrientationEvent.requestPermission().catch(() => {});
    }
    setScanState(createEmptyScanState());
    setPaused(false);
    setScreen('scan');
  };

  const finishScan = (keyframes) => {
    setSelectedKeyframes(keyframes);
    setScreen('review');
  };

  const activeScreen = useMemo(() => {
    if (screen === 'launch') return <LaunchScreen onStart={startScan} />;
    if (screen === 'scan') {
      return (
        <ScanScreen
          scanState={scanState}
          paused={paused}
          onPause={() => setPaused((value) => !value)}
          onDone={finishScan}
          onScanStateChange={setScanState}
        />
      );
    }
    if (screen === 'review') {
      return <ReviewScreen selectedKeyframes={selectedKeyframes} onProcess={() => setScreen('processing')} onScanAgain={startScan} />;
    }
    return <ProcessingScreen onBack={() => setScreen('launch')} />;
  }, [paused, scanState, screen, selectedKeyframes]);

  return <div className="App">{activeScreen}</div>;
}

export { App, ScanScreen, createEmptyScanState };
export default App;
