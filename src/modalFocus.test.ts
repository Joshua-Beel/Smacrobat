import { expect, it, vi } from 'vitest';
import { restoreModalFocus } from './modalFocus';

const target = (isConnected: boolean, disabled = false) => ({ isConnected, focus: vi.fn(), matches: () => disabled, closest: () => null });

it('returns focus to the control that opened a modal when it remains mounted', () => {
  const opener = target(true);
  const fallback = target(true);
  restoreModalFocus(opener, fallback);
  expect(opener.focus).toHaveBeenCalledOnce();
  expect(fallback.focus).not.toHaveBeenCalled();
});

it('returns focus to the menu button when a menu action unmounts its trigger', () => {
  const removedMenuItem = target(false);
  const menu = target(true);
  restoreModalFocus(removedMenuItem, menu);
  expect(removedMenuItem.focus).not.toHaveBeenCalled();
  expect(menu.focus).toHaveBeenCalledOnce();
});

it('uses the fallback when the opener remains mounted but becomes disabled', () => {
  const disabledOpener = target(true, true);
  const fallback = target(true);
  restoreModalFocus(disabledOpener, fallback);
  expect(disabledOpener.focus).not.toHaveBeenCalled();
  expect(fallback.focus).toHaveBeenCalledOnce();
});

it('uses the fallback when focusing the preferred target throws', () => {
  const unavailable = { isConnected: true, matches: () => false, closest: () => null, focus: vi.fn(() => { throw new Error('not focusable'); }) };
  const fallback = target(true);
  restoreModalFocus(unavailable, fallback);
  expect(fallback.focus).toHaveBeenCalledOnce();
});
