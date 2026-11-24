// Real Spark renders of POC runs from fixed head poses (what the headset draws,
// unlike pipeline.py's point previews). Needs `uv run serve.py` on :8443.
//   cd oai/e2e && node ../../examples/vr-world-poc/capture.mjs courtyard-01 courtyard-01-sharp
// Writes runs/_capture/<scene>.png: one row of poses per scene.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve playwright from the cwd (oai/e2e has it installed), not from this file.
const { chromium } = createRequire(join(process.cwd(), 'noop.js'))('playwright')
const here = dirname(fileURLToPath(import.meta.url))
const base = process.env.POC_URL ?? 'http://localhost:8443/'
const scenes = process.argv.slice(2)
const W = 768, H = 512
// [label, x, y, z (three.js: -z forward), yaw degrees (left positive)]
// POC_POSES='[["turn 180",0,0,0,180]]' overrides the default set (e.g. for 360 worlds).
const POSES = process.env.POC_POSES ? JSON.parse(process.env.POC_POSES) : [
  ['centre', 0, 0, 0, 0],
  ['lean L 20cm', -0.2, 0, 0, 0],
  ['lean R 20cm', 0.2, 0, 0, 0],
  ['step fwd 50cm', 0, 0, -0.5, 0],
  ['step L 1m', -1, 0, 0, 0],
  ['turn L 35deg', 0, 0, 0, 35],
]

const outDir = join(here, 'runs', '_capture')
mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'],
})
const page = await browser.newPage({ viewport: { width: W, height: H } })
page.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()) })
console.log('renderer:', await (async () => {
  await page.goto(base + '?scene=' + encodeURIComponent(scenes[0]))
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'
  })
})())

for (const name of scenes) {
  await page.goto(base + '?scene=' + encodeURIComponent(name))
  await page.waitForFunction(n => window.__poc && window.__poc.stats.name === n && window.__poc.stats.loadMs > 0,
    name, { timeout: 180000 })
  await page.evaluate(() => { document.getElementById('hud').style.display = 'none' })
  // Match the source framing: vertical FOV from the run's horizontal FOV.
  await page.evaluate(() => {
    const { camera, stats } = window.__poc
    const hfov = stats.meta?.settings?.hfov ?? 70
    const aspect = camera.aspect
    camera.fov = (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / aspect) * 180) / Math.PI
    camera.updateProjectionMatrix()
  })
  for (const [label, x, y, z, yaw] of POSES) {
    await page.evaluate(([x, y, z, yaw]) => {
      const { rig, camera, controls } = window.__poc
      controls.enabled = false
      rig.position.set(0, 0, 0); rig.quaternion.identity()
      camera.position.set(x, y, z)
      camera.rotation.set(0, (yaw * Math.PI) / 180, 0)
    }, [x, y, z, yaw])
    await page.waitForTimeout(1500) // let Spark re-sort for the new viewpoint
    const file = join(outDir, `${name}__${label.replace(/\W+/g, '_')}.png`)
    await page.screenshot({ path: file })
    console.log(file)
  }
}
await browser.close()
