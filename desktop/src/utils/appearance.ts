import { ref } from 'vue'
import { safeSetItem } from './safe-storage'

export type AccentId = 'blue' | 'violet' | 'green' | 'orange' | 'graphite'
export type FontScaleId = 'small' | 'std' | 'large'

export const DEFAULT_ACCENT: AccentId = 'blue'
export const DEFAULT_FONT_SCALE: FontScaleId = 'std'

export const ACCENT_PRESETS: ReadonlyArray<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'blue', label: '经典蓝', swatch: '#0066cc' },
  { id: 'violet', label: '紫', swatch: '#6E56CF' },
  { id: 'green', label: '绿', swatch: '#15803D' },
  { id: 'orange', label: '橙', swatch: '#C2410C' },
  { id: 'graphite', label: '石墨', swatch: '#475569' }
]

export const FONT_SCALE_OPTIONS: ReadonlyArray<{ id: FontScaleId; label: string }> = [
  { id: 'small', label: '小' },
  { id: 'std', label: '标准' },
  { id: 'large', label: '大' }
]

const ACCENT_IDS = new Set<string>(ACCENT_PRESETS.map((preset) => preset.id))
const FONT_SCALE_IDS = new Set<string>(FONT_SCALE_OPTIONS.map((option) => option.id))

const accent = ref<AccentId>(DEFAULT_ACCENT)
const fontScale = ref<FontScaleId>(DEFAULT_FONT_SCALE)

let initialized = false

/** 默认档返回 null，表示不写 html 属性；非法值同样归一为默认档。 */
export function normalizeAccent(value: string | null | undefined): Exclude<AccentId, 'blue'> | null {
  if (!value || value === DEFAULT_ACCENT || !ACCENT_IDS.has(value)) return null
  return value as Exclude<AccentId, 'blue'>
}

export function normalizeFontScale(value: string | null | undefined): Exclude<FontScaleId, 'std'> | null {
  if (!value || value === DEFAULT_FONT_SCALE || !FONT_SCALE_IDS.has(value)) return null
  return value as Exclude<FontScaleId, 'std'>
}

export function applyAccent(id: AccentId) {
  if (typeof document === 'undefined') return
  const normalized = normalizeAccent(id)
  if (normalized) {
    document.documentElement.setAttribute('data-accent', normalized)
  } else {
    document.documentElement.removeAttribute('data-accent')
  }
}

export function applyFontScale(id: FontScaleId) {
  if (typeof document === 'undefined') return
  const normalized = normalizeFontScale(id)
  if (normalized) {
    document.documentElement.setAttribute('data-font-scale', normalized)
  } else {
    document.documentElement.removeAttribute('data-font-scale')
  }
}

function readAccent(): AccentId {
  try {
    return normalizeAccent(localStorage.getItem('aw-accent')) ?? DEFAULT_ACCENT
  } catch {
    return DEFAULT_ACCENT
  }
}

function readFontScale(): FontScaleId {
  try {
    return normalizeFontScale(localStorage.getItem('aw-font-scale')) ?? DEFAULT_FONT_SCALE
  } catch {
    return DEFAULT_FONT_SCALE
  }
}

export function setAccent(id: AccentId) {
  const normalized = normalizeAccent(id)
  accent.value = normalized ?? DEFAULT_ACCENT
  safeSetItem('aw-accent', accent.value)
  applyAccent(accent.value)
}

export function setFontScale(id: FontScaleId) {
  const normalized = normalizeFontScale(id)
  fontScale.value = normalized ?? DEFAULT_FONT_SCALE
  safeSetItem('aw-font-scale', fontScale.value)
  applyFontScale(fontScale.value)
}

function initAppearance() {
  if (initialized) return
  initialized = true

  accent.value = readAccent()
  fontScale.value = readFontScale()
  applyAccent(accent.value)
  applyFontScale(fontScale.value)
}

export function useAppearance() {
  initAppearance()

  return {
    accent,
    fontScale,
    setAccent,
    setFontScale,
    ACCENT_PRESETS,
    FONT_SCALE_OPTIONS
  }
}
