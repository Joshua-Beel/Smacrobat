export type FitMode = 'none' | 'width' | 'page';
export type Preferences = { dark: boolean; zoom: number; fit: FitMode; hand: boolean; toolsOpen: boolean; nav: boolean };
const key = 'pdf-workstation.preferences.v1';
export const defaultPreferences: Preferences = { dark: false, zoom: 100, fit: 'width', hand: true, toolsOpen: true, nav: false };
export function readPreferences(): Preferences {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaultPreferences };
    const result = { ...defaultPreferences };
    for (const name of ['dark', 'hand', 'toolsOpen', 'nav'] as const) {
      if (typeof value[name] === 'boolean') result[name] = value[name];
    }
    if (value.fit === 'none' || value.fit === 'width' || value.fit === 'page') result.fit = value.fit;
    else if (typeof value.fit === 'boolean') result.fit = value.fit ? 'width' : 'none';
    if (typeof value.zoom === 'number' && Number.isFinite(value.zoom) && value.zoom >= 10 && value.zoom <= 400) result.zoom = value.zoom;
    return result;
  } catch { return { ...defaultPreferences }; }
}
export function savePreferences(value: Preferences): boolean {
  try { window.localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
