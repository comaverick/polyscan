import { useEffect, useRef } from 'react';
import {
  IncrementalDepthStore,
  sampleDepthPointCloud,
  WEBXR_DEPTH_OPTIONS,
} from './webxrDepth';

/**
 * Renders the real ARCore depth samples in the WebXR reference space. The
 * browser supplies the camera passthrough; this canvas only draws measured
 * world-space points on top of it.
 */
export default function WebXRDepthScanner({ session, onPointCloud, onSessionError }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return undefined;
    canvas.style.background = 'transparent';
    let cancelled = false;
    let renderer;
    let resizeObserver;
    let pointGeometry;
    let pointMaterial;
    let pointCloud;
    let markerGeometry;
    let markerMaterial;
    let markerMesh;
    let positionAttribute;
    let colorAttribute;
    let referenceSpace;
    const scanStore = new IncrementalDepthStore(WEBXR_DEPTH_OPTIONS);
    let lastPublishedAt = 0;
    let lastDepthSampleAt = 0;
    let lastFrameTime = 0;
    let frameTimeAverage = 16.7;
    let lastQualityAdjustAt = 0;
    let sampleGrid = Math.max(12, Math.min(22, WEBXR_DEPTH_OPTIONS.sampleGrid));
    let sampleIntervalMs = 100;
    let depthBatchCount = 0;
    let depthSampleCount = 0;

    const updateGeometry = (addedPoints = []) => {
      if (!pointGeometry || !positionAttribute || !colorAttribute) return;
      addedPoints.forEach(({ point, index }) => {
        const offset = index * 3;
        positionAttribute.array[offset] = point.x;
        positionAttribute.array[offset + 1] = point.y;
        positionAttribute.array[offset + 2] = point.z;
        colorAttribute.array[offset] = (point.r ?? 118) / 255;
        colorAttribute.array[offset + 1] = (point.g ?? 211) / 255;
        colorAttribute.array[offset + 2] = (point.b ?? 255) / 255;
      });
      const count = scanStore.points.length;
      if (addedPoints.length) {
        positionAttribute.needsUpdate = true;
        colorAttribute.needsUpdate = true;
      }
      pointGeometry.setDrawRange(0, count);
    };

    const updateMarkers = (THREE, addedMarkers = [], updatedMarkers = []) => {
      if (!markerMesh || (!addedMarkers.length && !updatedMarkers.length)) return;
      const matrix = new THREE.Matrix4();
      [...addedMarkers, ...updatedMarkers].forEach((point) => {
        matrix.makeTranslation(point.x, point.y, point.z);
        markerMesh.setMatrixAt(point.index, matrix);
      });
      markerMesh.count = scanStore.confirmedMarkerCount;
      // Matrix updates are limited to confirmed/new markers. The old code
      // rebuilt every marker matrix from every point on every XR frame.
      markerMesh.instanceMatrix.needsUpdate = true;
    };

    const resize = () => {
      if (!renderer || !canvas) return;
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      renderer.setSize(width, height, false);
    };

    const start = async () => {
      try {
        const THREE = await import('three');
        if (cancelled) return;
        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          premultipliedAlpha: false,
          antialias: false,
          powerPreference: 'high-performance',
        });
        // Be explicit about the transparent XR framebuffer. Some Android
        // WebXR implementations otherwise present the camera passthrough as a
        // black layer when the default premultiplied clear state is retained.
        renderer.setClearColor(0x000000, 0);
        renderer.setClearAlpha(0);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
        renderer.xr.enabled = true;
        // `local` is required by our session request and is supported on more
        // ARCore devices than `local-floor`. The floor space remains optional;
        // using the required space here prevents a successful AR session from
        // going black while Three.js waits for an unavailable floor space.
        renderer.xr.setReferenceSpaceType('local');
        await renderer.xr.setSession(session);
        referenceSpace = renderer.xr.getReferenceSpace?.() || await session.requestReferenceSpace('local');
        if (cancelled) return;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera();
        pointGeometry = new THREE.BufferGeometry();
        positionAttribute = new THREE.BufferAttribute(new Float32Array(WEBXR_DEPTH_OPTIONS.maximumPoints * 3), 3);
        colorAttribute = new THREE.BufferAttribute(new Float32Array(WEBXR_DEPTH_OPTIONS.maximumPoints * 3), 3);
        pointGeometry.setAttribute('position', positionAttribute);
        pointGeometry.setAttribute('color', colorAttribute);
        pointGeometry.setDrawRange(0, 0);
        pointMaterial = new THREE.PointsMaterial({
          size: 0.018,
          sizeAttenuation: true,
          vertexColors: true,
          transparent: true,
          opacity: 0.92,
        });
        pointCloud = new THREE.Points(pointGeometry, pointMaterial);
        pointCloud.frustumCulled = false;
        scene.add(pointCloud);
        const markerSize = WEBXR_DEPTH_OPTIONS.markerVoxelSize * 0.58;
        markerGeometry = new THREE.BoxGeometry(markerSize, markerSize, Math.max(0.008, markerSize * 0.08));
        markerMaterial = new THREE.MeshBasicMaterial({
          color: 0x3db7ff,
          transparent: true,
          opacity: 0.78,
          depthWrite: false,
        });
        markerMesh = new THREE.InstancedMesh(markerGeometry, markerMaterial, WEBXR_DEPTH_OPTIONS.maximumMarkers);
        markerMesh.count = 0;
        markerMesh.frustumCulled = false;
        markerMesh.renderOrder = 2;
        markerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(markerMesh);
        resize();
        resizeObserver = window.ResizeObserver ? new ResizeObserver(resize) : null;
        resizeObserver?.observe(canvas);

        renderer.setAnimationLoop((time, frame) => {
          if (cancelled) return;
          const frameTime = lastFrameTime ? Math.max(0, time - lastFrameTime) : 16.7;
          lastFrameTime = time;
          frameTimeAverage = frameTimeAverage * 0.9 + frameTime * 0.1;

          if (frame && referenceSpace && time - lastDepthSampleAt >= sampleIntervalMs) {
            lastDepthSampleAt = time;
            let pose = null;
            try { pose = frame.getViewerPose(referenceSpace); } catch { pose = null; }
            const processingStartedAt = performance.now();
            const freshPoints = pose ? sampleDepthPointCloud(frame, pose, { sampleGrid }) : [];
            if (freshPoints.length) {
              const result = scanStore.addPoints(freshPoints);
              updateGeometry(result.addedPoints);
              updateMarkers(THREE, result.addedMarkers, result.updatedMarkers);
              depthBatchCount += 1;
              depthSampleCount += freshPoints.length;
              if (time - lastPublishedAt > 450) {
                lastPublishedAt = time;
                onPointCloud({
                  points: result.points,
                  pointCount: result.pointCount,
                  markerCount: result.markerCount,
                  depthBatchCount,
                  depthSampleCount,
                  sampleGrid,
                  sampleIntervalMs,
                });
              }
            }

            const processingMs = performance.now() - processingStartedAt;
            if (time - lastQualityAdjustAt >= 1000) {
              lastQualityAdjustAt = time;
              const overloaded = frameTimeAverage > 25 || processingMs > 18;
              const underBudget = frameTimeAverage < 18 && processingMs < 10;
              if (overloaded) {
                sampleIntervalMs = Math.min(180, sampleIntervalMs + 20);
                sampleGrid = Math.max(12, sampleGrid - 2);
              } else if (underBudget) {
                sampleIntervalMs = Math.max(90, sampleIntervalMs - 10);
                sampleGrid = Math.min(22, sampleGrid + 1);
              }
            }
          }
          renderer.render(scene, camera);
        });
      } catch (error) {
        // The parent switches to the normal camera/reconstruction path if the
        // browser accepts the session but cannot create a depth renderer.
        if (!cancelled) onSessionError?.(error);
      }
    };

    start();
    return () => {
      cancelled = true;
      renderer?.setAnimationLoop(null);
      resizeObserver?.disconnect();
      pointGeometry?.dispose();
      pointMaterial?.dispose();
      markerGeometry?.dispose();
      markerMaterial?.dispose();
      renderer?.dispose();
    };
  }, [onPointCloud, onSessionError, session]);

  return <canvas ref={canvasRef} className="xr-depth-canvas" aria-label="Live AR depth scan" />;
}
