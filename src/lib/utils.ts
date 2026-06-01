import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

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
