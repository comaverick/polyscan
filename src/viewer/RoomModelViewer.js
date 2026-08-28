import { useEffect, useRef, useState } from 'react';

const WALK_SPEED = 1.45;
const EYE_HEIGHT = 1.62;

function normalizeFormat(asset) {
  const explicit = String(asset?.format || '').toLowerCase();
  if (explicit) return explicit.replace('.', '');
  const pathname = String(asset?.url || '').split('?')[0].toLowerCase();
  if (pathname.endsWith('.ply')) return 'ply';
  if (pathname.endsWith('.gltf')) return 'gltf';
  return 'glb';
}

export default function RoomModelViewer({ asset, spawn }) {
  const hostRef = useRef(null);
  const movementRef = useRef({ forward: 0, right: 0 });
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const resetRef = useRef(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !asset?.url) return undefined;
    let cancelled = false;
    let renderer;
    let resizeObserver;
    let animationFrame;
    const cleanups = [];

    const start = async () => {
      try {
        const THREE = await import('three');
        const [{ GLTFLoader }, { PLYLoader }] = await Promise.all([
          import('three/addons/loaders/GLTFLoader.js'),
          import('three/addons/loaders/PLYLoader.js'),
        ]);
        if (cancelled) return;

        renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setClearColor(0x07111c, 1);
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.domElement.className = 'room-model-canvas';
        host.appendChild(renderer.domElement);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x07111c);
        scene.fog = new THREE.Fog(0x07111c, 14, 42);
        const camera = new THREE.PerspectiveCamera(68, 1, 0.03, 160);
        camera.rotation.order = 'YXZ';

        scene.add(new THREE.HemisphereLight(0xeaf8ff, 0x152436, 2.2));
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
        keyLight.position.set(3, 7, 4);
        scene.add(keyLight);

        const format = normalizeFormat(asset);
        let model;
        if (format === 'ply') {
          const geometry = await new PLYLoader().loadAsync(asset.url);
          geometry.computeBoundingBox();
          if (String(asset.kind || '').toLowerCase() === 'pointcloud') {
            model = new THREE.Points(geometry, new THREE.PointsMaterial({
              size: Number(asset.pointSize || 0.018),
              vertexColors: Boolean(geometry.getAttribute('color')),
              color: geometry.getAttribute('color') ? 0xffffff : 0x9ee7ff,
              sizeAttenuation: true,
            }));
          } else {
            if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
            model = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
              color: geometry.getAttribute('color') ? 0xffffff : 0x93bfd0,
              vertexColors: Boolean(geometry.getAttribute('color')),
              roughness: 0.88,
              metalness: 0,
              side: THREE.DoubleSide,
            }));
          }
        } else {
          const gltf = await new GLTFLoader().loadAsync(asset.url);
          model = gltf.scene;
          model.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = false;
            child.receiveShadow = true;
            const materials = Array.isArray(child.material) ? child.material : [child.material];
            materials.filter(Boolean).forEach((material) => {
              material.side = THREE.DoubleSide;
            });
          });
        }
        if (cancelled) return;
        if (asset.coordinateSystem === 'colmap-camera') model.rotation.x = Math.PI;
        scene.add(model);

        let bounds = new THREE.Box3().setFromObject(model);
        const unscaledSize = bounds.getSize(new THREE.Vector3());
        const suppliedScale = Number(asset.metricScale || 0);
        const inferredScale = asset.coordinateSystem === 'colmap-camera' && unscaledSize.y > 0
          ? 2.5 / unscaledSize.y
          : 1;
        const modelScale = suppliedScale > 0 ? suppliedScale : inferredScale;
        if (Number.isFinite(modelScale) && modelScale > 0 && Math.abs(modelScale - 1) > 0.001) {
          model.scale.setScalar(modelScale);
          bounds = new THREE.Box3().setFromObject(model);
        }
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const startPosition = new THREE.Vector3(
          Number.isFinite(spawn?.x) ? spawn.x : center.x,
          Number.isFinite(spawn?.y) ? spawn.y : bounds.min.y + Math.min(EYE_HEIGHT, Math.max(0.55, size.y * 0.45)),
          Number.isFinite(spawn?.z) ? spawn.z : center.z,
        );
        camera.position.copy(startPosition);
        let yaw = Number(spawn?.yaw || 0);
        let pitch = Number(spawn?.pitch || 0);
        camera.rotation.set(pitch, yaw, 0);

        resetRef.current = () => {
          camera.position.copy(startPosition);
          yaw = Number(spawn?.yaw || 0);
          pitch = Number(spawn?.pitch || 0);
          camera.rotation.set(pitch, yaw, 0);
        };

        const colliders = [];
        model.traverse((child) => {
          if (child.isMesh) colliders.push(child);
        });
        const collisionRay = new THREE.Raycaster();
        const floorRay = new THREE.Raycaster();
        const up = new THREE.Vector3(0, 1, 0);
        const forward = new THREE.Vector3();
        const right = new THREE.Vector3();
        const movement = new THREE.Vector3();
        const clock = new THREE.Clock();

        let pointerId = null;
        let pointerX = 0;
        let pointerY = 0;
        const pointerDown = (event) => {
          pointerId = event.pointerId;
          pointerX = event.clientX;
          pointerY = event.clientY;
          renderer.domElement.setPointerCapture?.(event.pointerId);
        };
        const pointerMove = (event) => {
          if (pointerId !== event.pointerId) return;
          const deltaX = event.clientX - pointerX;
          const deltaY = event.clientY - pointerY;
          pointerX = event.clientX;
          pointerY = event.clientY;
          yaw -= deltaX * 0.0042;
          pitch = Math.max(-1.34, Math.min(1.34, pitch - deltaY * 0.0035));
          camera.rotation.set(pitch, yaw, 0);
        };
        const pointerUp = (event) => {
          if (pointerId === event.pointerId) pointerId = null;
        };
        renderer.domElement.addEventListener('pointerdown', pointerDown);
        renderer.domElement.addEventListener('pointermove', pointerMove);
        renderer.domElement.addEventListener('pointerup', pointerUp);
        renderer.domElement.addEventListener('pointercancel', pointerUp);
        cleanups.push(() => {
          renderer.domElement.removeEventListener('pointerdown', pointerDown);
          renderer.domElement.removeEventListener('pointermove', pointerMove);
          renderer.domElement.removeEventListener('pointerup', pointerUp);
          renderer.domElement.removeEventListener('pointercancel', pointerUp);
        });

        const resize = () => {
          const width = Math.max(1, host.clientWidth);
          const height = Math.max(1, host.clientHeight);
          renderer.setSize(width, height, false);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
        };
        resize();
        resizeObserver = new ResizeObserver(resize);
        resizeObserver.observe(host);

        const animate = () => {
          const delta = Math.min(0.05, clock.getDelta());
          const input = movementRef.current;
          if (input.forward || input.right) {
            forward.set(0, 0, -1).applyAxisAngle(up, yaw);
            right.set(1, 0, 0).applyAxisAngle(up, yaw);
            movement.copy(forward).multiplyScalar(input.forward).addScaledVector(right, input.right);
            if (movement.lengthSq()) movement.normalize().multiplyScalar(WALK_SPEED * delta);
            collisionRay.set(camera.position, movement.clone().normalize());
            collisionRay.near = 0;
            collisionRay.far = movement.length() + 0.36;
            const blocked = colliders.length && collisionRay.intersectObjects(colliders, true).length > 0;
            if (!blocked) camera.position.add(movement);

            if (colliders.length) {
              floorRay.set(camera.position, new THREE.Vector3(0, -1, 0));
              floorRay.near = 0.2;
              floorRay.far = 3.2;
              const [floorHit] = floorRay.intersectObjects(colliders, true);
              if (floorHit && floorHit.point.y < camera.position.y - 0.35) {
                const targetY = floorHit.point.y + EYE_HEIGHT;
                camera.position.y += (targetY - camera.position.y) * Math.min(1, delta * 8);
              }
            }
          }
          renderer.render(scene, camera);
          animationFrame = requestAnimationFrame(animate);
        };
        setStatus('ready');
        animate();

        cleanups.push(() => {
          scene.traverse((object) => {
            object.geometry?.dispose?.();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.filter(Boolean).forEach((material) => {
              Object.values(material).forEach((value) => value?.isTexture && value.dispose());
              material.dispose?.();
            });
          });
        });
      } catch (loadError) {
        if (cancelled) return;
        setStatus('error');
        setError(loadError?.message || 'The reconstructed room model could not be opened.');
      }
    };

    start();
    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      cleanups.forEach((cleanup) => cleanup());
      renderer?.dispose();
      renderer?.domElement?.remove();
    };
  }, [asset, spawn]);

  const setMovement = (next) => {
    movementRef.current = next;
  };
  const bindMove = (next) => ({
    onPointerDown: (event) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setMovement(next);
    },
    onPointerUp: () => setMovement({ forward: 0, right: 0 }),
    onPointerCancel: () => setMovement({ forward: 0, right: 0 }),
    onPointerLeave: () => setMovement({ forward: 0, right: 0 }),
  });

  return (
    <div className="room-model-viewer">
      <div ref={hostRef} className="room-model-host" aria-label="First-person reconstructed room" />
      {status === 'loading' && <div className="room-model-state" role="status"><strong>Loading room geometry</strong><span>Preparing the first-person view.</span></div>}
      {status === 'error' && <div className="room-model-state room-model-error" role="alert"><strong>Room model unavailable</strong><span>{error}</span></div>}
      {status === 'ready' && (
        <>
          <div className="viewer-look-hint">Drag anywhere to look</div>
          <div className="viewer-touch-controls" aria-label="Walk controls">
            <button type="button" className="walk-up" aria-label="Walk forward" {...bindMove({ forward: 1, right: 0 })}>↑</button>
            <button type="button" className="walk-left" aria-label="Walk left" {...bindMove({ forward: 0, right: -1 })}>←</button>
            <button type="button" className="walk-down" aria-label="Walk backward" {...bindMove({ forward: -1, right: 0 })}>↓</button>
            <button type="button" className="walk-right" aria-label="Walk right" {...bindMove({ forward: 0, right: 1 })}>→</button>
          </div>
          <button type="button" className="viewer-reset-position" onClick={() => resetRef.current()}>Reset position</button>
        </>
      )}
    </div>
  );
}

export { normalizeFormat };
