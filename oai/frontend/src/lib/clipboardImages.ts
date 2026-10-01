/**
 * Image files carried by a paste event, or `[]` when the paste is text.
 *
 * Apps like Word put a rendered PNG on the clipboard alongside the copied
 * text, so any non-empty `text/plain` wins: the paste stays a normal text
 * paste and no image is extracted.
 */
export function pastedImageFiles(data: DataTransfer | null): File[] {
  if (!data) return []
  if (data.getData('text/plain').trim()) return []
  const files: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue
    const file = item.getAsFile()
    if (file) files.push(withPasteName(file, files.length))
  }
  return files
}

/** Screenshots arrive as a generic `image.png` (or nameless); give them a distinguishable name. */
function withPasteName(file: File, index: number): File {
  if (file.name && !/^image\.\w+$/i.test(file.name)) return file
  const ext = file.type.split('/')[1]?.split('+')[0].replace('jpeg', 'jpg') || 'png'
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
  const suffix = index > 0 ? `-${index + 1}` : ''
  return new File([file], `pasted-${stamp}${suffix}.${ext}`, { type: file.type })
}
