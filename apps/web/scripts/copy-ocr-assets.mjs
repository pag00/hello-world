#!/usr/bin/env node
// Lay out everything tesseract.js needs under public/tesseract/ so web OCR works offline (PWA precache)
// and inside the Capacitor APK. Runs automatically from vite.config.ts (buildStart); can also be run by hand:
//   node scripts/copy-ocr-assets.mjs
//
//   public/tesseract/worker.min.js                 ← tesseract.js/dist
//   public/tesseract/core/tesseract-core{,-simd}-lstm.wasm.js   ← tesseract.js-core (LSTM-only builds)
//   public/tesseract/lang/eng.traineddata.gz       ← not on npm as a plain file: downloaded once (pinned hash)
//   public/tesseract/manifest.json                 ← tells the app which languages are actually present
//
// Env:
//   STEPTRACK_TESSDATA       path to an eng.traineddata.gz (or a directory containing it) to use instead of downloading
//   STEPTRACK_TESSDATA_URL   alternative download URL (e.g. an internal mirror); the pinned SHA-256 still applies
//   STEPTRACK_TESSDATA_SHA256  expected SHA-256 when using a different file than the pinned one
//   STEPTRACK_OCR_SKIP_DOWNLOAD=1  never touch the network (OCR is then reported unavailable unless the file exists)
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LANG = 'eng'
const DEFAULT_URL = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz'
// @tesseract.js-data/eng@1.0.0 4.0.0_best_int/eng.traineddata.gz (LSTM-only, integer model)
const PINNED_SHA256 = '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91'
const CORE_FILES = ['tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')

function log(msg) {
  console.log(`[ocr-assets] ${msg}`)
}

async function exists(p) {
  try {
    return await stat(p)
  } catch {
    return null
  }
}

async function copyIfChanged(src, dest) {
  const [a, b] = await Promise.all([stat(src), exists(dest)])
  if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) return false
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest)
  return true
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b

async function validTraineddata(path, expected) {
  const s = await exists(path)
  if (!s || s.size < 100_000) return false
  const buf = await readFile(path)
  if (!isGzip(buf)) return false
  return !expected || sha256(buf) === expected
}

async function fetchTraineddata(url, dest, expected) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (!isGzip(buf)) throw new Error('not a gzip file')
    const got = sha256(buf)
    if (expected && got !== expected) throw new Error(`SHA-256 mismatch (got ${got}, expected ${expected})`)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(`${dest}.part`, buf)
    await rename(`${dest}.part`, dest)
  } finally {
    clearTimeout(timer)
  }
}

/** @param {{ publicDir?: string, quiet?: boolean }} [opts] */
export async function copyOcrAssets(opts = {}) {
  const out = join(opts.publicDir ?? join(appRoot, 'public'), 'tesseract')
  const require = createRequire(join(appRoot, 'package.json'))
  const tjsPkg = require.resolve('tesseract.js/package.json')
  const tjsDir = dirname(tjsPkg)
  const coreDir = dirname(createRequire(tjsPkg).resolve('tesseract.js-core/package.json'))
  const tjsVersion = JSON.parse(await readFile(tjsPkg, 'utf8')).version
  const coreVersion = JSON.parse(await readFile(join(coreDir, 'package.json'), 'utf8')).version

  let changed = 0
  if (await copyIfChanged(join(tjsDir, 'dist', 'worker.min.js'), join(out, 'worker.min.js'))) changed++
  for (const f of CORE_FILES) if (await copyIfChanged(join(coreDir, f), join(out, 'core', f))) changed++

  const langFile = join(out, 'lang', `${LANG}.traineddata.gz`)
  const expected = process.env.STEPTRACK_TESSDATA_SHA256 || (process.env.STEPTRACK_TESSDATA ? '' : PINNED_SHA256)
  let haveLang = await validTraineddata(langFile, expected)
  if (!haveLang && process.env.STEPTRACK_TESSDATA) {
    let src = resolve(process.env.STEPTRACK_TESSDATA)
    if ((await exists(src))?.isDirectory()) src = join(src, `${LANG}.traineddata.gz`)
    if (await validTraineddata(src, expected)) {
      await mkdir(dirname(langFile), { recursive: true })
      await copyFile(src, langFile)
      haveLang = true
      changed++
    } else {
      log(`STEPTRACK_TESSDATA=${process.env.STEPTRACK_TESSDATA} is not a valid ${LANG}.traineddata.gz`)
    }
  }
  if (!haveLang && process.env.STEPTRACK_OCR_SKIP_DOWNLOAD !== '1') {
    const url = process.env.STEPTRACK_TESSDATA_URL || DEFAULT_URL
    try {
      log(`downloading ${LANG}.traineddata.gz from ${url}`)
      await fetchTraineddata(url, langFile, expected)
      haveLang = true
      changed++
    } catch (e) {
      log(`could not download ${LANG}.traineddata.gz (${e instanceof Error ? e.message : e})`)
    }
  }
  if (!haveLang) {
    log('WARNING: no OCR language data — the app will report OCR as unavailable (manual entry still works).')
    log('         Set STEPTRACK_TESSDATA to a local eng.traineddata.gz or allow the download, then rebuild.')
  }

  const manifest = {
    tesseract: tjsVersion,
    core: coreVersion,
    coreFiles: CORE_FILES,
    lang: haveLang ? [LANG] : [],
  }
  const manifestPath = join(out, 'manifest.json')
  const text = JSON.stringify(manifest, null, 2) + '\n'
  const prev = await readFile(manifestPath, 'utf8').catch(() => '')
  if (prev !== text) {
    await mkdir(out, { recursive: true })
    await writeFile(manifestPath, text)
    changed++
  }
  if (!opts.quiet || changed) log(`${changed ? `updated ${changed} file(s)` : 'up to date'} in ${out}`)
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copyOcrAssets().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
