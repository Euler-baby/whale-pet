'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */
// Deterministic atlas extraction. Figure pixels come from image_gen and the v1 idle sprite.
const fs = require('node:fs')
const path = require('node:path')
const sharp = require(process.env.WHALE_SHARP_PATH || 'sharp')
const dir = __dirname
const size = 480
const actions = ['pat', 'celebrate', 'concern', 'idle-look']
const delays = {
  // 首帧快速离开 idle，预备后加速，峰值停一拍，收势放缓；末帧时长内切回 idle。
  pat: [40, 150, 105, 75, 210, 110, 150, 100],
  celebrate: [40, 145, 100, 75, 220, 120, 165, 105],
  concern: [40, 140, 105, 80, 220, 125, 170, 110],
  'idle-look': [55, 200, 165, 145, 280, 170, 260, 180],
}
const clear = { r: 0, g: 0, b: 0, alpha: 0 }

function keepLargest(data, width, height) {
  const marks = new Int32Array(width * height)
  const queue = new Int32Array(width * height)
  let largest = 0, largestSize = 0, id = 0
  for (let start = 0; start < marks.length; start++) {
    if (marks[start] || data[start * 4 + 3] < 64) continue
    const current = ++id
    let head = 0, tail = 1
    marks[start] = current
    queue[0] = start
    while (head < tail) {
      const p = queue[head++], x = p % width, y = Math.floor(p / width)
      const near = [x ? p - 1 : -1, x + 1 < width ? p + 1 : -1,
        y ? p - width : -1, y + 1 < height ? p + width : -1]
      for (const n of near) {
        if (n < 0 || marks[n] || data[n * 4 + 3] < 64) continue
        marks[n] = current
        queue[tail++] = n
      }
    }
    if (tail > largestSize) { largestSize = tail; largest = current }
  }
  if (largestSize < 5000) throw new Error('No complete figure in cell')
  for (let p = 0; p < marks.length; p++) {
    if (marks[p] === largest) continue
    let edge = false
    if (!marks[p] && data[p * 4 + 3]) {
      const x = p % width, y = Math.floor(p / width)
      for (let dy = -2; dy <= 2 && !edge; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx >= 0 && xx < width && yy >= 0 && yy < height &&
          marks[yy * width + xx] === largest) edge = true
      }
    }
    if (!edge) data[p * 4 + 3] = 0
  }
}

function bounds(data, width, height) {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] < 64) continue
    left = Math.min(left, x); top = Math.min(top, y)
    right = Math.max(right, x); bottom = Math.max(bottom, y)
  }
  if (right < left) throw new Error('Empty frame')
  return { left, top, width: right - left + 1, height: bottom - top + 1,
    bottom, cx: (left + right) / 2 }
}

async function extract(atlas, index) {
  const meta = await sharp(atlas).metadata()
  const left = Math.round((index % 4) * meta.width / 4)
  const right = Math.round((index % 4 + 1) * meta.width / 4)
  const top = Math.round(Math.floor(index / 4) * meta.height / 2)
  const bottom = Math.round((Math.floor(index / 4) + 1) * meta.height / 2)
  const raw = await sharp(atlas).extract({ left, top, width: right - left, height: bottom - top })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  keepLargest(raw.data, raw.info.width, raw.info.height)
  const box = bounds(raw.data, raw.info.width, raw.info.height)
  let sum = 0, count = 0
  for (let y = Math.max(box.top, box.bottom - 42); y <= box.bottom; y++)
    for (let x = box.left; x < box.left + box.width; x++) {
      if (raw.data[(y * raw.info.width + x) * 4 + 3] < 160) continue
      sum += x; count++
    }
  return { raw, box, shoeX: count ? sum / count : box.cx }
}

async function place(pose, scale) {
  const { raw, box } = pose
  const width = Math.round(box.width * scale)
  const height = Math.round(box.height * scale)
  const image = await sharp(raw.data, { raw: raw.info })
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .resize(width, height, { kernel: 'lanczos3' }).png().toBuffer()
  const left = Math.round(231 - width / 2)
  const top = 456 - height
  if (left < 0 || top < 0 || left + width > size || top + height > size)
    throw new Error('Pose exceeds canvas: ' + JSON.stringify({ left, top, width, height }))
  return sharp({ create: { width: size, height: size, channels: 4, background: clear } })
    .composite([{ input: image, left, top }]).png({ compressionLevel: 9 }).toBuffer()
}

