type FocusTarget = Pick<HTMLElement, 'focus' | 'isConnected'> & Partial<Pick<HTMLElement, 'matches' | 'closest'>>;

function focus(target: FocusTarget | null): boolean {
  if (!target?.isConnected || target.matches?.(':disabled,[hidden]') || target.closest?.('[inert]')) return false;
  try { target.focus(); }
  catch { return false; }
  return typeof document === 'undefined' || document.activeElement === target as unknown as Element;
}

export function restoreModalFocus(preferred: FocusTarget | null, fallback: FocusTarget | null): void {
  if (!focus(preferred)) focus(fallback);
}
