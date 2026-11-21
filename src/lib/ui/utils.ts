import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Class merge helper shared by the GeoAgent UI kit. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
