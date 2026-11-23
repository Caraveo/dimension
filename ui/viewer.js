import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { loadModel, supportedFormats } from './formats.js';

const ui = id => document.getElementById(id);
const canvas = ui('canvas');
const state = { wire: false, light: true, post: true, spin: false };
let active;
let request = 0;

function notice(message = '') {
  ui('notice').textContent = message;
  ui('notice').hidden = !message;
}

function main() {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  canvas.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.04, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0.4;
  controls.maxDistance = 24;
  controls.maxPolarAngle = Math.PI / 2 + 0.12;
  controls.autoRotateSpeed = 0.9;

  const room = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(room, 0.08);
  room.dispose();
  pmrem.dispose();
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.85;

  const studio = new THREE.Group();
  scene.add(studio);
  studio.add(new THREE.HemisphereLight(0xe6dcff, 0x423952, 1.15));
  const key = new THREE.DirectionalLight(0xffe5d4, 2.7);
  key.position.set(3.5, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -4;
  key.shadow.camera.right = key.shadow.camera.top = 4;
  key.shadow.normalBias = 0.035;
  key.shadow.intensity = 0.63;
  studio.add(key);
  const rim = new THREE.DirectionalLight(0xa286ff, 3.1);
  rim.position.set(-4, 3, -3);
  studio.add(rim);
  const fill = new THREE.DirectionalLight(0x8bcfff, 1.4);
  fill.position.set(3, 2, -3);
  studio.add(fill);

  const grid = new THREE.GridHelper(20, 40, 0xa890cc, 0x75638e);
  grid.position.y = -0.016;
  grid.material.transparent = true;
  grid.material.opacity = 0.16;
  grid.material.depthWrite = false;
  scene.add(grid);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(36, 36), new THREE.ShadowMaterial({ opacity: 0.35 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.014;
  ground.receiveShadow = true;
  studio.add(ground);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.48, 1.28));
  composer.addPass(new OutputPass());

  function resize() {
    const { clientWidth: width, clientHeight: height } = canvas;
    if (!width || !height) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
  }

  function frame() {
    if (!active) return;
    const center = active.bounds.getCenter(new THREE.Vector3());
    const radius = active.bounds.getBoundingSphere(new THREE.Sphere()).radius;
    const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
    const angle = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
    const distance = radius / Math.sin(angle) * 1.13;
    center.y -= (active.bounds.max.y - active.bounds.min.y) * 0.10;
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(new THREE.Vector3(4.6, 2.8, 6.5).normalize(), distance);
    controls.update();
  }

  function apply() {
    studio.visible = state.light;
    scene.environment = state.light ? environment.texture : null;
    controls.autoRotate = state.spin;
    for (const entry of active?.entries || []) {
      const materials = state.light ? entry.lit : entry.unlit;
      for (const material of materials) {
        if ('wireframe' in material) material.wireframe = state.wire;
      }
      entry.mesh.material = entry.array ? materials : materials[0];
    }
    for (const [id, value] of Object.entries(state)) ui(id).setAttribute('aria-pressed', String(value));
  }

  function replace(model, name, format) {
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    if (bounds.isEmpty() || !Number.isFinite(extent) || extent <= 0) {
      dispose(model);
      throw new Error('No renderable geometry was found.');
    }

    // Normalize a wrapper so imported transforms, hierarchies and units stay intact.
    const wrapper = new THREE.Group();
    const scale = 3.4 / extent;
    const center = bounds.getCenter(new THREE.Vector3());
    wrapper.add(model);
    wrapper.scale.setScalar(scale);
    wrapper.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
    const entries = [];
    const unlitCache = new Map();
    let triangles = 0;
    wrapper.traverse(object => {
      if (object.isLight) object.visible = false;
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      const lit = Array.isArray(object.material) ? object.material : [object.material];
      const unlit = lit.map(material => {
        if (!unlitCache.has(material)) {
          unlitCache.set(material, new THREE.MeshBasicMaterial({
            color: material.color || 0xffffff, map: material.map || null,
            alphaMap: material.alphaMap || null, alphaTest: material.alphaTest,
            opacity: material.opacity, transparent: material.transparent, side: material.side,
            vertexColors: material.vertexColors, depthWrite: material.depthWrite
          }));
        }
        return unlitCache.get(material);
      });
      entries.push({ mesh: object, lit, unlit, array: Array.isArray(object.material) });
      const geometry = object.geometry;
      triangles += Math.floor((geometry.index?.count ?? geometry.attributes.position.count) / 3);
    });

    if (active) {
      scene.remove(active.wrapper);
      const materials = active.entries.flatMap(entry => [...entry.lit, ...entry.unlit]);
      dispose(active.wrapper, materials);
    }
    scene.add(wrapper);
    active = { wrapper, entries, bounds: new THREE.Box3().setFromObject(wrapper) };
    ui('name').textContent = name;
    ui('name').title = name;
    ui('format').textContent = format;
    ui('count').textContent = triangles ? `${triangles.toLocaleString()} triangles` : '';
    apply();
    frame();
  }

  window.dimensionLoad = async ({ url, name, format }) => {
    const version = ++request;
    notice(`Loading ${name}…`);
    try {
      const object = await loadModel(url, format, renderer);
      if (version !== request) {
        dispose(object);
        return;
      }
      replace(object, name, format.toUpperCase());
      notice();
    } catch (error) {
      console.error(error);
      if (version === request) notice(`Could not open ${name}. ${error.message || 'Import failed.'}`);
    }
  };

  for (const id of Object.keys(state)) {
    ui(id).onclick = () => { state[id] = !state[id]; apply(); };
  }
  ui('frame').onclick = frame;
  window.addEventListener('keydown', event => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    const id = { w: 'wire', l: 'light', p: 'post', r: 'spin', f: 'frame' }[event.key.toLowerCase()];
    if (id) ui(id).click();
  });
  new ResizeObserver(() => { resize(); }).observe(canvas);
  resize();
  replace(demo(), 'Aperture', 'DEMO');

  renderer.setAnimationLoop(() => {
    controls.update();
    if (state.post) composer.render();
    else renderer.render(scene, camera);
  });
}

