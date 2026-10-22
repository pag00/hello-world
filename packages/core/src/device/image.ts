// Photo normalisation shared by every camera path: bound the size, bake in the EXIF orientation and
// re-encode as JPEG. Re-encoding through a canvas drops all metadata (EXIF, GPS), which we want:
// evidence photos must not leak location data and their hash should depend on pixels only.

export const MAX_EDGE = 2048
export const JPEG_QUALITY = 0.8

/** Target size with the long edge ≤ maxEdge, aspect ratio kept, never upscaled, at least 1×1. */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error(`invalid image size ${width}×${height}`)
  }
  const long = Math.max(width, height)
  if (long <= maxEdge) return { width: Math.round(width), height: Math.round(height) }
  const k = maxEdge / long
  // the long edge is pinned to exactly maxEdge so rounding can never push it over
  return width >= height
    ? { width: maxEdge, height: Math.max(1, Math.round(height * k)) }
    : { width: Math.max(1, Math.round(width * k)), height: maxEdge }
}

async function decode(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' })
    } catch {
      // older WebViews reject the options bag; fall through to <img>, which applies EXIF itself
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

function sizeOf(src: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  return 'naturalWidth' in src ? { width: src.naturalWidth, height: src.naturalHeight } : { width: src.width, height: src.height }
}

/** Decode any browser-readable image and return a JPEG (long edge ≤ maxEdge, EXIF stripped). */
export async function compressImage(blob: Blob, maxEdge = MAX_EDGE, quality = JPEG_QUALITY): Promise<Blob> {
  const src = await decode(blob)
  try {
    const { width, height } = fitWithin(sizeOf(src).width, sizeOf(src).height, maxEdge)
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2d canvas unavailable')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(src, 0, 0, width, height)
      return await canvas.convertToBlob({ type: 'image/jpeg', quality })
    }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2d canvas unavailable')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(src, 0, 0, width, height)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG encoding failed'))), 'image/jpeg', quality),
    )
  } finally {
    if ('close' in src) src.close()
  }
}
