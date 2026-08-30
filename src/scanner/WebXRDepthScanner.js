import { useEffect, useRef } from 'react';
import {
  getStableScanMarkers,
  mergePointCloud,
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
    let points = [];
    let lastPublishedAt = 0;

    const updateGeometry = () => {
      if (!pointGeometry || !positionAttribute || !colorAttribute) return;
      const count = Math.min(points.length, WEBXR_DEPTH_OPTIONS.maximumPoints);
      points.slice(0, count).forEach((point, index) => {
        const offset = index * 3;
        positionAttribute.array[offset] = point.x;
        positionAttribute.array[offset + 1] = point.y;
        positionAttribute.array[offset + 2] = point.z;
        colorAttribute.array[offset] = (point.r ?? 118) / 255;
        colorAttribute.array[offset + 1] = (point.g ?? 211) / 255;
        colorAttribute.array[offset + 2] = (point.b ?? 255) / 255;
      });
      positionAttribute.needsUpdate = true;
      colorAttribute.needsUpdate = true;
      pointGeometry.setDrawRange(0, count);
      pointGeometry.computeBoundingSphere();
    };

    const updateMarkers = (THREE) => {
      if (!markerMesh || !points.length) return;
      const markers = getStableScanMarkers(points);
      const matrix = new THREE.Matrix4();
      markers.forEach((point, index) => {
        matrix.makeTranslation(point.x, point.y, point.z);
        markerMesh.setMatrixAt(index, matrix);
      });
      markerMesh.count = markers.length;
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
          antialias: true,
          powerPreference: 'high-performance',
        });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.xr.enabled = true;
        renderer.xr.setReferenceSpaceType('local-floor');
        await renderer.xr.setSession(session);
        try {
          referenceSpace = await session.requestReferenceSpace('local-floor');
        } catch {
          referenceSpace = await session.requestReferenceSpace('local');
        }
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
        scene.add(pointCloud);
        markerGeometry = new THREE.BoxGeometry(
          WEBXR_DEPTH_OPTIONS.markerVoxelSize * 0.68,
          WEBXR_DEPTH_OPTIONS.markerVoxelSize * 0.68,
          WEBXR_DEPTH_OPTIONS.markerVoxelSize * 0.68,
        );
        markerMaterial = new THREE.MeshBasicMaterial({
          color: 0x63b9ff,
          transparent: true,
          opacity: 0.62,
          wireframe: true,
          depthWrite: false,
        });
        markerMesh = new THREE.InstancedMesh(markerGeometry, markerMaterial, WEBXR_DEPTH_OPTIONS.maximumMarkers);
        markerMesh.count = 0;
        markerMesh.frustumCulled = false;
        markerMesh.renderOrder = 2;
        scene.add(markerMesh);
        resize();
        resizeObserver = window.ResizeObserver ? new ResizeObserver(resize) : null;
        resizeObserver?.observe(canvas);

        renderer.setAnimationLoop((time, frame) => {
          if (cancelled) return;
          if (frame && referenceSpace) {
            let pose = null;
            try { pose = frame.getViewerPose(referenceSpace); } catch { pose = null; }
            const freshPoints = pose ? sampleDepthPointCloud(frame, pose, { sampleGrid: 28 }) : [];
            if (freshPoints.length) {
              points = mergePointCloud(points, freshPoints);
              updateGeometry();
              updateMarkers(THREE);
              if (time - lastPublishedAt > 450) {
                lastPublishedAt = time;
                onPointCloud(points);
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