function dispose(object, extraMaterials = []) {
  const geometries = new Set();
  const materials = new Set(extraMaterials);
  const textures = new Set();
  object.traverse(item => {
    if (item.geometry) geometries.add(item.geometry);
    if (item.material) for (const material of [item.material].flat()) materials.add(material);
  });
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  for (const geometry of geometries) geometry.dispose();
}

function demo() {
  const group = new THREE.Group();
  const knot = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.97, 0.245, 384, 36, 2, 3),
    new THREE.MeshPhysicalMaterial({ color: 0xb5a0ff, metalness: 0.65, roughness: 0.25, clearcoat: 0.65, clearcoatRoughness: 0.21 })
  );
  knot.rotation.set(0.17, -0.38, 0.34);
  knot.updateMatrixWorld();
  knot.position.y = 0.30 - new THREE.Box3().setFromObject(knot, true).min.y;
  group.add(knot);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.55, 1.63, 0.21, 128),
    new THREE.MeshStandardMaterial({ color: 0x262038, metalness: 0.32, roughness: 0.38 })
  );
  base.position.y = 0.105;
  group.add(base);
  const top = new THREE.Mesh(
    new THREE.CylinderGeometry(1.49, 1.55, 0.1, 128),
    new THREE.MeshStandardMaterial({ color: 0x423951, metalness: 0.43, roughness: 0.33 })
  );
  top.position.y = 0.24;
  group.add(top);
  const accent = new THREE.Mesh(
    new THREE.TorusGeometry(1.54, 0.012, 8, 128),
    new THREE.MeshStandardMaterial({ color: 0xbaa3ff, emissive: 0x9a6dff, emissiveIntensity: 1.5 })
  );
  accent.rotation.x = -Math.PI / 2;
  accent.position.y = 0.207;
  group.add(accent);
  return group;
}

ui('open').onclick = () => window.webkit?.messageHandlers.dimension.postMessage('open');
ui('open').title = `Supported formats: ${supportedFormats.join(', ')}`;
try {
  main();
} catch (error) {
  console.error(error);
  notice(`Could not start the 3D renderer. ${error.message}`);
}
window.webkit?.messageHandlers.dimension.postMessage('ready');
