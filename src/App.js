import { useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import {
  DEFAULT_VIEWPOINT_THRESHOLDS,
  createDirectionalCoverage,
  coverageOpacity,
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
import {
  createCaptureManifest,
  getReconstructionJob,
  hasReconstructionEndpoint,
  submitCapture,
} from './scanner/reconstructionClient';

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

    const projectCell = (cell, width, height) => {
      const yawBins = cells[0]?.yawBins || 20;
      const yawSize = 360 / yawBins;
      const cellYaw = cell.yawIndex * yawSize + yawSize / 2;
      const yawDelta = ((cellYaw - view.yaw + 540) % 360) - 180;
      const pitchCenter = cell.pitchBand === 0 ? 24 : cell.pitchBand === 1 ? 0 : -24;
      const inCurrentView = Math.abs(yawDelta) <= 45 && Math.abs(pitchCenter - view.pitch) <= 34;
      if (!inCurrentView) return null;

      const centerX = width / 2 + (yawDelta / 78) * width;
      const centerY = height / 2 - ((pitchCenter - view.pitch) / 58) * height;
      const cellWidth = width * (yawSize / 78) * 1.01;
      const cellHeight = height / 3.02;
      if (centerX + cellWidth / 2 < 0 || centerX - cellWidth / 2 > width || centerY + cellHeight / 2 < 0 || centerY - cellHeight / 2 > height) return null;
      return {
        left: centerX - cellWidth / 2,
        top: centerY - cellHeight / 2,
        right: centerX + cellWidth / 2,
        bottom: centerY + cellHeight / 2,
        width: cellWidth,
        height: cellHeight,
      };
    };

    const drawCoverageRegions = (context, width, height) => {
      context.save();
      if (!mappingReady) {
        context.fillStyle = 'rgba(25, 151, 235, .42)';
        context.fillRect(0, 0, width, height);
      }

      cells.forEach((cell) => {
        const projection = projectCell(cell, width, height);
        if (!projection) return;
        const coverage = displayedRef.current.get(cell.id) ?? cell.coverage;
        const opacity = coverageOpacity(coverage);
        if (opacity <= 0) return;
        context.fillStyle = `rgba(28, 157, 237, ${opacity})`;
        context.fillRect(projection.left, projection.top, projection.width, projection.height);
        if (coverage < 0.9) {
          context.strokeStyle = `rgba(152, 231, 255, ${Math.max(.12, opacity * .72)})`;
          context.lineWidth = 0.7;
          context.strokeRect(projection.left, projection.top, projection.width, projection.height);
        }
      });
      context.restore();
    };

    const drawMappedWireframe = (context, width, height) => {
      if (!mappingReady) return;
      context.save();
      cells.forEach((cell) => {
        const coverage = displayedRef.current.get(cell.id) ?? cell.coverage;
        if (coverage < 0.2) return;
        const projection = projectCell(cell, width, height);
        if (!projection) return;

        // This is a confidence-linked directional scaffold, not fabricated room mesh.
        // It gives the user spatial feedback until real triangulated geometry is available.
        const insetX = projection.width * 0.1;
        const insetY = projection.height * 0.12;
        const depthX = projection.width * 0.08;
        const depthY = projection.height * 0.09;
        const front = [
          { x: projection.left, y: projection.top },
          { x: projection.right, y: projection.top },
          { x: projection.right, y: projection.bottom },
          { x: projection.left, y: projection.bottom },
        ];
        const back = front.map((point) => ({
          x: point.x + (point.x < width / 2 ? insetX : -insetX) + depthX,
          y: point.y + insetY - depthY,
        }));
        const alpha = Math.min(0.72, 0.22 + coverage * 0.62);
        context.strokeStyle = `rgba(209, 247, 255, ${alpha})`;
        context.lineWidth = coverage >= 0.66 ? 1.1 : 0.8;

        const drawLoop = (points) => {
          context.beginPath();
          points.forEach((point, index) => {
            if (index === 0) context.moveTo(point.x, point.y);
            else context.lineTo(point.x, point.y);
          });
          context.closePath();
          context.stroke();
        };
        drawLoop(front);
        drawLoop(back);
        front.forEach((point, index) => {
          context.beginPath();
          context.moveTo(point.x, point.y);
          context.lineTo(back[index].x, back[index].y);
          context.stroke();
        });
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

      cells.forEach((cell) => {
        const coverageTarget = coverageTargetsRef.current.get(cell.id) ?? cell.coverage;
        const current = displayedRef.current.get(cell.id) ?? 0;
        const next = current + (coverageTarget - current) * 0.14;
        displayedRef.current.set(cell.id, Math.abs(coverageTarget - next) < 0.002 ? coverageTarget : next);
      });

      if (parallax > 0.04) {
        context.fillStyle = `rgba(169, 233, 255, ${Math.min(0.08, parallax * 0.18)})`;
        context.fillRect(0, 0, width, height);
      }

      drawCoverageRegions(context, width, height);
      drawMappedWireframe(context, width, height);
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

function CoverageMap({ cells, view, paused, trackingState }) {
  const visibleIds = new Set(getVisibleCellIds({ yaw: view.yaw, pitch: view.pitch, yawBins: 20 }));
  const scannedCells = cells.filter((cell) => cell.coverage >= 0.2).length;
  const visibleUnscanned = cells.filter((cell) => visibleIds.has(cell.id) && cell.coverage < 0.2).length;
  const hint = paused
    ? 'Scan paused'
    : trackingState === 'lost'
      ? 'Aim at an edge or corner'
      : !scannedCells
        ? 'Move slowly. Blue areas are still unscanned'
        : visibleUnscanned
          ? 'Move toward the blue areas'
          : 'Mapped areas stay in the camera color';
  const pitchLabels = ['Ceiling', 'Walls', 'Floor'];

  return (
    <aside className="coverage-map-card" aria-label="Directional room coverage map">
      <div className="coverage-map-header">
        <div><span className="coverage-map-kicker">Room map</span><strong>Blue to scan</strong></div>
        <div className="coverage-map-live-label">Live</div>
      </div>
      <div className="coverage-map-surfaces">
        {pitchLabels.map((label, pitchBand) => (
          <div className="coverage-map-surface" key={label}>
            <span className="coverage-map-surface-label">{label}</span>
            <div className="coverage-map-grid">
              {cells.filter((cell) => cell.pitchBand === pitchBand).map((cell) => (
                <span
                  key={cell.id}
                  className={`coverage-map-cell coverage-${cell.status || 'unknown'}${visibleIds.has(cell.id) ? ' is-current' : ''}`}
                  style={{ '--coverage': cell.coverage }}
                  title={`${cell.status || 'unknown'} scan zone`}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="coverage-map-hint"><span className="coverage-map-hint-icon">+</span><span>{hint}</span></div>
      <div className="coverage-map-footer">
        <span><i className="coverage-legend-dot is-unscanned" /> to capture</span>
        <span><i className="coverage-legend-dot is-filled" /> scanned</span>
      </div>
    </aside>
  );
}

function RoomModelCanvas({ rotation, zoom, frameIndex, hasCapture, firstPerson = false }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      if (!width || !height) return;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      context.clearRect(0, 0, width, height);
      if (!hasCapture) {
        const background = context.createLinearGradient(0, 0, 0, height);
        background.addColorStop(0, '#111b2a');
        background.addColorStop(0.54, '#172a43');
        background.addColorStop(1, '#07111f');
        context.fillStyle = background;
        context.fillRect(0, 0, width, height);
        const glow = context.createRadialGradient(width * 0.52, height * 0.36, 4, width * 0.52, height * 0.36, width * 0.66);
        glow.addColorStop(0, 'rgba(79, 174, 255, .22)');
        glow.addColorStop(1, 'rgba(79, 174, 255, 0)');
        context.fillStyle = glow;
        context.fillRect(0, 0, width, height);
      } else {
        context.fillStyle = 'rgba(3, 12, 21, .2)';
        context.fillRect(0, 0, width, height);
      }

      const angle = (rotation * Math.PI) / 180;
      const focal = Math.min(width, height) * 0.82 * zoom;
      const cameraDepth = firstPerson ? 3.15 : 5.8;
      const cameraHeight = firstPerson ? 1.42 : 0;
      const project = ({ x, y, z }) => {
        const rotatedX = x * Math.cos(angle) - z * Math.sin(angle);
        const rotatedZ = x * Math.sin(angle) + z * Math.cos(angle);
        const depth = Math.max(0.72, cameraDepth + rotatedZ);
        const scale = focal / depth;
        return { x: width / 2 + rotatedX * scale, y: height * 0.53 - (y - cameraHeight) * scale };
      };
      const line = (points, color, lineWidth = 1) => {
        context.beginPath();
        points.forEach((point, index) => {
          const projected = project(point);
          if (index === 0) context.moveTo(projected.x, projected.y);
          else context.lineTo(projected.x, projected.y);
        });
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.stroke();
      };
      const fill = (points, color, stroke = 'rgba(184, 235, 255, .35)') => {
        context.beginPath();
        points.forEach((point, index) => {
          const projected = project(point);
          if (index === 0) context.moveTo(projected.x, projected.y);
          else context.lineTo(projected.x, projected.y);
        });
        context.closePath();
        context.fillStyle = color;
        context.fill();
        context.strokeStyle = stroke;
        context.lineWidth = 1;
        context.stroke();
      };

      const floor = [{ x: -2.6, y: 0, z: -1.9 }, { x: 2.6, y: 0, z: -1.9 }, { x: 2.6, y: 0, z: 2.1 }, { x: -2.6, y: 0, z: 2.1 }];
      const backWall = [{ x: -2.6, y: 0, z: -1.9 }, { x: 2.6, y: 0, z: -1.9 }, { x: 2.6, y: 2.65, z: -1.9 }, { x: -2.6, y: 2.65, z: -1.9 }];
      const leftWall = [{ x: -2.6, y: 0, z: 2.1 }, { x: -2.6, y: 0, z: -1.9 }, { x: -2.6, y: 2.65, z: -1.9 }, { x: -2.6, y: 2.65, z: 2.1 }];
      fill(floor, 'rgba(21, 95, 153, .18)', 'rgba(157, 224, 255, .32)');
      fill(backWall, 'rgba(40, 120, 173, .13)', 'rgba(178, 233, 255, .42)');
      fill(leftWall, 'rgba(13, 77, 129, .14)', 'rgba(151, 220, 255, .28)');

      for (let x = -2.5; x <= 2.5; x += 0.5) line([{ x, y: 0, z: -1.9 }, { x, y: 0, z: 2.1 }], 'rgba(165, 224, 255, .18)');
      for (let z = -1.7; z <= 2; z += 0.45) line([{ x: -2.6, y: 0, z }, { x: 2.6, y: 0, z }], 'rgba(165, 224, 255, .16)');
      for (let y = 0.45; y < 2.65; y += 0.45) line([{ x: -2.6, y, z: -1.9 }, { x: 2.6, y, z: -1.9 }], 'rgba(165, 224, 255, .13)');
      line([{ x: -2.6, y: 0, z: -1.9 }, { x: 2.6, y: 0, z: -1.9 }, { x: 2.6, y: 2.65, z: -1.9 }, { x: -2.6, y: 2.65, z: -1.9 }, { x: -2.6, y: 0, z: -1.9 }], 'rgba(220, 249, 255, .62)', 1.4);

      fill([{ x: -1.35, y: 0.38, z: -1.87 }, { x: 0.9, y: 0.38, z: -1.87 }, { x: 0.9, y: 1.55, z: -1.87 }, { x: -1.35, y: 1.55, z: -1.87 }], 'rgba(80, 180, 234, .13)', 'rgba(189, 241, 255, .6)');
      fill([{ x: 1.42, y: 0.2, z: 0.2 }, { x: 2.15, y: 0.2, z: 0.2 }, { x: 2.15, y: 0.82, z: 0.2 }, { x: 1.42, y: 0.82, z: 0.2 }], 'rgba(62, 161, 224, .2)', 'rgba(178, 231, 255, .5)');

      for (let index = 0; index < 82; index += 1) {
        const wave = index * 1.731;
        const point = {
          x: -2.45 + ((index * 37) % 100) / 100 * 4.9 + Math.sin(wave) * 0.035,
          y: 0.12 + ((index * 19) % 92) / 100 * 2.35 + Math.cos(wave) * 0.035,
          z: -1.82 + ((index * 53) % 100) / 100 * 3.75,
        };
        const projected = project(point);
        if (projected.x < -10 || projected.x > width + 10 || projected.y < -10 || projected.y > height + 10) continue;
        context.beginPath();
        context.arc(projected.x, projected.y, index % 5 === frameIndex % 5 ? 2.2 : 1.2, 0, Math.PI * 2);
        context.fillStyle = index % 5 === frameIndex % 5 ? 'rgba(236, 253, 255, .95)' : 'rgba(113, 207, 255, .7)';
        context.fill();
      }

      const scanY = 0.35 + ((frameIndex % 52) / 52) * 2.1;
      line([{ x: -2.55, y: scanY, z: -1.94 }, { x: 2.55, y: scanY, z: -1.94 }], 'rgba(222, 251, 255, .48)', 1.3);
    };
    draw();
    const onResize = () => draw();
    const resizeObserver = window.ResizeObserver ? new ResizeObserver(onResize) : null;
    resizeObserver?.observe(canvas);
    window.addEventListener('resize', onResize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [firstPerson, frameIndex, hasCapture, rotation, zoom]);

  return <canvas ref={canvasRef} className="room-model-canvas" aria-label="Interactive room scan model" />;
}

function RoomViewerScreen({ selectedKeyframes, reconstruction, onBack }) {
  const [frameIndex, setFrameIndex] = useState(1);
  const [rotation, setRotation] = useState(-13);
  const [zoom, setZoom] = useState(1);
  const [activeTool, setActiveTool] = useState('mesh');
  const [menuOpen, setMenuOpen] = useState(false);
  const dragRef = useRef(null);
  const totalFrames = 172;
  const activeFrameIndex = selectedKeyframes.length
    ? Math.min(selectedKeyframes.length - 1, Math.round(((frameIndex - 1) / (totalFrames - 1)) * (selectedKeyframes.length - 1)))
    : -1;
  const activeFrame = activeFrameIndex >= 0 ? selectedKeyframes[activeFrameIndex] : null;
  const captureImage = activeFrame?.thumbnail || null;
  const remoteViewerUrl = reconstruction?.viewerUrl || reconstruction?.viewer?.url || null;
  const showModel = !remoteViewerUrl && activeTool !== 'camera' && activeTool !== 'video';
  const modeCopy = {
    mesh: ['Mesh view', 'Drag to rotate the room model'],
    walk: ['Walk view', 'Drag across the room to look around'],
    camera: ['Captured view', captureImage ? `Viewpoint ${activeFrameIndex + 1} of ${selectedKeyframes.length}` : 'No captured image is available'],
    layers: ['Scan layers', 'Captured views and the room model are visible'],
    measure: ['Measure', 'Tap two points, then confirm the real distance'],
    views: ['Saved views', 'Use the timeline to move between viewpoints'],
    comment: ['Comment', 'Choose a saved viewpoint to discuss'],
    video: ['Capture video', captureImage ? 'Showing the selected camera frame' : 'No captured image is available'],
  }[activeTool] || ['Room model', 'Drag to rotate the room model'];
  const [measurement, setMeasurement] = useState({ start: null, end: null });
  const [measurementInput, setMeasurementInput] = useState('');
  const [confirmedMeasurement, setConfirmedMeasurement] = useState(null);

  const handlePointerDown = (event) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, rotation };
  };
  const handlePointerMove = (event) => {
    if (!dragRef.current || activeTool === 'measure') return;
    const delta = event.clientX - dragRef.current.x;
    setRotation(Math.max(-58, Math.min(58, dragRef.current.rotation + delta * 0.18)));
  };
  const handlePointerUp = () => { dragRef.current = null; };
  const handleStageClick = (event) => {
    if (activeTool !== 'measure') return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const point = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
    setMeasurement((current) => current.start && current.end ? { start: point, end: null } : current.start ? { ...current, end: point } : { start: point, end: null });
    setMeasurementInput('');
    setConfirmedMeasurement(null);
  };
  const handleWheel = (event) => {
    event.preventDefault();
    setZoom((value) => Math.max(0.78, Math.min(1.35, value - event.deltaY * 0.0008)));
  };
  const resetViewer = () => {
    setFrameIndex(1);
    setRotation(-13);
    setZoom(1);
    setMeasurement({ start: null, end: null });
    setMeasurementInput('');
    setConfirmedMeasurement(null);
    setMenuOpen(false);
  };
  const handleToolChange = (tool) => {
    setActiveTool(tool);
    if (tool !== 'measure') {
      setMeasurement({ start: null, end: null });
      setMeasurementInput('');
      setConfirmedMeasurement(null);
    }
  };
  const confirmMeasurement = (event) => {
    event.preventDefault();
    const distance = Number(measurementInput);
    if (measurement.start && measurement.end && Number.isFinite(distance) && distance > 0) setConfirmedMeasurement(distance);
  };
  const exportScan = () => {
    const payload = JSON.stringify({ format: 'polyscan-room-viewer', frames: totalFrames, viewpoints: selectedKeyframes.length, createdAt: new Date().toISOString() }, null, 2);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    link.download = 'polyscan-room-scan.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
  };

  return (
    <main className="room-viewer-screen">
      <section className="viewer-stage" aria-label={activeTool === 'measure' ? 'Room measurement tool' : 'Room viewer'} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerCancel={() => { dragRef.current = null; }} onClick={handleStageClick} onWheel={handleWheel}>
        {remoteViewerUrl && <iframe className="viewer-remote-frame" src={remoteViewerUrl} title="First-person reconstructed room viewer" allow="fullscreen; xr-spatial-tracking" style={{ pointerEvents: activeTool === 'measure' ? 'none' : 'auto' }} />}
        {!remoteViewerUrl && captureImage && <img className="viewer-capture-image" src={captureImage} alt={`Captured room viewpoint ${activeFrameIndex + 1}`} />}
        {showModel && <RoomModelCanvas rotation={rotation} zoom={zoom} frameIndex={frameIndex} hasCapture={Boolean(captureImage)} firstPerson={activeTool === 'walk'} />}
        <div className="viewer-vignette" aria-hidden="true" />
        <div className="viewer-crosshair" aria-hidden="true"><span /></div>
        <div className="viewer-stage-caption"><span className="scan-live-dot" /> {modeCopy[0]}</div>
        <div className="viewer-mode-hint"><strong>{modeCopy[0]}</strong><span>{modeCopy[1]}</span></div>
        {!captureImage && !remoteViewerUrl && <div className="viewer-empty-note">This scan has no saved camera image. The model preview is still interactive.</div>}
        {activeTool === 'measure' && (
          <>
            <svg className="viewer-measure-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              {measurement.start && measurement.end && <line x1={measurement.start.x * 100} y1={measurement.start.y * 100} x2={measurement.end.x * 100} y2={measurement.end.y * 100} />}
              {measurement.start && <circle cx={measurement.start.x * 100} cy={measurement.start.y * 100} r="1.7" />}
              {measurement.end && <circle cx={measurement.end.x * 100} cy={measurement.end.y * 100} r="1.7" />}
            </svg>
            <div className="viewer-measure-panel" role="status" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
              <strong>Confirm a measurement</strong>
              {!measurement.start && <span>Tap the first point on the room.</span>}
              {measurement.start && !measurement.end && <span>Tap the second point.</span>}
              {measurement.start && measurement.end && !confirmedMeasurement && (
                <form onSubmit={confirmMeasurement}>
                  <label htmlFor="measurement-distance">Real distance</label>
                  <div className="measurement-input-row"><input id="measurement-distance" type="number" min="0.01" step="0.01" inputMode="decimal" value={measurementInput} onChange={(event) => setMeasurementInput(event.target.value)} placeholder="e.g. 3.20" /><span>m</span></div>
                  <button type="submit" disabled={!measurementInput}>Confirm measurement</button>
                </form>
              )}
              {confirmedMeasurement && <span className="measurement-confirmed">{confirmedMeasurement} m confirmed</span>}
              {(measurement.start || measurement.end) && <button type="button" className="measurement-clear" onClick={() => { setMeasurement({ start: null, end: null }); setMeasurementInput(''); setConfirmedMeasurement(null); }}>Clear points</button>}
            </div>
          </>
        )}
        <div className="viewer-zoom-controls" aria-label="Room viewer zoom" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => setZoom((value) => Math.max(0.78, value - 0.08))} aria-label="Zoom out">-</button>
          <button type="button" onClick={resetViewer} aria-label="Reset room viewer">1:1</button>
          <button type="button" onClick={() => setZoom((value) => Math.min(1.35, value + 0.08))} aria-label="Zoom in">+</button>
        </div>
      </section>

      <header className="viewer-header">
        <button type="button" className="viewer-header-button" onClick={onBack} aria-label="Back to scan review"><Icon name="back" size={19} /></button>
        <div className="viewer-title"><strong>Room scan</strong><span>{selectedKeyframes.length || 0} viewpoints held</span></div>
        <div className="viewer-header-actions">
          <button type="button" className="viewer-header-button" onClick={() => setMenuOpen((value) => !value)} aria-label="More room scan options" aria-expanded={menuOpen}><Icon name="more" size={19} /></button>
          <button type="button" className="viewer-header-button" onClick={() => { if (navigator.share) navigator.share({ title: 'PolyScan room scan' }).catch(() => {}); }} aria-label="Share room scan"><Icon name="share" size={18} /></button>
          <button type="button" className="viewer-header-button" onClick={exportScan} aria-label="Export room scan"><Icon name="download" size={18} /></button>
        </div>
      </header>

      {menuOpen && (
        <div className="viewer-menu" role="dialog" aria-label="Room viewer options">
          <strong>Viewer options</strong>
          <button type="button" onClick={resetViewer}>Reset view</button>
          <button type="button" onClick={exportScan}>Export scan data</button>
        </div>
      )}

      <div className="viewer-tool-rail" aria-label="Room viewer tools">
        {[['walk', 'walk', 'Walk'], ['mesh', 'mesh', 'Mesh'], ['camera', 'camera', 'Camera'], ['layers', 'layers', 'Layers']].map(([tool, icon, label]) => (
          <button key={tool} type="button" className={`viewer-tool-button${activeTool === tool ? ' is-active' : ''}`} onClick={() => handleToolChange(tool)} aria-label={label} aria-pressed={activeTool === tool}>
            <Icon name={icon} size={19} />
            {tool === 'layers' && <span className="tool-alert" aria-hidden="true" />}
          </button>
        ))}
      </div>

      <div className="viewer-frame-pill"><span>Frame</span><strong>{frameIndex}</strong><span>of {totalFrames}</span></div>

      <div className="viewer-timeline-wrap">
        <button type="button" className="viewer-back-button" onClick={onBack}><Icon name="back" size={16} /><span>Back</span></button>
        <input type="range" min="1" max={totalFrames} value={frameIndex} onChange={(event) => setFrameIndex(Number(event.target.value))} aria-label="Captured frame" />
        <div className="timeline-arrows">
          <button type="button" onClick={() => setFrameIndex((value) => Math.max(1, value - 1))} aria-label="Previous frame">‹</button>
          <button type="button" onClick={() => setFrameIndex((value) => Math.min(totalFrames, value + 1))} aria-label="Next frame">›</button>
        </div>
      </div>

      <nav className="viewer-bottom-nav" aria-label="Room viewer navigation">
        <button type="button" onClick={() => handleToolChange('measure')} className={activeTool === 'measure' ? 'is-active' : ''}><Icon name="measure" size={18} /><span>Measure</span></button>
        <button type="button" onClick={() => handleToolChange('views')} className={activeTool === 'views' ? 'is-active' : ''}><Icon name="eye" size={18} /><span>Views</span></button>
        <button type="button" onClick={() => handleToolChange('comment')} className={activeTool === 'comment' ? 'is-active' : ''}><Icon name="comment" size={18} /><span>Comment</span></button>
        <button type="button" onClick={() => handleToolChange('video')} className={activeTool === 'video' ? 'is-active' : ''}><Icon name="video" size={18} /><span>Video</span></button>
      </nav>
    </main>
  );
}

function LaunchScreen({ onStart, onImportCapture }) {
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

function ScanScreen({ scanState, paused, onPause, onDone, onScanStateChange, cameraStream, cameraState, onRetryCamera, onCancel, onImportCapture }) {
  const videoRef = useRef(null);
  const analysisCanvasRef = useRef(null);
  const scanRef = useRef(createEmptyScanState());
  const orientationRef = useRef({ yaw: 0, pitch: 0 });
  const [view, setView] = useState({ yaw: 0, pitch: 0 });
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
      const nextKeyframes = evidence.tracking && (isFirstKeyframe || evidence.usefulViewpoint)
        ? [...current.cameraKeyframes, {
          id: `keyframe-${current.cameraKeyframes.length + 1}`,
          timestamp: currentFrame.timestamp,
          viewpoint: evidence.viewpoint,
          featureCount: currentFrame.features.length,
          stableTrackCount: evidence.stableTrackCount,
          sharpness: currentFrame.features.reduce((sum, feature) => sum + feature.score, 0),
          image: currentFrame,
          thumbnail,
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
      setTrackingState(evidence.tracking ? 'tracking' : current.lastFrame ? 'lost' : 'searching');
      setView({ yaw: orientation.yaw, pitch: orientation.pitch });
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
  });
  const mappingReady = keyframeCount > 0;
  const instruction = paused
    ? 'Paused'
    : trackingState === 'lost'
      ? 'Look at a scanned area'
      : mappingReady
        ? 'Move slowly around the room'
        : 'Move around the room';
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
          ? 'Scanning'
          : 'Ready';
  const handleDone = async () => {
    const capture = await stopCaptureRecording();
    setRecording(false);
    onDone(selectBestKeyframes(scanState.cameraKeyframes), capture, scanState);
  };

  return (
    <main className="scan-screen" onPointerDown={resumeCamera}>
      <section className="scan-preview-frame" aria-label="Room camera preview">
        <video ref={videoRef} className="camera-video" autoPlay playsInline muted onLoadedMetadata={resumeCamera} onCanPlay={resumeCamera} aria-label="Live room camera" />
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
        <div className="camera-corners" aria-hidden="true">
          <span className="corner corner-top-left" />
          <span className="corner corner-top-right" />
          <span className="corner corner-bottom-left" />
          <span className="corner corner-bottom-right" />
        </div>
      </section>

      <header className="scan-hud scan-reference-top">
        <Wordmark compact />
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
          <span>Keep edges and corners in view while you move sideways.</span>
        </div>
      )}

      <div className="scan-status-row" role="status" aria-live="polite">
        <span className={`scan-live-dot ${recording ? 'is-recording' : ''}`} />
        <span>{statusLabel}</span>
        <span className="scan-frame-count">{mappingReady ? 'Map active' : 'Blue = unscanned'}</span>
      </div>
      <CoverageMap
        cells={scanState.directionalCoverage}
        view={view}
        paused={paused}
        trackingState={trackingState}
      />

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
          <div className={`scan-map-control${recording ? ' is-active' : ''}`} aria-label="Live spatial mapping active">
            <span className="scan-map-control-core" aria-hidden="true"><Icon name="layers" size={21} /></span>
          </div>
          <button
            type="button"
            className="scan-done-button"
            onClick={handleDone}
            disabled={!viable}
            aria-label={viable ? 'Done scanning' : 'Done scanning, waiting for basic map'}
          >
            <span className="done-check" aria-hidden="true">✓</span>
            <span>Done</span>
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

function ReviewScreen({ selectedKeyframes, capture, onProcess, onScanAgain }) {
  const preview = selectedKeyframes.find((frame) => frame.thumbnail)?.thumbnail;
  const hasCapture = Boolean(capture?.blob);
  const duration = capture?.durationMs ? `${Math.max(1, Math.round(capture.durationMs / 1000))}s` : hasCapture ? 'Video' : selectedKeyframes.length ? 'Local' : 'None';
  return (
    <main className="review-screen capture-review-screen">
      <header className="review-header"><Wordmark /><span className="review-top-label">Capture review</span></header>
      <section className="capture-review-content">
        <div className="review-preview-card">
          {capture?.url ? <video className="review-capture-video" src={capture.url} controls playsInline preload="metadata" aria-label="Recorded room capture" /> : preview ? <img src={preview} alt="Selected room viewpoint" /> : <div className="review-preview-placeholder" aria-hidden="true"><div /><span /></div>}
          <div className="review-preview-overlay"><span className="scan-live-dot" /> {hasCapture ? 'Video ready' : 'Local preview ready'}</div>
        </div>
        <div className="review-copy-block">
          <p className="eyebrow">Scan complete</p>
          <h1>Review your<br /><span>room capture.</span></h1>
          <p>{hasCapture ? 'Your video is ready to upload for reconstruction. You can preview it before building the room.' : 'We held the strongest viewpoints locally. Open the preview now or add a recorded video for reconstruction.'}</p>
          <div className="review-stats" aria-label="Capture summary">
            <span><strong>{selectedKeyframes.length || 0}</strong> viewpoints</span>
            <span><strong>{duration}</strong> capture</span>
          </div>
          <div className="review-actions">
            <button type="button" className="primary-action" onClick={onProcess}>
              <span>{hasCapture ? 'Build room viewer' : 'Open room viewer'}</span>
              <span className="action-arrow" aria-hidden="true">↗</span>
            </button>
            <button type="button" className="text-action" onClick={onScanAgain}>Scan again</button>
          </div>
        </div>
      </section>
    </main>
  );
}

function ProcessingScreen({ selectedKeyframes, capture, buildState, onOpenViewer, onRetry, onBack }) {
  const isWorking = buildState.status === 'uploading' || buildState.status === 'processing';
  const title = buildState.status === 'local'
    ? 'Local preview ready.'
    : buildState.status === 'error'
      ? 'The room is not built yet.'
      : buildState.status === 'ready'
        ? 'Your room is ready.'
        : 'Building your room.';
  const description = buildState.status === 'local'
    ? 'The web capture is saved on this phone. Connect a reconstruction service to turn it into a measured 3D room.'
    : buildState.status === 'error'
      ? buildState.error
      : isWorking
        ? 'Keep this page open while the capture uploads and the room is reconstructed.'
        : 'A room viewer will appear here when processing is complete.';
  return (
    <main className="build-screen">
      <header className="build-header"><button type="button" className="viewer-header-button" onClick={onBack} aria-label="Back to capture review"><Icon name="back" size={19} /></button><Wordmark compact /><span className="build-header-label">Room build</span></header>
      <section className="build-content">
        <div className="build-visual" aria-hidden="true">
          <div className="build-orbit build-orbit-one" />
          <div className="build-orbit build-orbit-two" />
          <div className="build-room-outline" />
          <span className="build-scan-line" />
        </div>
        <div className="build-copy">
          <p className="eyebrow">{buildState.status === 'local' ? 'Browser fallback' : 'Spatial processing'}</p>
          <h1>{title}</h1>
          <p>{description}</p>
          {isWorking && (
            <div className="build-processing-status" role="status" aria-live="polite">
              <span className="build-processing-dot" aria-hidden="true" />
              <span>{buildState.status === 'uploading' ? 'Uploading capture' : 'Reconstructing room'}</span>
            </div>
          )}
          {buildState.status === 'error' && <button type="button" className="primary-action" onClick={onRetry}><span>Try again</span><span className="action-arrow" aria-hidden="true">↗</span></button>}
          {(buildState.status === 'local' || buildState.status === 'ready') && <button type="button" className="primary-action" onClick={onOpenViewer}><span>{buildState.status === 'local' ? 'Open local preview' : 'Open room viewer'}</span><span className="action-arrow" aria-hidden="true">↗</span></button>}
          {capture?.url && buildState.status === 'local' && <small className="build-note">Your video remains on this device until a reconstruction service is connected.</small>}
        </div>
      </section>
      <button type="button" className="build-back-link" onClick={onBack}>Back to capture review</button>
    </main>
  );
}

function App() {
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
        setReconstruction(job.output || job);
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
    if (!capture?.blob || !hasReconstructionEndpoint()) {
      setBuildState({ status: 'local', progress: 100, jobId: null, error: null, manifest });
      return;
    }

    const controller = new AbortController();
    buildAbortRef.current = controller;
    setBuildState({ status: 'uploading', progress: 0, jobId: null, error: null, manifest });
    submitCapture({
      blob: capture.blob,
      manifest,
      signal: controller.signal,
      onProgress: (progress) => setBuildState((current) => ({ ...current, status: 'uploading', progress })),
    }).then(async (job) => {
      const jobId = job.id || job.jobId;
      if (!jobId) throw new Error('The reconstruction service did not return a job id.');
      const status = String(job.status || '').toLowerCase();
      if (job.output || ['complete', 'completed', 'ready', 'succeeded'].includes(status)) {
        setReconstruction(job.output || job);
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
  if (screen === 'launch') activeScreen = <LaunchScreen onStart={startScan} onImportCapture={importCapture} />;
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
    activeScreen = <ReviewScreen selectedKeyframes={selectedKeyframes} capture={capture} onProcess={startBuild} onScanAgain={startScan} />;
  } else if (screen === 'processing') {
    activeScreen = <ProcessingScreen selectedKeyframes={selectedKeyframes} capture={capture} buildState={buildState} onOpenViewer={openViewer} onRetry={startBuild} onBack={backToReview} />;
  } else activeScreen = <RoomViewerScreen selectedKeyframes={selectedKeyframes} reconstruction={reconstruction} onBack={() => setScreen('review')} />;

  return <div className="App">{activeScreen}</div>;
}

export { App, RoomViewerScreen, ScanScreen, createEmptyScanState };
export default App;
