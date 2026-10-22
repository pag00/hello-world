import type { BlobStore } from './contracts'
import type { Sha256Ref } from '../domain/types'
import { sha256Hex } from '../domain/canonical'
import { api } from '../api/endpoints'
import { getDb, getEngine, syncState } from '../sync/runtime'

const urlCache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

function hexOf(ref: Sha256Ref): string | null {
  const m = /^sha256:([0-9a-f]{64})$/.exec(ref)
  return m ? m[1]! : null
}

function objectUrl(hex: string, data: ArrayBuffer, mime: string): string {
  let url = urlCache.get(hex)
  if (!url) {
    url = URL.createObjectURL(new Blob([data], { type: mime }))
    urlCache.set(hex, url)
  }
  return url
}

async function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Response(blob).arrayBuffer()
}

async function fetchRemote(hex: string): Promise<string | null> {
  const db = getDb()
  const local = await db.blobs.get(hex)
  if (local) return objectUrl(hex, local.data, local.mime)
  if (!syncState.online.value) return null
  try {
    const blob = await api.getBlob(hex)
    const data = await readBytes(blob)
    // content-addressed: never cache bytes that do not match their name
    if ((await sha256Hex(new Uint8Array(data))) !== hex) return null
    const mime = blob.type || 'application/octet-stream'
    await db.blobs.put({ sha256: hex, data, mime, size: data.byteLength, uploaded: 1, created_at: new Date().toISOString() })
    return objectUrl(hex, data, mime)
  } catch {
    return null
  }
}

export function useBlobStore(): BlobStore & { localBlob(ref: Sha256Ref): Promise<Blob | null> } {
  return {
    async put(blob: Blob): Promise<Sha256Ref> {
      const data = await readBytes(blob)
      const hex = await sha256Hex(new Uint8Array(data))
      const db = getDb()
      await db.transaction('rw', db.blobs, async () => {
        if (!(await db.blobs.get(hex))) {
          await db.blobs.put({
            sha256: hex, data, mime: blob.type || 'application/octet-stream', size: data.byteLength, uploaded: 0,
            created_at: new Date().toISOString(),
          })
        }
      })
      getEngine().schedule()
      return `sha256:${hex}`
    },
    async url(ref: Sha256Ref): Promise<string | null> {
      const hex = hexOf(ref)
      if (!hex) return null
      const cached = urlCache.get(hex)
      if (cached) return cached
      let p = inflight.get(hex)
      if (!p) {
        p = fetchRemote(hex).finally(() => inflight.delete(hex))
        inflight.set(hex, p)
      }
      return p
    },
    async localBlob(ref: Sha256Ref): Promise<Blob | null> {
      const hex = hexOf(ref)
      const row = hex ? await getDb().blobs.get(hex) : undefined
      return row ? new Blob([row.data], { type: row.mime }) : null
    },
  }
}
