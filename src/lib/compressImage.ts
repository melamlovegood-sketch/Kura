/**
 * Downscale + re-encode an image to JPEG client-side. Mobile photos are often
 * 4–12 MB; this brings a typical phone photo down to a few hundred KB, which keeps
 * both the vision-API payload and the Storage upload small and fast. Falls back to
 * the original blob on any decode failure (e.g. a HEIC the browser can't draw to a
 * canvas) so we never hang or lose the image.
 */
export async function compressImage(file: Blob, maxWidth = 1200, quality = 0.8): Promise<Blob> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); resolve(file); return }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      canvas.toBlob(
        (blob) => { URL.revokeObjectURL(url); resolve(blob ?? file) },
        'image/jpeg',
        quality,
      )
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file) }
    img.src = url
  })
}
