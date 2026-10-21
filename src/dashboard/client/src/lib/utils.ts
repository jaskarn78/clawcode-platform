/**
 * Phase 116 — shadcn/ui canonical `cn()` helper.
 *
 * Combines clsx (conditional class composition) with tailwind-merge (conflict
 * resolution — e.g. `bg-red-500 bg-blue-500` collapses to `bg-blue-500`).
 * Every shadcn primitive imports this; keep the export name + path stable.
 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
