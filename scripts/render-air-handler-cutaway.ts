/**
 * Renders a high-resolution 4-panel showcase (`assets/demo-air-handler-cutaway.png`)
 * of the 3D Air Handler, Supply/Return Plenum & Joist-Bay Cutaway CAD models plus
 * Commercial Packaged Rooftop Unit (RTU) via Three.js GLTFLoader in headless Chrome.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { buildWiredAirHandlerCutawayCad } from '../src/cad/plenum-cutaway'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const cadDir = path.join(rootDir, 'assets', 'cad')
const outImg = path.join(rootDir, 'assets', 'demo-air-handler-cutaway.png')

if (typeof globalThis.FileReader === 'undefined') {
  // @ts-expect-error minimal FileReader polyfill for GLTFExporter
  globalThis.FileReader = class {
    result: ArrayBuffer | null = null
    onloadend: (() => void) | null = null
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf
        this.onloadend?.()
      })
    }
  }
}

// Export an in-memory binary GLB for the Cabinet Door Closed cutaway mode so all 3 live UI modes + RTU are shown
const exporter = new GLTFExporter()
const closedGroup = buildWiredAirHandlerCutawayCad({
  coolingTons: 3.5,
  viewMode: 'cabinet-closed',
  branches: [
    { index: 0, label: 'Living Room', cfm: 280, diameterIn: 8, side: 'supply' },
    { index: 1, label: 'Bedroom 1', cfm: 160, diameterIn: 6, side: 'supply' },
    { index: 2, label: 'Bedroom 2', cfm: 140, diameterIn: 6, side: 'supply' },
    { index: 3, label: 'Kitchen', cfm: 180, diameterIn: 7, side: 'supply' },
  ],
})
const closedGlb = await new Promise<ArrayBuffer>((resolve, reject) => {
  exporter.parse(
    closedGroup,
    (res) => {
      if (res instanceof ArrayBuffer) resolve(res)
      else reject(new Error('Expected binary ArrayBuffer for closed cutaway'))
    },
    (err) => reject(err),
    { binary: true },
  )
})

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px;
    background: #0b1220;
    color: #e2e8f0;
    font-family: system-ui, -apple-system, sans-serif;
    overflow: hidden;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 14px;
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(148,163,184,0.22);
  }
  h1 { margin: 0; font-size: 19px; }
  .sub { font-size: 12px; color: #94a3b8; }
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }
  .panel {
    background: #111c32;
    border: 1px solid rgba(148,163,184,0.25);
    border-radius: 12px;
    overflow: hidden;
  }
  img { width: 100%; height: 550px; object-fit: cover; display: block; background: #0b1220; }
  .cap { padding: 10px 14px; }
  .cap strong { display: block; font-size: 13px; color: #f8fafc; margin-bottom: 3px; }
  .cap span { font-size: 11px; color: #94a3b8; }
</style>
<script type="importmap">
{
  "imports": {
    "three": "/three/build/three.module.js",
    "three/addons/": "/three/examples/jsm/"
  }
}
</script>
</head>
<body>
  <header>
    <h1>3D Air Handler, Plenum &amp; Joist-Bay Cutaway + Commercial Packaged RTU</h1>
    <div class="sub">Interactive in Pascal Schedule View ("3D Air Handler Cutaway") with evaporator A-coil, ECM blower, MERV-13 filter rack, SS2 pan switch, and balancing dampers</div>
  </header>
  <div id="grid" class="grid"></div>
  <script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

    const shots = [
      {
        url: '/cad/assembly-air-handler-joist-cutaway.glb',
        title: '1. Joist-Bay & Open Air Handler',
        sub: '16" OC joists, blue supply trunk & manual balancing dampers, violet return drop & open cabinet',
        camDir: [0.28, 0.14, 1.0],
        distMul: 2.35,
        targetOffset: [0.02, 0.0, 0.0],
      },
      {
        url: '/cad/assembly-air-handler-open-plenum.glb',
        title: '2. Zoom: A-Coil, ECM Blower & MERV-13',
        sub: 'Sloped aluminum evaporator A-coil, copper lineset stubs, blower wheel, filter rack & SS2 switch',
        camDir: [0.16, 0.04, 1.0],
        distMul: 1.15,
        targetOffset: [-0.22, -0.14, 0.0],
      },
      {
        url: '/virtual/cabinet-closed.glb',
        title: '3. Cabinet Door Closed (Service Mode)',
        sub: 'Seated service access panel with exposed plenums, balancing dampers & IMC 307.2 overflow pan',
        camDir: [0.32, 0.12, 1.0],
        distMul: 2.25,
        targetOffset: [0.02, -0.02, 0.0],
      },
      {
        url: '/cad/equip-rooftop-rtu.glb',
        title: '4. Commercial Packaged Rooftop Unit',
        sub: 'Light-commercial packaged RTU w/ condenser fan shrouds, economizer louvers & curb interface',
        camDir: [0.82, 0.54, 0.92],
        distMul: 2.9,
        targetOffset: [0.0, 0.0, 0.0],
      },
    ];

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(460, 580);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const loader = new GLTFLoader();
    const grid = document.getElementById('grid');

    for (const s of shots) {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0b1220);
      scene.environment = envTex;
      scene.add(new THREE.HemisphereLight(0xf8fafc, 0x334155, 1.25));
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(2.0, 2.8, 3.4);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x93c5fd, 0.85);
      fill.position.set(-2.4, 0.9, 2.2);
      scene.add(fill);

      const gltf = await loader.loadAsync(s.url);
      scene.add(gltf.scene);
      gltf.scene.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const maxDim = Math.max(size.x, size.y, size.z, 0.5);
      const camera = new THREE.PerspectiveCamera(36, 460 / 580, 0.01, 30);
      const target = new THREE.Vector3(
        center.x + size.x * s.targetOffset[0],
        center.y + size.y * s.targetOffset[1],
        center.z + size.z * s.targetOffset[2],
      );
      const dir = new THREE.Vector3(s.camDir[0], s.camDir[1], s.camDir[2]).normalize();
      camera.position.copy(target).addScaledVector(dir, maxDim * s.distMul);
      camera.lookAt(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.getContext().finish();

      const card = document.createElement('div');
      card.className = 'panel';
      card.innerHTML =
        '<img src="' + renderer.domElement.toDataURL('image/png') + '" />' +
        '<div class="cap"><strong>' + s.title + '</strong><span>' + s.sub + '</span></div>';
      grid.appendChild(card);
    }
    document.title = 'DONE';
  </script>
</body>
</html>`

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (url.pathname === '/virtual/cabinet-closed.glb') {
      return new Response(new Uint8Array(closedGlb), { headers: { 'content-type': 'model/gltf-binary' } })
    }
    if (url.pathname.startsWith('/three/')) {
      const full = path.join(rootDir, 'node_modules', 'three', url.pathname.slice('/three/'.length))
      if (fs.existsSync(full)) {
        return new Response(Bun.file(full), { headers: { 'content-type': 'application/javascript; charset=utf-8' } })
      }
    }
    if (url.pathname.startsWith('/cad/')) {
      const full = path.join(cadDir, url.pathname.slice('/cad/'.length))
      if (fs.existsSync(full)) return new Response(Bun.file(full))
    }
    return new Response('Not found', { status: 404 })
  },
})

const chromeBin = process.env.CHROME_BIN || '/usr/bin/google-chrome'
const angleBackend = process.env.CHROME_ANGLE || 'gl-egl'

async function runChrome(angle: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(
    [
      chromeBin,
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--use-gl=angle',
      `--use-angle=${angle}`,
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--virtual-time-budget=20000',
      '--window-size=1920,760',
      `--screenshot=${outImg}`,
      `http://127.0.0.1:${server.port}/`,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  const timer = setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch {}
  }, 60_000)
  try {
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    return { code, stderr }
  } finally {
    clearTimeout(timer)
    try {
      proc.kill('SIGKILL')
    } catch {}
  }
}

try {
  let res = await runChrome(angleBackend)
  if ((res.code !== 0 || !fs.existsSync(outImg)) && angleBackend !== 'swiftshader') {
    res = await runChrome('swiftshader')
  }
  if (res.code !== 0 || !fs.existsSync(outImg)) {
    console.error('Cutaway close-up render failed:', res.stderr)
    process.exit(1)
  }
  console.log(`Rendered air handler cutaway showcase (${Math.round(fs.statSync(outImg).size / 1024)} KB) at ${outImg}`)
} finally {
  server.stop(true)
}
