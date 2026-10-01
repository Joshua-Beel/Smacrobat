import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { clearUpdateAttempt, readUpdateAttempt, writeUpdateAttempt } from './updateAttempt';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

describe('native update attempt bridge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the native recovery record', async () => {
    const attempt = { schemaVersion: 1 as const, fromVersion: '0.2.0', targetVersion: '0.3.0', phase: 'downloading' as const };
    vi.mocked(invoke).mockResolvedValue(attempt);
    await expect(readUpdateAttempt()).resolves.toEqual(attempt);
    expect(invoke).toHaveBeenCalledWith('read_update_attempt');
  });

  it('writes the exact native recovery DTO', async () => {
    const attempt = { schemaVersion: 1 as const, fromVersion: '0.2.0', targetVersion: '0.3.0', phase: 'installing' as const };
    vi.mocked(invoke).mockResolvedValue(undefined);
    await expect(writeUpdateAttempt(attempt)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('write_update_attempt', { attempt });
  });

  it('clears through the native boundary', async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await expect(clearUpdateAttempt()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith('clear_update_attempt');
  });

  it('propagates native durability failures', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('flush failed'));
    await expect(writeUpdateAttempt({ schemaVersion: 1, fromVersion: '0.2.0', targetVersion: '0.3.0', phase: 'installing' })).rejects.toThrow('flush failed');
  });
});
