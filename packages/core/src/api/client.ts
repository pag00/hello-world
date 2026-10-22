// Minimal API client. The core-data workstream extends this with typed endpoint helpers
// (types generated from server OpenAPI into ./schema.d.ts during integration).
import { getStepTrackConfig } from '../config'

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message)
  }
}

export class OfflineError extends Error {
  constructor() {
    super('offline')
  }
}

export async function apiRequest<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const cfg = getStepTrackConfig()
  const headers = new Headers(init?.headers)
  const auth = await cfg.auth.getAuthorizationHeader()
  if (auth) headers.set('Authorization', auth)
  let payload: BodyInit | undefined
  if (body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array) {
    payload = body as BodyInit
  } else if (body !== undefined) {
    headers.set('Content-Type', 'application/json')
    payload = JSON.stringify(body)
  }
  let res: Response
  try {
    res = await fetch(cfg.apiBaseUrl + path, { ...init, method, headers, body: payload })
  } catch {
    throw new OfflineError()
  }
  const text = res.status === 204 ? '' : await res.text()
  const data = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text
  if (!res.ok) {
    const detail = typeof data === 'object' && data && 'detail' in data ? String((data as { detail: unknown }).detail) : res.statusText
    throw new ApiError(res.status, data, `${method} ${path}: ${res.status} ${detail}`)
  }
  return data as T
}

/** Raw request (blobs, HEAD, PDFs): same auth and offline mapping as apiRequest, returns the Response. */
export async function apiFetch(method: string, path: string, init?: RequestInit): Promise<Response> {
  const cfg = getStepTrackConfig()
  const headers = new Headers(init?.headers)
  const auth = await cfg.auth.getAuthorizationHeader()
  if (auth) headers.set('Authorization', auth)
  let res: Response
  try {
    res = await fetch(cfg.apiBaseUrl + path, { ...init, method, headers })
  } catch {
    throw new OfflineError()
  }
  if (!res.ok && !(method === 'HEAD' && res.status === 404)) {
    let body: unknown = null
    try {
      body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, body, `${method} ${path}: ${res.status} ${res.statusText}`)
  }
  return res
}