async function stats(image) {
  const { data, info } = await sharp(image).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true })
  return bounds(data, info.width, info.height)
}

;(async () => {
  const idle = fs.readFileSync(path.join(dir, '..', 'whale-girl-v1', 'idle.png'))
  const report = { size, anchor: { cx: 231, bottom: 456 }, baseIdle: await stats(idle),
    actions: {}, note: 'One scale per action; silhouettes centered on base idle. Exact idle endpoints.' }
  const sheet = []
  for (const [row, action] of actions.entries()) {
    const atlas = path.join(dir, 'source', action + '-atlas.png')
    const folder = path.join(dir, 'frames', action)
    fs.mkdirSync(folder, { recursive: true })
    const poses = []
    for (let i = 0; i < 8; i++) poses.push(await extract(atlas, i))
    const scale = Math.min(424 / poses[0].box.height,
      444 / Math.max(...poses.map(p => p.box.height)),
      448 / Math.max(...poses.map(p => p.box.width)))
    const frames = [idle]
    for (let i = 1; i < 7; i++) {
      // The generated celebration crouch makes the entire figure 11% shorter and
      // reads as a zoom jump at pet size. Use the neutral anticipation pose instead.
      const pose = action === 'celebrate' && i === 1 ? poses[0] : poses[i]
      frames.push(await place(pose, scale))
    }
    frames.push(idle)
    const frameStats = []
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(folder, i + '.png'), frames[i])
      frameStats.push(await stats(frames[i]))
      sheet.push({ input: await sharp(frames[i]).resize(160, 160).png().toBuffer(),
        left: i * 160, top: row * 160 })
    }
    const webp = path.join(dir, action + '.webp')
    await sharp(frames, { join: { animated: true } }).webp({ quality: 84,
      alphaQuality: 100, effort: 6, loop: 1, delay: delays[action] }).toFile(webp)
    fs.writeFileSync(path.join(dir, action + '.png'), frames[4])
    const meta = await sharp(webp, { animated: true }).metadata()
    if (meta.pages !== 8 || meta.pageHeight !== size || !meta.hasAlpha || meta.loop !== 1)
      throw new Error('Invalid animation: ' + action)
    report.actions[action] = { scale, frameCount: 8, delay: meta.delay, frameStats,
      totalMs: delays[action].reduce((a, b) => a + b, 0), loop: meta.loop,
      width: meta.width, pageHeight: meta.pageHeight, hasAlpha: meta.hasAlpha,
      bytes: fs.statSync(webp).size, stillBytes: frames[4].length,
      firstLastExact: frames[0].equals(idle) && frames[7].equals(idle) }
  }
  await sharp({ create: { width: 1280, height: 640, channels: 4, background: clear } })
    .composite(sheet).png().toFile(path.join(dir, 'contact-sheet.png'))
  const overlay = Buffer.alloc(size * size * 4)
  const base = await sharp(idle).raw().toBuffer()
  const endpoint = await sharp(fs.readFileSync(path.join(dir, 'frames', 'celebrate', '0.png')))
    .raw().toBuffer()
  for (let p = 0; p < overlay.length; p += 4) {
    const pixel = p / 4
    const checker = (Math.floor(pixel % size / 16) + Math.floor(pixel / size / 16)) % 2
    const background = checker ? 80 : 96
    const baseAlpha = base[p + 3] / 255
    const endAlpha = endpoint[p + 3] / 255
    overlay[p] = Math.round(background * (1 - baseAlpha) * (1 - endAlpha) +
      255 * baseAlpha * (1 - endAlpha) + 235 * baseAlpha * endAlpha)
    overlay[p + 1] = Math.round(background * (1 - baseAlpha) * (1 - endAlpha) +
      255 * endAlpha * (1 - baseAlpha) + 235 * baseAlpha * endAlpha)
    overlay[p + 2] = Math.round(background * (1 - baseAlpha) * (1 - endAlpha) +
      255 * endAlpha * (1 - baseAlpha) + 235 * baseAlpha * endAlpha)
    overlay[p + 3] = 255
  }
  await sharp(overlay, { raw: { width: size, height: size, channels: 4 } })
    .png().toFile(path.join(dir, 'endpoint-overlay.png'))
  fs.writeFileSync(path.join(dir, 'animation.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(Object.fromEntries(actions.map(a => [a,
    { scale: report.actions[a].scale, bytes: report.actions[a].bytes }]))))
})().catch(error => { console.error(error); process.exitCode = 1 })
