type FocusTarget = Pick<HTMLElement, 'focus' | 'isConnected'>;

export function restoreModalFocus(preferred: FocusTarget | null, fallback: FocusTarget | null): void {
  const target = preferred?.isConnected ? preferred : fallback?.isConnected ? fallback : null;
  target?.focus();
}
