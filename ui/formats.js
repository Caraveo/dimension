import * as THREE from 'three';

const loaders = {
  '3ds': ['TDSLoader', () => import('three/addons/loaders/TDSLoader.js')],
  '3mf': ['ThreeMFLoader', () => import('three/addons/loaders/3MFLoader.js')],
  amf: ['AMFLoader', () => import('three/addons/loaders/AMFLoader.js')],
  dae: ['ColladaLoader', () => import('three/addons/loaders/ColladaLoader.js')],
  fbx: ['FBXLoader', () => import('three/addons/loaders/FBXLoader.js')],
  obj: ['OBJLoader', () => import('three/addons/loaders/OBJLoader.js')],
  pcd: ['PCDLoader', () => import('three/addons/loaders/PCDLoader.js')],
  ply: ['PLYLoader', () => import('three/addons/loaders/PLYLoader.js')],
  stl: ['STLLoader', () => import('three/addons/loaders/STLLoader.js')],
  usd: ['USDLoader', () => import('three/addons/loaders/USDLoader.js')],
  usda: ['USDLoader', () => import('three/addons/loaders/USDLoader.js')],
  usdc: ['USDLoader', () => import('three/addons/loaders/USDLoader.js')],
  usdz: ['USDLoader', () => import('three/addons/loaders/USDLoader.js')],
  vox: ['VOXLoader', () => import('three/addons/loaders/VOXLoader.js')],
  vtk: ['VTKLoader', () => import('three/addons/loaders/VTKLoader.js')],
  vtp: ['VTKLoader', () => import('three/addons/loaders/VTKLoader.js')]
};
export const supportedFormats = ['glb', 'gltf', ...Object.keys(loaders)];
const libs = new URL('./vendor/examples/jsm/libs/', import.meta.url);
let gltfLoader;

async function createGLTFLoader(renderer) {
  const [{ GLTFLoader }, { DRACOLoader }, { KTX2Loader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/loaders/DRACOLoader.js'),
    import('three/addons/loaders/KTX2Loader.js'),
    import('three/addons/libs/meshopt_decoder.module.js')
  ]);
  const draco = new DRACOLoader().setDecoderPath(new URL('draco/gltf/', libs).href);
  const ktx = new KTX2Loader().setTranscoderPath(new URL('basis/', libs).href).detectSupport(renderer);
  return new GLTFLoader().setDRACOLoader(draco).setKTX2Loader(ktx).setMeshoptDecoder(MeshoptDecoder);
}

async function loadOBJ(url, loader) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The OBJ file could not be read.');
  const source = await response.text();
  const library = /^mtllib[ \t]+([^\r\n]+)/m.exec(source)?.[1].trim();
  if (library) {
    try {
      const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
      const materials = await new MTLLoader().loadAsync(new URL(library.replaceAll('\\', '/'), url).href);
      loader.setMaterials(materials);
    } catch (error) {
      console.warn('OBJ material library could not be loaded', error);
    }
  }
  return loader.parse(source);
}

export async function loadModel(url, format, renderer) {
  if (format === 'gltf' || format === 'glb') {
    gltfLoader ??= createGLTFLoader(renderer).catch(error => {
      gltfLoader = undefined;
      throw error;
    });
    return (await (await gltfLoader).loadAsync(url)).scene;
  }
  if (!Object.hasOwn(loaders, format)) throw new Error('This file format is unsupported.');
  const [name, loadModule] = loaders[format];
  const module = await loadModule();
  const loader = new module[name]();
  if (format === 'obj') return loadOBJ(url, loader);
  let result;
  if (format === 'ply') {
    const response = await fetch(url);
    if (!response.ok) throw new Error('The PLY file could not be read.');
    const data = await response.arrayBuffer();
    const header = new TextDecoder().decode(data.slice(0, 65536)).split('end_header', 1)[0];
    result = loader.parse(data);
    if (!/^element face [1-9]\d*\s*$/m.test(header)) {
      return new THREE.Points(result, new THREE.PointsMaterial({
        size: 0.022, color: result.attributes.color ? 0xffffff : 0xc2afea,
        vertexColors: Boolean(result.attributes.color)
      }));
    }
  } else {
    result = await loader.loadAsync(url);
  }
  if (format === 'dae') return result.scene;
  if (format === 'vox') {
    const group = new THREE.Group();
    for (const chunk of result) group.add(new module.VOXMesh(chunk));
    return group;
  }
  if (result.isBufferGeometry) {
    if (format === 'stl') result.rotateX(-Math.PI / 2);
    if (!result.attributes.normal) result.computeVertexNormals();
    return new THREE.Mesh(result, new THREE.MeshStandardMaterial({
      color: result.attributes.color ? 0xffffff : 0xb7a8d3,
      roughness: 0.45, metalness: 0.18,
      vertexColors: Boolean(result.attributes.color),
      side: THREE.DoubleSide
    }));
  }
  return result;
}
