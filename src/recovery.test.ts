import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { checkpointRecovery, restoreRecovery } from './bridge';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));

beforeEach(() => vi.clearAllMocks());

it('sends only the current document identity, revision, and page for a checkpoint', async () => {
  vi.mocked(invoke).mockResolvedValue({ documentId: 7, revision: 4, currentPage: 2 });
  await expect(checkpointRecovery(7, 4, 2)).resolves.toEqual({ documentId: 7, revision: 4, currentPage: 2 });
  expect(invoke).toHaveBeenCalledExactlyOnceWith('checkpoint_recovery', { id: 7, revision: 4, currentPage: 2 });
});

it('starts restore without sending a source or journal path', async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  await expect(restoreRecovery()).resolves.toBeNull();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('restore_recovery');
});
