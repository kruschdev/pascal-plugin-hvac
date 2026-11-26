/**
 * Renders a studio-lit 42-item WebGL contact sheet (`assets/cad-material-catalog.png`),
 * individual thumbnails (`assets/cad/thumbnails/<id>.png`), and `assets/cad/catalog.json`
 * by loading every exported `.glb` via Three.js `GLTFLoader` in headless Chrome,
 * proving all 42 GLBs parse & render cleanly in a real browser.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HVAC_CAD_CATALOG } from '../src/cad/catalog'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const cadDir = path.join(rootDir, 'assets', 'cad')
const thumbsDir = path.join(cadDir, 'thumbnails')
fs.mkdirSync(thumbsDir, { recursive: true })

type CatalogMetaItem = {
  id: string
  title: string
  category: string
  codeRef: string
  glbBytes: number
  dimensionsMm?: [number, number, number]
}

const catalogItems: CatalogMetaItem[] = HVAC_CAD_CATALOG.map((part) => {
  const glbPath = path.join(cadDir, `${part.id}.glb`)
  if (!fs.existsSync(glbPath)) {
    throw new Error(`Missing ${glbPath}; run bun run export:cad first.`)
  }
  return {
    id: part.id,
    title: part.title,
    category: part.category,
    codeRef: part.codeRef,
    glbBytes: fs.statSync(glbPath).size,
  }
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
    background: #0f172a;
    color: #e2e8f0;
    font-family: system-ui, -apple-system, sans-serif;
    overflow: hidden;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 14px;
    border-bottom: 1px solid rgba(148,163,184,0.22);
    padding-bottom: 10px;
  }
  h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
  .sub { font-size: 12px; color: #94a3b8; }
  .grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 11px;
  }
  .card {
    background: #1e293b;
    border: 1px solid rgba(148,163,184,0.2);
    border-radius: 10px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .thumb {
    width: 100%;
    height: 158px;
    background: radial-gradient(circle at 50% 35%, #334155 0%, #0f172a 100%);
    display: block;
  }
  .meta { padding: 7px 9px; display: flex; flex-direction: column; gap: 2px; }
  .title { font-size: 10.5px; font-weight: 700; color: #f8fafc; line-height: 1.25; min-height: 26px; }
  .row { display: flex; justify-content: space-between; gap: 6px; font-size: 9.5px; color: #94a3b8; }
  .badge { color: #38bdf8; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .slug { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 62%; }
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
    <h1>@kruschdev/pascal-plugin-hvac: 42 Clean-Room MIT HVAC CAD Models (.glb)</h1>
    <div class="sub">Heat Pumps &amp; Furnaces · Plenums &amp; Zone Dampers · Registers &amp; Smart Controls · Duct Fittings · Linesets &amp; Condensate · 3D Cutaways</div>
  </header>
  <div id="grid" class="grid"></div>
  <script type="module">
    import * as THREE from 'three';
    import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
    import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

    const items = await (await fetch('/items.json')).json();
    const grid = document.getElementById('grid');

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(320, 240);
    renderer.setPixelRatio(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const loader = new GLTFLoader();
    let rendered = 0;

    for (const item of items) {
      const scene = new THREE.Scene();
      scene.environment = envTex;
      scene.add(new THREE.HemisphereLight(0xf8fafc, 0x334155, 1.25));
      const key = new THREE.DirectionalLight(0xffffff, 1.55);
      key.position.set(2.5, 4.0, 3.2);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0x93c5fd, 0.75);
      fill.position.set(-3.0, 1.5, -2.0);
      scene.add(fill);

      const gltf = await loader.loadAsync('/cad/' + item.id + '.glb');
      const root = gltf.scene;
      scene.add(root);
      root.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(root);
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      box.getSize(size);
      box.getCenter(center);

      const dimsMm = [
        Math.max(1, Math.round(size.x * 1000)),
        Math.max(1, Math.round(size.y * 1000)),
        Math.max(1, Math.round(size.z * 1000)),
      ];

      const maxDim = Math.max(size.x, size.y, size.z, 0.05);
      const camera = new THREE.PerspectiveCamera(34, 320 / 240, 0.005, 50);
      const dist = maxDim * 2.15;

      const isCutaway = item.id.startsWith('assembly-');
      const isCeiling =
        item.id === 'term-supply-ceiling-diffuser' ||
        item.id === 'term-exhaust-grille' ||
        item.id === 'equip-bath-exhaust-fan' ||
        item.id === 'fit-ceiling-register-box';
      const isFloorFlat =
        item.id === 'acc-condenser-pad' ||
        item.id === 'term-supply-floor-register';

      const camPos = isCutaway
        ? new THREE.Vector3(center.x + dist * 0.42, center.y + dist * 0.16, center.z + dist * 1.05)
        : isCeiling
          ? new THREE.Vector3(center.x + dist * 0.65, center.y + dist * 0.72, center.z + dist * 0.78)
          : isFloorFlat
            ? new THREE.Vector3(center.x + dist * 0.68, center.y + dist * 0.88, center.z + dist * 0.82)
            : new THREE.Vector3(center.x + dist * 0.66, center.y + dist * 0.46, center.z + dist * 0.9);
      camera.position.copy(camPos);
      camera.lookAt(center);

      renderer.clear();
      renderer.render(scene, camera);
      renderer.getContext().finish();
      const dataUrl = renderer.domElement.toDataURL('image/png');

      await fetch('/save-thumb/' + item.id, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dataUrl, dimsMm }),
      });

      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<img class="thumb" src="' + dataUrl + '" />' +
        '<div class="meta">' +
          '<div class="title">' + item.title + '</div>' +
          '<div class="row"><span class="badge">' + item.codeRef + '</span><span>' + (item.glbBytes / 1024).toFixed(1) + ' KB</span></div>' +
          '<div class="row"><span class="slug">' + item.id + '</span><span>' + dimsMm.join('x') + 'mm</span></div>' +
        '</div>';
      grid.appendChild(card);
      rendered += 1;
    }

    document.title = 'READY:' + rendered;
    await fetch('/done');
  </script>
</body>
</html>`

let resolveDone: () => void = () => {}
let doneReceived = false
const donePromise = new Promise<void>((r) => {
  resolveDone = r
})
let savedCount = 0
const dimsById = new Map<string, [number, number, number]>()

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/') {
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
    if (url.pathname === '/items.json') {
      return new Response(JSON.stringify(catalogItems), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    if (url.pathname.startsWith('/three/')) {
      const rel = url.pathname.slice('/three/'.length)
      const full = path.join(rootDir, 'node_modules', 'three', rel)
      if (fs.existsSync(full)) {
        return new Response(Bun.file(full), {
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        })
      }
    }
    if (url.pathname.startsWith('/cad/')) {
      const rel = url.pathname.slice('/cad/'.length)
      const full = path.join(cadDir, rel)
      if (fs.existsSync(full)) {
        return new Response(Bun.file(full))
      }
    }
    if (url.pathname.startsWith('/save-thumb/') && req.method === 'POST') {
      const id = url.pathname.slice('/save-thumb/'.length).replace(/[^a-z0-9-]/g, '')
      const payload = (await req.json()) as { dataUrl: string; dimsMm: [number, number, number] }
      const b64 = payload.dataUrl.replace(/^data:image\/png;base64,/, '')
      fs.writeFileSync(path.join(thumbsDir, `${id}.png`), Buffer.from(b64, 'base64'))
      dimsById.set(id, payload.dimsMm)
      savedCount += 1
      return new Response('ok')
    }
    if (url.pathname === '/done') {
      doneReceived = true
      resolveDone()
      return new Response('ok')
    }
    return new Response('Not found', { status: 404 })
  },
})

const outSheet = path.join(rootDir, 'assets', 'cad-material-catalog.png')
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
      '--virtual-time-budget=35000',
      '--window-size=1820,1780',
      `--screenshot=${outSheet}`,
      `http://127.0.0.1:${server.port}/`,
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  )
  const timer = setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch {}
  }, 90_000)
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
  if ((res.code !== 0 || savedCount !== catalogItems.length) && angleBackend !== 'swiftshader') {
    console.warn(`ANGLE=${angleBackend} saved ${savedCount}/${catalogItems.length}; retrying with swiftshader...`)
    savedCount = 0
    doneReceived = false
    res = await runChrome('swiftshader')
  }

  if (res.code !== 0 || !fs.existsSync(outSheet)) {
    console.error('Chrome render failed:', res.stderr)
    process.exit(1)
  }

  if (doneReceived) {
    await donePromise
  }
  if (savedCount !== catalogItems.length) {
    throw new Error(
      `Incomplete CAD thumbnail render: saved ${savedCount}/${catalogItems.length} thumbnails (done=${doneReceived}).`,
    )
  }

  const catalogJson = {
    plugin: '@kruschdev/pascal-plugin-hvac',
    count: catalogItems.length,
    items: catalogItems.map((it) => ({
      ...it,
      dimensionsMm: dimsById.get(it.id) ?? [0, 0, 0],
      glbPath: `assets/cad/${it.id}.glb`,
      thumbnailPath: `assets/cad/thumbnails/${it.id}.png`,
    })),
  }
  fs.writeFileSync(path.join(cadDir, 'catalog.json'), `${JSON.stringify(catalogJson, null, 2)}\n`)
  console.log(
    `Rendered ${savedCount}/${catalogItems.length} individual thumbnails + contact sheet (${Math.round(fs.statSync(outSheet).size / 1024)} KB) at ${outSheet}`,
  )
} finally {
  server.stop(true)
}
