import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { defaultPreferences, readPreferences, savePreferences } from './preferences';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), documentPageLabels: vi.fn() }));
describe('reading preferences', () => {
  let stored: string | null;
  beforeEach(() => {
    stored = null;
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key.includes('preferences') ? stored : null, setItem: (key: string, value: string) => { if (key.includes('preferences')) stored = value; } }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('persists a theme change through an actual app unmount and remount', async () => {
    let ui!: ReactTestRenderer;
    await act(async () => { ui = create(<App />); });
    act(() => ui.root.findByProps({ 'aria-label': 'Toggle theme' }).props.onClick());
    expect(readPreferences().dark).toBe(true);
    act(() => ui.unmount());
    await act(async () => { ui = create(<App />); });
    expect(ui.root.findAllByType('div')[0].props.className).toMatch(/dark/);
    act(() => ui.unmount());
  });
  it('preserves valid settings but rejects corrupted or out-of-range values', () => {
    stored = JSON.stringify({ dark: true, zoom: 1000000, fit: 'false', hand: false, nav: true, toolsOpen: null });
    expect(readPreferences()).toEqual({ ...defaultPreferences, dark: true, hand: false, nav: true });
    for (const invalid of ['null', '[]', 'broken json']) { stored = invalid; expect(readPreferences()).toEqual(defaultPreferences); }
  });
  it('round trips all reading settings without storing document contents or paths', () => {
    const value = { dark: true, zoom: 175, fit: false, hand: false, toolsOpen: false, nav: true };
    expect(savePreferences(value)).toBe(true);
    expect(readPreferences()).toEqual(value);
    expect(Object.keys(JSON.parse(stored!)).sort()).toEqual(Object.keys(defaultPreferences).sort());
  });
  it('keeps the app usable and reports when storage is unavailable', async () => {
    Object.defineProperty(window, 'localStorage', { get: () => { throw new Error('storage blocked'); } });
    expect(readPreferences()).toEqual(defaultPreferences);
    expect(savePreferences(defaultPreferences)).toBe(false);
    let ui!: ReactTestRenderer;
    await act(async () => { ui = create(<App />); });
    expect(JSON.stringify(ui.toJSON())).toContain('could not be saved');
    act(() => ui.unmount());
  });
});
