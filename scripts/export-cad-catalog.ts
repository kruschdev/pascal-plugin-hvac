/**
 * Export all 42 clean-room MIT procedural HVAC 3D CAD models to binary `.glb` files in `assets/cad/`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import { HVAC_CAD_CATALOG } from '../src/cad/catalog'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const outDir = path.join(rootDir, 'assets', 'cad')
fs.mkdirSync(outDir, { recursive: true })

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

const exporter = new GLTFExporter()

let exported = 0
for (const part of HVAC_CAD_CATALOG) {
  const group = part.build()
  const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      group,
      (res) => {
        if (res instanceof ArrayBuffer) resolve(res)
        else reject(new Error(`Expected binary ArrayBuffer for ${part.id}`))
      },
      (err) => reject(err),
      { binary: true },
    )
  })
  fs.writeFileSync(path.join(outDir, `${part.id}.glb`), Buffer.from(glb))
  exported += 1
}

console.log(`Exported ${exported}/${HVAC_CAD_CATALOG.length} binary .glb HVAC CAD models into assets/cad/.`)
