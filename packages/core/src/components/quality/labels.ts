// URLs printed into QR labels and travellers (ARCHITECTURE §9). Labels outlive deployments, so the
// public origin comes from config (publicOrigin) rather than whatever host the admin happens to use.
import { buildQrUrl } from '../../domain/qr'
import type { Uuid } from '../../domain/types'

export type LabelKind = 'tool' | 'ws' | 'run'

export interface LabelConfig {
  publicOrigin?: string
  basePath: string
}

export function labelOrigin(cfg: LabelConfig): string {
  if (cfg.publicOrigin) return cfg.publicOrigin
  return typeof window !== 'undefined' ? window.location.origin : ''
}

export function labelUrl(kind: LabelKind, id: string | Uuid, cfg: LabelConfig): string {
  const origin = labelOrigin(cfg)
  switch (kind) {
    case 'tool':
      return buildQrUrl({ kind: 'tool', code: id }, origin, cfg.basePath)
    case 'ws':
      return buildQrUrl({ kind: 'workstation', code: id }, origin, cfg.basePath)
    case 'run':
      return buildQrUrl({ kind: 'run', run_id: id }, origin, cfg.basePath)
  }
}

export interface Label {
  key: string
  url: string
  title: string
  subtitle?: string
}
