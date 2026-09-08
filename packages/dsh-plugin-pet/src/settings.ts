export const PET_SETTINGS_NAMESPACE = 'e-mate-pet'
export const PET_SIZE = 112
export interface Position { readonly x: number; readonly y: number }
export interface PetSettings { readonly enabled: boolean; readonly position: Position }
export const DEFAULT_SETTINGS: PetSettings = Object.freeze({ enabled: false, position: Object.freeze({ x: 0.97, y: 0.97 }) })
export function decodeSettings(value: unknown): PetSettings {
  const input = value !== null && typeof value === 'object' ? value as Partial<PetSettings> : {}
  const point = input.position
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_SETTINGS.enabled,
    position: point !== null && typeof point === 'object' && typeof point.x === 'number' && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1
      && typeof point.y === 'number' && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1 ? { x: point.x, y: point.y } : DEFAULT_SETTINGS.position,
  }
}
export function bounds(point: Position, viewport: { width: number; height: number }): Position {
  return { x: Math.max(0, Math.min(point.x, viewport.width - PET_SIZE)), y: Math.max(0, Math.min(point.y, viewport.height - PET_SIZE * 208 / 192)) }
}
export function pixelPosition(point: Position, viewport: { width: number; height: number }): Position {
  return bounds({ x: Math.max(0, viewport.width - PET_SIZE) * point.x, y: Math.max(0, viewport.height - PET_SIZE * 208 / 192) * point.y }, viewport)
}
export function normalizedPosition(point: Position, viewport: { width: number; height: number }): Position {
  const bounded = bounds(point, viewport)
  return { x: bounded.x / Math.max(1, viewport.width - PET_SIZE), y: bounded.y / Math.max(1, viewport.height - PET_SIZE * 208 / 192) }
}
