import { expect, it, vi } from 'vitest';
import { restoreModalFocus } from './modalFocus';

const target = (isConnected: boolean) => ({ isConnected, focus: vi.fn() });

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
