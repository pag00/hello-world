import type { BlobStore } from './contracts'
import { notImplemented } from './_stub'

export function useBlobStore(): BlobStore {
  return {
    put: () => notImplemented('blobs.put'),
    url: async () => null,
  }
}
