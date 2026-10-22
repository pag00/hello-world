import 'fake-indexeddb/auto'

// jsdom has no object URLs; BlobImage / blob store only need a stable string per blob
if (typeof URL.createObjectURL !== 'function') {
  let n = 0
  URL.createObjectURL = () => `blob:test/${++n}`
  URL.revokeObjectURL = () => {}
}
