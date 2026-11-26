/**
 * Real Pascal Editor Walkthrough Video & Screenshot Recorder for `@kruschdev/pascal-plugin-hvac`.
 *
 * Connects Puppeteer to a live running Pascal Editor host (`PASCAL_EDITOR_URL`, e.g.
 * `http://127.0.0.1:3210/project/pascalhvacdemomedia`) with `@kruschdev/pascal-plugin-hvac` loaded,
 * drives real clicks and 3D camera orbits across 5 chapters:
 *   1. One-Click IMC/Manual J HVAC Auto-Populate (Air Handler, Heat Pump Condenser, Plenums, ERV, Exhaust, Ductwork) + Catalog Placement
 *   2. 3D Priority #3 Duct Routing Orbit (yielding around Plumbing DWV), Layer Filtering & 2D Floorplan View
 *   3. Interactive 3D Air Handler, Supply/Return Plenum & Joist-Bay Cutaway (Open, Orbit, Cover Off, Door Closed)
 *   4. Manual J Room-by-Room Schedule, Loads & Cross-Trade Electrical Power/Gas Handoff, and Framing Clearances
 *   5. Live Priced BOM & IECC Envelope Insulation Calculator (Labor/Markup/Tax) + Instant IMC/IECC Compliance Audit
 *
 * Encodes:
 *   - `assets/demo-walkthrough.mp4` (1280x720 H.264 +faststart, ready for `scripts/add-voiceover.sh`)
 *   - `assets/demo-walkthrough.gif` (640px wide palette-optimized README preview)
 *   - Clean screenshots in `assets/` (`demo-3d-duct-routing.png`, `demo-hvac-schedule.png`) and `MEDIA_SHOTS_DIR`
 *
 * Usage:
 *   PASCAL_EDITOR_URL=http://127.0.0.1:3210/project/pascalhvacdemomedia bun run render:walkthrough
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

type PuppeteerPageLike = {
  setViewport: (v: { width: number; height: number; deviceScaleFactor: number }) => Promise<void>
  goto: (url: string, opts: { waitUntil: string; timeout: number }) => Promise<void>
  evaluate: <R = unknown, A = unknown>(fn: (arg: A) => R, arg?: A) => Promise<R>
  screenshot: (opts: { type: 'jpeg' | 'png'; quality?: number }) => Promise<Uint8Array>
  mouse: {
    move: (x: number, y: number, opts?: { steps?: number }) => Promise<void>
    down: (opts?: { button?: 'left' | 'right' | 'middle' }) => Promise<void>
    up: (opts?: { button?: 'left' | 'right' | 'middle' }) => Promise<void>
    click: (x: number, y: number) => Promise<void>
    wheel: (opts: { deltaY: number }) => Promise<void>
  }
  on: (event: string, cb: (arg: { message?: string }) => void) => void
}

type PuppeteerBrowserLike = {
  newPage: () => Promise<PuppeteerPageLike>
  close: () => Promise<void>
  process?: () => { kill: (signal?: NodeJS.Signals | number) => boolean | void } | null
}

type PuppeteerLike = {
  launch: (opts: Record<string, unknown>) => Promise<PuppeteerBrowserLike>
}

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const outMp4 = path.join(rootDir, 'assets', 'demo-walkthrough.mp4')
const outSilentMp4 = path.join(rootDir, 'assets', 'demo-walkthrough-silent.mp4')
const outGif = path.join(rootDir, 'assets', 'demo-walkthrough.gif')
const keyframesDir = path.join(os.tmpdir(), 'pascal_hvac_walkthrough_keyframes')
const mediaShotsDir = process.env.MEDIA_SHOTS_DIR ?? path.join(rootDir, 'assets', 'screenshots')
const refreshRepoShots = process.env.REFRESH_REPO_SHOTS !== '0'
if (mediaShotsDir) fs.mkdirSync(mediaShotsDir, { recursive: true })

const targetUrl = process.env.PASCAL_EDITOR_URL
if (!targetUrl) {
  console.error('Set PASCAL_EDITOR_URL=http://127.0.0.1:3210/project/<sceneId> before running render:walkthrough.')
  process.exit(1)
}

const defaultPuppeteer = fs.existsSync('/home/krusch/homelab/lib/node_modules/puppeteer')
  ? '/home/krusch/homelab/lib/node_modules/puppeteer'
  : 'puppeteer'
const puppeteerPath = process.env.PUPPETEER_MODULE ?? defaultPuppeteer
const puppeteerMod = (await import(puppeteerPath)) as { default?: PuppeteerLike } & PuppeteerLike
const puppeteer: PuppeteerLike = puppeteerMod.default ?? puppeteerMod
const chromeBin = process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
const angleBackend = process.env.CHROME_ANGLE ?? 'gl-egl'
const ffmpegBin = process.env.FFMPEG_BIN ?? 'ffmpeg'

fs.mkdirSync(keyframesDir, { recursive: true })

const VIEW_W = 1440
const VIEW_H = 810
const CAPTURE_FPS = 10

const browser = await puppeteer.launch({
  executablePath: chromeBin,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    `--use-angle=${angleBackend}`,
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    `--window-size=${VIEW_W},${VIEW_H}`,
  ],
})

let ffmpeg: Bun.Subprocess<'pipe', 'ignore', 'pipe'> | null = null
let ffmpegFinished = false
let mp4Code = -1
let ffmpegStderr = ''
let totalFrames = 0
const chapterMarks: Array<{ label: string; frame: number; sec: number }> = []

function markChapter(label: string) {
  const sec = Number((totalFrames / CAPTURE_FPS).toFixed(1))
  chapterMarks.push({ label, frame: totalFrames, sec })
  console.log(`[t=${sec}s | frame=${totalFrames}] ${label}`)
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error('PAGEERROR:', e.message))

  console.log(`Opening real Pascal Editor at ${targetUrl}...`)
  await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 90000 })

  // Wait until the 3D canvas AND the HVAC plugin rail button are mounted & hydrated
  let sceneReady = false
  for (let i = 0; i < 120; i++) {
    const state = await page
      .evaluate(() => {
        const canvases = Array.from(document.querySelectorAll('canvas'))
        const hasCanvas = canvases.some((c) => c.getBoundingClientRect().width > 300)
        const btns = Array.from(document.querySelectorAll('button'))
        const hasHvac = btns.some(
          (b) => b.innerText.trim() === 'HVAC' || b.getAttribute('aria-label') === 'HVAC',
        )
        const hasPlugins = btns.some(
          (b) => b.innerText.trim() === 'Plugins' || b.getAttribute('aria-label') === 'Plugins',
        )
        return { hasCanvas, hasHvac, hasPlugins }
      })
      .catch(() => ({ hasCanvas: false, hasHvac: false, hasPlugins: false }))
    if (state.hasCanvas && state.hasHvac) {
      sceneReady = true
      break
    }
    if (i > 6 && state.hasCanvas && state.hasPlugins) {
      sceneReady = true
      break
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  if (!sceneReady) {
    throw new Error('Timed out waiting for Pascal Editor 3D canvas and HVAC plugin rail to hydrate')
  }
  await new Promise((r) => setTimeout(r, 3500))

  // Dismiss camera controls hint pill if present
  await page
    .evaluate(() => {
      const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss camera controls hint"]')
      if (dismiss) {
        dismiss.click()
        return
      }
      const btns = Array.from(document.querySelectorAll('button'))
      for (const b of btns) {
        const parentText = b.parentElement?.innerText ?? ''
        if (parentText.includes('Pan') && parentText.includes('Rotate') && parentText.includes('Zoom')) {
          b.click()
          break
        }
      }
    })
    .catch(() => {})
  await new Promise((r) => setTimeout(r, 500))

  // Open HVAC left-rail panel (installing from Browse plugins if not yet enabled on this scene)
  let hvacPanelOpen = false
  for (let attempt = 0; attempt < 25; attempt++) {
    const hasAutoPop = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('button')).some((b) => b.innerText.includes('Auto-Populate HVAC')),
      )
      .catch(() => false)
    if (hasAutoPop) {
      hvacPanelOpen = true
      break
    }
    await page
      .evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'))
        const hvac = btns.find(
          (b) => b.innerText.trim() === 'HVAC' || b.getAttribute('aria-label') === 'HVAC',
        )
        if (hvac) {
          hvac.click()
          return
        }
        // If Browse plugins marketplace is open, find the HVAC card and click its Install or Open button
        const installBtns = btns.filter((b) => b.innerText.trim() === 'Install')
        for (const ib of installBtns) {
          let p: HTMLElement | null = ib.parentElement
          for (let d = 0; d < 6 && p; d++) {
            const t = p.innerText ?? ''
            if (t.includes('HVAC') && t.includes('IMC/ACCA Manual J-D-S')) {
              ib.click()
              return
            }
            p = p.parentElement
          }
        }
        const browse = btns.find((b) => b.innerText.includes('Browse plugins'))
        if (browse) {
          browse.click()
          return
        }
        const plug = btns.find(
          (b) => b.innerText.trim() === 'Plugins' || b.getAttribute('aria-label') === 'Plugins',
        )
        if (plug) plug.click()
      })
      .catch(() => {})
    await new Promise((r) => setTimeout(r, 900))
  }
  if (!hvacPanelOpen) {
    throw new Error('HVAC plugin panel did not open (Auto-Populate HVAC button not found)')
  }
  // Ensure the 3D viewport tab is active (in case Browse plugins opened as a main view tab)
  await page
    .evaluate(() => {
      const btn3d = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '3D')
      if (btn3d) btn3d.click()
    })
    .catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))

  // Ensure a clean starting scene (clear any existing HVAC nodes before recording frame 1)
  await page
    .evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === 'Clear')
      if (btn) btn.click()
    })
    .catch(() => {})
  await new Promise((r) => setTimeout(r, 800))

  // Inject clean CSS hiding Next.js dev overlays + cyan chapter banner + visual click cursor ring
  await page.evaluate(() => {
    const hideDevStyle = document.createElement('style')
    hideDevStyle.textContent =
      'nextjs-portal, #__next-build-indicator, [data-nextjs-toast], [data-nextjs-dialog-overlay] {' +
      '  display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;' +
      '}'
    document.head.appendChild(hideDevStyle)

    const pill = document.createElement('div')
    pill.id = '__walkthrough_banner'
    pill.style.cssText =
      'position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:99999;' +
      'padding:7px 16px;border-radius:999px;background:rgba(10,15,28,0.92);' +
      'border:1px solid rgba(56,189,248,0.6);color:#f8fafc;font:600 13px/1.2 system-ui,sans-serif;' +
      'box-shadow:0 8px 24px rgba(0,0,0,0.45);pointer-events:none;white-space:nowrap;'
    pill.textContent = '1 / 5 · Pascal Editor + HVAC IMC/Manual J Plugin (Ready)'
    document.body.appendChild(pill)

    const cursor = document.createElement('div')
    cursor.id = '__walkthrough_cursor'
    cursor.style.cssText =
      'position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;' +
      'border-radius:999px;border:3px solid #38bdf8;background:rgba(56,189,248,0.28);' +
      'box-shadow:0 0 14px rgba(56,189,248,0.75);z-index:99999;pointer-events:none;' +
      'transition:transform 0.14s ease;'
    document.body.appendChild(cursor)
  })

  // Collapse narrow left icon menu so the 3D Two-Bedroom House gets maximum widescreen space
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => x.getAttribute('aria-label') === 'Hide menu' || x.innerText.trim() === 'Hide menu',
    )
    if (b) b.click()
  })
  await new Promise((r) => setTimeout(r, 500))

  // Pre-frame the Two-Bedroom House in a clean 3/4 architectural overview
  const initCanvasCenter = await page.evaluate(() => {
    const c = Array.from(document.querySelectorAll('canvas')).find((x) => x.getBoundingClientRect().width > 300)
    const r = c?.getBoundingClientRect()
    return r ? { cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) } : { cx: 920, cy: 420 }
  })
  await page.mouse.move(initCanvasCenter.cx, initCanvasCenter.cy)
  await page.mouse.wheel({ deltaY: 55 })
  await new Promise((r) => setTimeout(r, 180))
  await page.mouse.down({ button: 'right' })
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(initCanvasCenter.cx + i * 24, initCanvasCenter.cy + i * 14)
    await new Promise((r) => setTimeout(r, 50))
  }
  await page.mouse.up({ button: 'right' })
  await new Promise((r) => setTimeout(r, 800))

  const ffmpegProc = Bun.spawn(
    [
      ffmpegBin,
      '-y',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-r',
      String(CAPTURE_FPS),
      '-i',
      '-',
      '-vf',
      'scale=1280:720:flags=lanczos',
      '-r',
      '24',
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outSilentMp4,
    ],
    { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' },
  )
  ffmpeg = ffmpegProc

  async function setBanner(text: string) {
    await page.evaluate((txt: string) => {
      const el = document.getElementById('__walkthrough_banner')
      if (el) el.textContent = txt
    }, text)
  }

  async function moveCursor(x: number, y: number) {
    await page.evaluate(
      ([cx, cy]: [number, number]) => {
        const el = document.getElementById('__walkthrough_cursor')
        if (el) {
          el.style.left = `${cx}px`
          el.style.top = `${cy}px`
        }
      },
      [x, y],
    )
  }

  async function pulseCursor(active: boolean) {
    await page.evaluate((on: boolean) => {
      const el = document.getElementById('__walkthrough_cursor')
      if (el) el.style.transform = on ? 'scale(1.55)' : 'scale(1)'
    }, active)
  }

  async function captureCleanShot(mediaFilename: string, repoAssetFilename?: string) {
    if (!mediaShotsDir && (!refreshRepoShots || !repoAssetFilename)) return
    await page.evaluate(() => {
      const b = document.getElementById('__walkthrough_banner')
      const c = document.getElementById('__walkthrough_cursor')
      if (b) b.style.display = 'none'
      if (c) c.style.display = 'none'
    })
    await new Promise((r) => setTimeout(r, 140))
    const png = await page.screenshot({ type: 'png' })
    if (mediaShotsDir) {
      fs.writeFileSync(path.join(mediaShotsDir, mediaFilename), png)
    }
    if (refreshRepoShots && repoAssetFilename) {
      fs.writeFileSync(path.join(rootDir, 'assets', repoAssetFilename), png)
    }
    await page.evaluate(() => {
      const b = document.getElementById('__walkthrough_banner')
      const c = document.getElementById('__walkthrough_cursor')
      if (b) b.style.display = ''
      if (c) c.style.display = ''
    })
  }

  async function captureFrames(count: number, delayMs = 80, saveKeyframeName?: string, staticHold = false) {
    if (staticHold && count > 2) {
      let lastJpeg: Uint8Array | null = null
      for (let i = 0; i < 2; i++) {
        lastJpeg = await page.screenshot({ type: 'jpeg', quality: 92 })
        ffmpegProc.stdin.write(lastJpeg)
        totalFrames += 1
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      }
      if (lastJpeg) {
        if (saveKeyframeName) {
          fs.writeFileSync(path.join(keyframesDir, `${saveKeyframeName}.jpg`), lastJpeg)
        }
        for (let i = 2; i < count; i++) {
          ffmpegProc.stdin.write(lastJpeg)
          totalFrames += 1
        }
      }
      return
    }

    for (let i = 0; i < count; i++) {
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 92 })
      ffmpegProc.stdin.write(jpeg)
      totalFrames += 1
      if (saveKeyframeName && i === Math.floor(count / 2)) {
        fs.writeFileSync(path.join(keyframesDir, `${saveKeyframeName}.jpg`), jpeg)
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    }
  }

  async function findButtonRect(needle: string, exact = false): Promise<{ x: number; y: number } | null> {
    return page.evaluate(
      ([txt, isExact]: [string, boolean]) => {
        const btns = Array.from(document.querySelectorAll('button'))
        const match = btns.find((b) => {
          const r = b.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) return false
          const label = b.innerText.trim()
          const aria = b.getAttribute('aria-label') ?? ''
          if (isExact) return label === txt || aria === txt
          return label.includes(txt) || aria.includes(txt)
        })
        if (!match) return null
        match.scrollIntoView({ block: 'nearest' })
        const r = match.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      },
      [needle, exact],
    )
  }

  async function smoothClickButton(needle: string, exact = false, holdBefore = 6, holdAfter = 14, kf?: string) {
    const rect = await findButtonRect(needle, exact)
    if (!rect) {
      console.warn(`Button not found: "${needle}"`)
      return false
    }
    await moveCursor(rect.x, rect.y)
    await captureFrames(holdBefore, 80, undefined, true)
    await pulseCursor(true)
    await page.mouse.click(rect.x, rect.y)
    await captureFrames(3, 80)
    await pulseCursor(false)
    await captureFrames(holdAfter, 90, kf, true)
    return true
  }

  async function dragOrbit(
    startX: number,
    startY: number,
    dx: number,
    dy: number,
    steps: number,
    button: 'left' | 'right' = 'right',
    kf?: string,
  ) {
    await page.mouse.move(startX, startY)
    await moveCursor(startX, startY)
    await page.mouse.down({ button })
    for (let i = 1; i <= steps; i++) {
      const nx = Math.round(startX + (dx * i) / steps)
      const ny = Math.round(startY + (dy * i) / steps)
      await page.mouse.move(nx, ny)
      await moveCursor(nx, ny)
      const jpeg = await page.screenshot({ type: 'jpeg', quality: 92 })
      ffmpegProc.stdin.write(jpeg)
      totalFrames += 1
      if (kf && i === Math.floor(steps / 2)) {
        fs.writeFileSync(path.join(keyframesDir, `${kf}.jpg`), jpeg)
      }
      await new Promise((r) => setTimeout(r, 65))
    }
    await page.mouse.up({ button })
  }

  // ─── CHAPTER 1: Real Pascal Two-Bedroom House + One-Click HVAC Auto-Populate ──
  markChapter('Chapter 1: One-Click HVAC Auto-Populate & Catalog Placement')
  await setBanner('1 / 5 · Shared Mechanical Room + Live Plumbing · Ready for One-Click IMC / Manual J HVAC')
  await captureCleanShot('01-pascal-hvac-before-autopop.png')
  await captureFrames(18, 80, '01_before_autopop', true)

  await setBanner('1 / 5 · One-Click Auto-Populate: Manual J Loads, Mechanical Room AHU/ERV & 3D Ductwork')
  await smoothClickButton('Auto-Populate HVAC', false, 6, 30, '02_after_autopop')

  // Place a Smart Wi-Fi Thermostat from the 42-model catalog quick-placer
  await setBanner('1 / 5 · 42-Model MIT CAD Catalog -> 1-Click Place Smart Wi-Fi Thermostat (18/8)')
  await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'))
    const termSel = selects.find((s) => Array.from(s.options).some((o) => o.value === 'smart-thermostat'))
    if (termSel) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
      setter?.call(termSel, 'smart-thermostat')
      termSel.dispatchEvent(new Event('change', { bubbles: true }))
    }
  })
  await smoothClickButton('+ Term', true, 5, 16, '02b_place_thermostat')

  // ─── CHAPTER 2: 3D Priority #3 Duct Routing Orbit, Layer Toggles & 2D Blueprint ──
  markChapter('Chapter 2: 3D Priority #3 Duct Routing, Layer Filters & 2D Floorplan')
  await setBanner('2 / 5 · 3D Priority #3 Duct Routing: Color-Coded Supply, Return, ERV, Lineset & Condensate')
  await captureCleanShot('02-pascal-hvac-3d-routing.png', 'demo-3d-duct-routing.png')

  // Zoom in gently and orbit around the 3D ductwork yielding around Priority #2 Plumbing DWV
  await page.mouse.move(initCanvasCenter.cx, initCanvasCenter.cy)
  await moveCursor(initCanvasCenter.cx, initCanvasCenter.cy)
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel({ deltaY: -85 })
    await captureFrames(3, 80)
  }
  await dragOrbit(initCanvasCenter.cx - 80, initCanvasCenter.cy + 10, 210, -22, 18, 'right', '03a_duct_orbit_1')
  await captureFrames(10, 80, undefined, true)
  await dragOrbit(initCanvasCenter.cx + 110, initCanvasCenter.cy - 10, -170, 20, 15, 'right', '03b_duct_orbit_2')
  await captureFrames(10, 80, undefined, true)

  // Demonstrate duct layer toggle pills in the HVAC rail (toggle Supply Branch off & back on)
  await setBanner('2 / 5 · Live Mechanical Layer Isolation: Supply, Return, Fresh Air ERV, Exhaust & Lineset')
  await smoothClickButton('Supply Branch', false, 4, 12, '03c_layer_toggle')
  await smoothClickButton('Supply Branch', false, 4, 10)

  // Capture crisp Low Walls view if available, then brief 2D floorplan peek
  await setBanner('2 / 5 · Live Color-Matched 2D HVAC Duct & Mechanical Floorplan')
  await smoothClickButton('2D', true, 4, 20, '03d_2d_floorplan')
  await captureCleanShot('03-pascal-hvac-2d-floorplan.png')
  await smoothClickButton('3D', true, 3, 10)

  // ─── CHAPTER 3: Interactive 3D Air Handler, Plenum & Joist-Bay Cutaway ──────
  markChapter('Chapter 3: Live 3D Air Handler, Supply/Return Plenum & Joist-Bay Cutaway')
  await setBanner('3 / 5 · Opening 3D Air Handler, Plenum & Joist-Bay Cutaway in Pascal Split Pane')
  await smoothClickButton('3D Air Handler Cutaway', false, 6, 18)

  // Collapse left rail panel so the 3D house + Cutaway split pane get full widescreen room
  const closeRailBtn = await findButtonRect('Close panel', true)
  if (closeRailBtn) {
    await page.mouse.click(closeRailBtn.x, closeRailBtn.y)
    await new Promise((r) => setTimeout(r, 700))
  }
  // Find the live 3D Air Handler Cutaway canvas and give it a tiny settle drag so all shaders flush cleanly on hardware EGL
  const cutawayCanvasRect = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'))
    const rightMost = canvases
      .map((c) => c.getBoundingClientRect())
      .filter((r) => r.width > 200 && r.height > 200)
      .sort((a, b) => b.x - a.x)[0]
    return rightMost
      ? { x: Math.round(rightMost.x + rightMost.width / 2), y: Math.round(rightMost.y + rightMost.height / 2) }
      : null
  })
  if (cutawayCanvasRect) {
    await page.mouse.move(cutawayCanvasRect.x, cutawayCanvasRect.y)
    await page.mouse.down({ button: 'left' })
    await page.mouse.move(cutawayCanvasRect.x + 8, cutawayCanvasRect.y)
    await page.mouse.up({ button: 'left' })
    await new Promise((r) => setTimeout(r, 400))
  }
  await moveCursor(-40, -40)
  await captureFrames(18, 90, '04_cutaway_joist_bay', true)
  await captureCleanShot('04-pascal-hvac-cutaway-open.png')

  // Drag-orbit the live 3D Air Handler Cutaway canvas on the right split pane!
  await setBanner('3 / 5 · Interactive 3D Orbit: Evaporator A-Coil, ECM Blower, MERV-13 Filter & Balancing Dampers')
  if (cutawayCanvasRect) {
    await dragOrbit(cutawayCanvasRect.x - 50, cutawayCanvasRect.y, 130, 0, 14, 'left', '05_cutaway_orbit')
    await captureFrames(8, 80, undefined, true)
  }

  await setBanner('3 / 5 · Cutaway Modes: Cabinet Cover Off & Cabinet Door Closed (Service Mode)')
  await smoothClickButton('Cabinet Cover Off', true, 4, 14, '05b_cover_off')
  await smoothClickButton('Cabinet Door Closed', true, 4, 16, '05c_door_closed')
  await captureCleanShot('05-pascal-hvac-cutaway-closed.png')
  await smoothClickButton('Joist-Bay & Open Air Handler', true, 4, 12)

  // ─── CHAPTER 4: Manual J Schedule, Loads & Power/Gas Handoff, Framing ───────
  markChapter('Chapter 4: Manual J Schedule, Cross-Trade Electrical/Gas Handoff & Framing Clearances')
  await setBanner('4 / 5 · Room-by-Room ACCA Manual J Load & Airflow Schedule + Ductwork Summary')
  await smoothClickButton('Manual J (', false, 5, 26, '06_manual_j')
  await captureCleanShot('06-pascal-hvac-manual-j-schedule.png', 'demo-hvac-schedule.png')

  await setBanner('4 / 5 · Manual S Sizing, R-454B Lineset, ASHRAE 62.2 ERV & NEC Art. 440 Electrical Handoff')
  await smoothClickButton('Loads & Power/Gas', true, 5, 24, '06b_loads_power')
  await captureCleanShot('07-pascal-hvac-loads-power-gas.png')

  await setBanner('4 / 5 · Structural & Bones Framing Clearances (IRC R502.8 / R602.6 / Soffits)')
  await smoothClickButton('Framing & Soffits', false, 5, 18, '06c_framing')

  // ─── CHAPTER 5: Live Priced BOM + IECC Insulation & IMC/IECC Audit ──────────
  markChapter('Chapter 5: Live Priced BOM + IECC Envelope Insulation & IMC/IECC Audit')
  await setBanner('5 / 5 · Priced BOM & IECC Envelope Insulation Takeoff (Live Labor $/hr, Markup % & Tax %)')
  await smoothClickButton('BOM ($', false, 5, 14)

  // Live-edit Labor Rate, Markup %, and Sales Tax % so viewers see real-time recalculation
  await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="number"]'))
    const setReactVal = (el: HTMLInputElement | undefined, val: string) => {
      if (!el) return
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    if (inputs.length >= 3) {
      setReactVal(inputs[0], '115')
      setReactVal(inputs[1], '15')
      setReactVal(inputs[2], '8.25')
    }
  })
  await moveCursor(-40, -40)
  await captureFrames(24, 85, '07_bom_takeoff', true)
  await captureCleanShot('08-pascal-hvac-bom-iecc-takeoff.png')

  await setBanner('5 / 5 · Live IMC / Manual D / IECC / NEC 110.26(E) Audit: 0 Errors · 0 Warnings (PASS)')
  await smoothClickButton('IMC Audit (', false, 5, 24, '08_imc_audit')
  await captureCleanShot('09-pascal-hvac-imc-audit-pass.png')

  // Finish encoding
  ffmpegProc.stdin.end()
  mp4Code = await ffmpegProc.exited
  ffmpegFinished = true
  if (mp4Code !== 0) {
    ffmpegStderr = await new Response(ffmpegProc.stderr).text()
  }
} finally {
  if (ffmpeg && !ffmpegFinished) {
    try {
      ffmpeg.stdin.end()
    } catch {}
    try {
      ffmpeg.kill('SIGTERM')
    } catch {}
    try {
      await Promise.race([ffmpeg.exited, new Promise((r) => setTimeout(r, 1500))])
    } catch {}
    try {
      ffmpeg.kill('SIGKILL')
    } catch {}
  }
  try {
    await browser.close()
  } catch {}
  try {
    browser.process?.()?.kill('SIGKILL')
  } catch {}
}

if (mp4Code !== 0 || !fs.existsSync(outSilentMp4)) {
  console.error('FFmpeg MP4 encode failed:', ffmpegStderr)
  process.exit(1)
}

// Copy silent MP4 to demo-walkthrough.mp4 as baseline (scripts/add-voiceover.sh muxes narrated AAC into demo-walkthrough.mp4)
fs.copyFileSync(outSilentMp4, outMp4)
const durSec = Number((totalFrames / CAPTURE_FPS).toFixed(1))
console.log(
  `Encoded REAL Pascal Editor HVAC walkthrough MP4: ${outMp4} (${Math.round(fs.statSync(outMp4).size / 1024)} KB, ${totalFrames} frames, ~${durSec}s)`,
)
console.log('Chapter timestamps:', JSON.stringify(chapterMarks))

const gifProc = Bun.spawn(
  [
    ffmpegBin,
    '-y',
    '-i',
    outMp4,
    '-vf',
    'fps=5,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
    outGif,
  ],
  { stdout: 'ignore', stderr: 'pipe' },
)
const gifCode = await gifProc.exited
if (gifCode !== 0 || !fs.existsSync(outGif)) {
  console.error('FFmpeg GIF encode failed:', await new Response(gifProc.stderr).text())
  process.exit(1)
}
console.log(`Encoded REAL Pascal Editor HVAC GIF: ${outGif} (${Math.round(fs.statSync(outGif).size / 1024)} KB)`)
