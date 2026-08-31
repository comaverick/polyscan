import { useEffect, useRef } from 'react';
import {
  IncrementalDepthStore,
  sampleDepthSurface,
  WEBXR_DEPTH_OPTIONS,
} from './webxrDepth';

const MAX_OCCLUSION_GRID_SIDE = 24;

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Renders measured ARCore depth in the WebXR reference space. The blue layer
 * is made from persistent world-space surfels; it is not a screen-space grid.
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
    let markerGeometry;
    let markerMaterial;
    let markerMesh;
    let occlusionGeometry;
    let occlusionMaterial;
    let occlusionMesh;
    let occlusionPositionAttribute;
    let occlusionIndexAttribute;
    let referenceSpace;
    let lastMarkerSignature = '';
    const scanStore = new IncrementalDepthStore(WEBXR_DEPTH_OPTIONS);
    const occlusionPositions = new Float32Array(MAX_OCCLUSION_GRID_SIDE * MAX_OCCLUSION_GRID_SIDE * 3);
    const occlusionIndices = new Uint16Array((MAX_OCCLUSION_GRID_SIDE - 1) * (MAX_OCCLUSION_GRID_SIDE - 1) * 6);
    let lastPublishedAt = 0;
    let lastMarkerRenderAt = 0;
    let lastDepthSampleAt = 0;
    let lastFrameTime = 0;
    let frameTimeAverage = 16.7;
    let lastQualityAdjustAt = 0;
    let sampleGrid = Math.max(14, Math.min(22, WEBXR_DEPTH_OPTIONS.sampleGrid));
    let sampleIntervalMs = 100;
    let depthFrameCount = 0;
    let depthBatchCount = 0;
    let depthSampleCount = 0;
    let emptyDepthBatchCount = 0;
    let consecutiveEmptyBatches = 0;

    const updateOcclusion = (surface) => {
      if (!occlusionGeometry || !occlusionPositionAttribute || !occlusionIndexAttribute) return;
      const side = Math.max(0, Math.min(MAX_OCCLUSION_GRID_SIDE, Number(surface?.gridSide || 0)));
      const points = Array.isArray(surface?.gridPoints) ? surface.gridPoints : [];
      if (side < 2 || points.length < side * side) {
        occlusionGeometry.setDrawRange(0, 0);
        return;
      }

      for (let index = 0; index < side * side; index += 1) {
        const point = points[index];
        const offset = index * 3;
        occlusionPositions[offset] = point?.x || 0;
        occlusionPositions[offset + 1] = point?.y || 0;
        occlusionPositions[offset + 2] = point?.z || 0;
      }
      let indexCount = 0;
      const isContinuous = (first, second) => first && second && distanceBetween(first, second) <= 0.28;
      for (let row = 0; row < side - 1; row += 1) {
        for (let column = 0; column < side - 1; column += 1) {
          const topLeftIndex = row * side + column;
          const topRightIndex = topLeftIndex + 1;
          const bottomLeftIndex = topLeftIndex + side;
          const bottomRightIndex = bottomLeftIndex + 1;
          const topLeft = points[topLeftIndex];
          const topRight = points[topRightIndex];
          const bottomLeft = points[bottomLeftIndex];
          const bottomRight = points[bottomRightIndex];
          if (!topLeft || !topRight || !bottomLeft || !bottomRight
            || !isContinuous(topLeft, topRight)
            || !isContinuous(topLeft, bottomLeft)
            || !isContinuous(topRight, bottomRight)
            || !isContinuous(bottomLeft, bottomRight)) continue;
          occlusionIndices[indexCount] = topLeftIndex;
          occlusionIndices[indexCount + 1] = bottomLeftIndex;
          occlusionIndices[indexCount + 2] = topRightIndex;
          occlusionIndices[indexCount + 3] = topRightIndex;
          occlusionIndices[indexCount + 4] = bottomLeftIndex;
          occlusionIndices[indexCount + 5] = bottomRightIndex;
          indexCount += 6;
        }
      }
      occlusionPositionAttribute.needsUpdate = true;
      occlusionIndexAttribute.needsUpdate = true;
      occlusionGeometry.setDrawRange(0, indexCount);
    };

    const updateMarkers = (THREE, markers = [], cameraPosition = {}) => {
      if (!markerMesh) return;
      // A marker's key and revision are stable while the camera is still. Do
      // not rewrite every instance just because an XR frame was rendered.
      const signature = markers.map((point) => `${point.key || point.index}:${point.revision || 0}`).join(',');
      if (signature === lastMarkerSignature) return;
      lastMarkerSignature = signature;
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const normal = new THREE.Vector3();
      const fallbackNormal = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3(1, 1, 1);
      const defaultNormal = new THREE.Vector3(0, 0, 1);
      markers.forEach((point, index) => {
        position.set(point.x, point.y, point.z);
        if (Number.isFinite(point.nx) && Number.isFinite(point.ny) && Number.isFinite(point.nz)
          && Math.hypot(point.nx, point.ny, point.nz) > 0.5) {
          normal.set(point.nx, point.ny, point.nz).normalize();
        } else {
          fallbackNormal.set(
            (Number(cameraPosition.x) || 0) - point.x,
            (Number(cameraPosition.y) || 0) - point.y,
            (Number(cameraPosition.z) || 0) - point.z,
          );
          normal.copy(fallbackNormal.lengthSq() > 0.000001 ? fallbackNormal.normalize() : defaultNormal);
        }
        quaternion.setFromUnitVectors(defaultNormal, normal);
        // Lift the visible surfel a few millimetres toward the camera so the
        // current-frame occlusion mesh does not z-fight with an anchored mark.
        position.addScaledVector(normal, 0.003);
        matrix.compose(position, quaternion, scale);
        markerMesh.setMatrixAt(index, matrix);
      });
      markerMesh.count = markers.length;
      markerMesh.instanceMatrix.needsUpdate = markers.length > 0;
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
        renderer.setClearColor(0x000000, 0);
        renderer.setClearAlpha(0);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
        renderer.xr.enabled = true;
        renderer.xr.setReferenceSpaceType('local');
        await renderer.xr.setSession(session);
        referenceSpace = renderer.xr.getReferenceSpace?.() || await session.requestReferenceSpace('local');
        if (cancelled) return;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera();

        // This mesh writes the latest measured surface into the depth buffer
        // without adding another visible layer. It keeps old wall surfels
        // behind a desk or cabinet instead of painting through it.
        occlusionGeometry = new THREE.BufferGeometry();
        occlusionPositionAttribute = new THREE.BufferAttribute(occlusionPositions, 3);
        occlusionIndexAttribute = new THREE.BufferAttribute(occlusionIndices, 1);
        occlusionGeometry.setAttribute('position', occlusionPositionAttribute);
        occlusionGeometry.setIndex(occlusionIndexAttribute);
        occlusionGeometry.setDrawRange(0, 0);
        occlusionMaterial = new THREE.MeshBasicMaterial({
          color: 0x000000,
          colorWrite: false,
          depthWrite: true,
          side: THREE.DoubleSide,
        });
        occlusionMesh = new THREE.Mesh(occlusionGeometry, occlusionMaterial);
        occlusionMesh.frustumCulled = false;
        occlusionMesh.renderOrder = 0;
        scene.add(occlusionMesh);

        const markerSize = WEBXR_DEPTH_OPTIONS.markerVoxelSize * 0.72;
        markerGeometry = new THREE.PlaneGeometry(markerSize, markerSize);
        markerMaterial = new THREE.ShaderMaterial({
          uniforms: {
            markerColor: { value: new THREE.Color(0x35bfff) },
            markerOpacity: { value: 0.52 },
          },
          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
              gl_Position = projectionMatrix * viewMatrix * worldPosition;
            }
          `,
          fragmentShader: `
            uniform vec3 markerColor;
            uniform float markerOpacity;
            varying vec2 vUv;
            void main() {
              float radius = distance(vUv, vec2(0.5));
              float edge = 1.0 - smoothstep(0.32, 0.5, radius);
              if (edge < 0.015) discard;
              gl_FragColor = vec4(markerColor, markerOpacity * edge);
            }
          `,
          transparent: true,
          depthTest: true,
          depthWrite: false,
          side: THREE.DoubleSide,
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
            const samplePhase = scanStore.batchNumber % 4;
            const surface = pose
              ? sampleDepthSurface(frame, pose, { sampleGrid, samplePhase })
              : { points: [], gridPoints: [], gridSide: 0 };
            const freshPoints = surface.points;
            const result = scanStore.addPoints(freshPoints);
            depthFrameCount += 1;
            if (freshPoints.length) {
              updateOcclusion(surface);
              depthBatchCount += 1;
              depthSampleCount += freshPoints.length;
              consecutiveEmptyBatches = 0;
            } else {
              emptyDepthBatchCount += 1;
              consecutiveEmptyBatches += 1;
              updateOcclusion({ gridSide: 0, gridPoints: [] });
            }
            const cameraPosition = pose?.views?.[0]?.transform?.position || { x: 0, y: 0, z: 0 };
            if (time - lastMarkerRenderAt >= 300 || result.addedMarkers.length || result.updatedMarkers.length) {
              lastMarkerRenderAt = time;
              updateMarkers(THREE, scanStore.getVisibleMarkers(cameraPosition), cameraPosition);
            }
            if (time - lastPublishedAt > 900) {
              lastPublishedAt = time;
              onPointCloud({
                points: result.points,
                pointCount: result.pointCount,
                markerCount: result.markerCount,
                depthFrameCount,
                depthBatchCount,
                depthSampleCount,
                emptyDepthBatchCount,
                consecutiveEmptyBatches,
                trackingState: consecutiveEmptyBatches >= 5 ? 'waiting' : 'tracking',
                storageCapacityReached: result.storageCapacityReached,
                sampleGrid,
                sampleIntervalMs,
              });
            }

            const processingMs = performance.now() - processingStartedAt;
            if (time - lastQualityAdjustAt >= 1000) {
              lastQualityAdjustAt = time;
              const overloaded = frameTimeAverage > 25 || processingMs > 18;
              const underBudget = frameTimeAverage < 18 && processingMs < 10;
              if (overloaded) {
                sampleIntervalMs = Math.min(180, sampleIntervalMs + 20);
                sampleGrid = Math.max(14, sampleGrid - 2);
              } else if (underBudget) {
                sampleIntervalMs = Math.max(90, sampleIntervalMs - 10);
                sampleGrid = Math.min(22, sampleGrid + 1);
              }
            }
          }
          renderer.render(scene, camera);
        });
      } catch (error) {
        if (!cancelled) onSessionError?.(error);
      }
    };

    start();
    return () => {
      cancelled = true;
      renderer?.setAnimationLoop(null);
      resizeObserver?.disconnect();
      occlusionGeometry?.dispose();
      occlusionMaterial?.dispose();
      markerGeometry?.dispose();
      markerMaterial?.dispose();
      renderer?.dispose();
    };
  }, [onPointCloud, onSessionError, session]);

  return <canvas ref={canvasRef} className="xr-depth-canvas" aria-label="Live AR depth scan" />;
}
