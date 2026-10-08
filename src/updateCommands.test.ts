import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { checkForUpdate, type DownloadEvent } from './updateCommands';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class { onmessage: (event: unknown) => void = () => {}; }
}));

const offer = { currentVersion: '0.2.0', version: '0.3.0', body: 'Notes', signature: 'c2ln' };
const forbidden = ['proxy', 'headers', 'target', 'allowDowngrades', 'endpoints', 'pubkey', 'timeout', 'restartAfterInstall', 'rid'];
const sentKeys = () => vi.mocked(invoke).mock.calls.flatMap(([, args]) => {
  const record = (args ?? {}) as Record<string, unknown>;
  return [...Object.keys(record), ...Object.keys((record.update ?? {}) as object)];
});

describe('app-owned updater commands', () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); });

  it('checks through the app command with no webview-supplied options', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    expect(await checkForUpdate()).toBeNull();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('check_for_update');
    expect(vi.mocked(invoke).mock.calls.some(([command]) => String(command).startsWith('plugin:updater'))).toBe(false);
  });

  it('downloads and installs only the checked offer, bound by version and signature', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(offer);
    const update = (await checkForUpdate())!;
    expect(update.version).toBe('0.3.0');
    expect(update.body).toBe('Notes');
    const events: DownloadEvent[] = [];
    vi.mocked(invoke).mockImplementationOnce(async (_command, args) => {
      const channel = (args as { onEvent: { onmessage: (event: DownloadEvent) => void } }).onEvent;
      channel.onmessage({ event: 'Started', data: { contentLength: 10 } });
      channel.onmessage({ event: 'Finished' });
    });
    await update.download(event => events.push(event));
    expect(events.map(event => event.event)).toEqual(['Started', 'Finished']);
    expect(vi.mocked(invoke).mock.calls[1][0]).toBe('download_update');
    expect((vi.mocked(invoke).mock.calls[1][1] as { update: unknown }).update).toEqual({ version: '0.3.0', signature: 'c2ln' });
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await update.install();
    expect(vi.mocked(invoke).mock.calls[2]).toEqual(['install_update', { update: { version: '0.3.0', signature: 'c2ln' } }]);
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await update.close();
    expect(vi.mocked(invoke).mock.calls[3]).toEqual(['release_update']);
    expect(sentKeys().filter(key => forbidden.includes(key))).toEqual([]);
  });
});
