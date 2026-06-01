import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { compressImage } from '@/lib/compressImage'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatAmount(amount: number): string {
  return `¥${amount.toFixed(0)}`
}

export function formatMonth(month: string): string {
  const [y, m] = month.split('-')
  return `${y}年${Number(m)}月`
}

/** Convert a File/Blob to a base64 data URI */
export async function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

/**
 * Downscale + re-encode an image, THEN base64-encode it — the form the vision model
 * (routeIntent) consumes inline. Mobile photos are 4–12 MB; sending the raw data URI
 * makes that request balloon and hang/fail, so any screenshot handed to the model AS
 * base64 must come through here. Call sites that instead pass a File to analyzeImage /
 * uploadWishlistImage don't need this — those compress the File internally.
 */
export async function fileToCompressedBase64(file: Blob): Promise<string> {
  return fileToBase64(await compressImage(file))
}
