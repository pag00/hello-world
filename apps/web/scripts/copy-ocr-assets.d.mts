export interface OcrAssetsManifest {
  tesseract: string
  core: string
  coreFiles: string[]
  lang: string[]
}
export function copyOcrAssets(opts?: { publicDir?: string; quiet?: boolean }): Promise<OcrAssetsManifest>
