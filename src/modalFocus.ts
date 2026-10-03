type FocusTarget = Pick<HTMLElement, 'focus' | 'isConnected'> & Partial<Pick<HTMLElement, 'matches'>>;

function available(target: FocusTarget | null): target is FocusTarget {
  return !!target?.isConnected && !target.matches?.(':disabled');
}

export function restoreModalFocus(preferred: FocusTarget | null, fallback: FocusTarget | null): void {
  const target = available(preferred) ? preferred : available(fallback) ? fallback : null;
  target?.focus();
}
