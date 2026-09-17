import { Snail, Turtle, Rabbit, Zap, Rocket, type LucideIcon } from 'lucide-react'

// Machine rigidity 1–5 → an escalating slow→fast icon with a cool→warm color, so
// a too-aggressive setting (high) reads "hot" at a glance. Shared by the status
// bar and the export-review dialog.
export const RIGIDITY_INFO: Record<number, { label: string; Icon: LucideIcon; color: string }> = {
  1: { label: 'Hobby',      Icon: Snail,  color: 'text-emerald-500' },
  2: { label: 'Light hobby', Icon: Turtle, color: 'text-lime-500' },
  3: { label: 'Prosumer',   Icon: Rabbit, color: 'text-amber-500' },
  4: { label: 'Heavy',      Icon: Zap,    color: 'text-orange-500' },
  5: { label: 'Commercial', Icon: Rocket, color: 'text-red-500' },
}

export const rigidityInfo = (level: number) => RIGIDITY_INFO[level] ?? RIGIDITY_INFO[3]
