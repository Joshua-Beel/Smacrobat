import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { check, type DownloadEvent } from '@tauri-apps/plugin-updater';
import Updates from './Updates';

vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '0.2.0' }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('./bridge', () => ({ native: true }));

describe('software updates', () => {
  beforeEach(() => vi.clearAllMocks());
  const mount = async (dirty = false) => {
    const setBusy = vi.fn(), close = vi.fn();
    let ui!: ReactTestRenderer;
    await act(async () => { ui = create(<Updates dirty={dirty} busy={false} setBusy={setBusy} close={close} />); });
    return { ui, setBusy, close };
  };
  it('reports a successful no-update response', async () => {
    vi.mocked(check).mockResolvedValue(null);
    const { ui } = await mount();
    expect(JSON.stringify(ui.toJSON())).toContain('You have the latest released version.');
    act(() => ui.unmount());
  });
  it('blocks installation when any document is dirty, even if called directly', async () => {
    const install = vi.fn(), close = vi.fn();
    vi.mocked(check).mockResolvedValue({ version: '0.3.0', downloadAndInstall: install, close } as never);
    const { ui, setBusy } = await mount(true);
    const button = ui.root.findAllByType('button').find(node => node.children.includes('Install update and restart'))!;
    expect(button.props.disabled).toBe(true);
    await act(async () => { await button.props.onClick(); });
    expect(install).not.toHaveBeenCalled(); expect(setBusy).not.toHaveBeenCalled();
    act(() => ui.unmount()); expect(close).toHaveBeenCalledOnce();
  });
  it('absorbs an asynchronous release failure while the dialog unmounts', async () => {
    const release = vi.fn().mockRejectedValue(new Error('updater cleanup unavailable'));
    vi.mocked(check).mockResolvedValue({ version: '0.3.0', downloadAndInstall: vi.fn(), close: release } as never);
    const { ui } = await mount();
    await act(async () => { ui.unmount(); await Promise.resolve(); });
    expect(release).toHaveBeenCalledOnce();
  });
  it('releases the busy guard and shows errors when signature verification fails', async () => {
    const install = vi.fn().mockRejectedValue(new Error('signature verification failed'));
    vi.mocked(check).mockResolvedValue({ version: '0.3.0', downloadAndInstall: install, close: vi.fn() } as never);
    const { ui, setBusy } = await mount();
    await act(async () => { ui.root.findAllByType('button').find(node => node.children.includes('Install update and restart'))!.props.onClick(); });
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
    expect(JSON.stringify(ui.toJSON())).toContain('signature verification failed');
    act(() => ui.unmount());
  });
  it('reports network failure rather than claiming the app is current', async () => {
    vi.mocked(check).mockRejectedValue(new Error('offline'));
    const { ui } = await mount();
    expect(JSON.stringify(ui.toJSON())).toContain('Could not check for updates');
    expect(JSON.stringify(ui.toJSON())).not.toContain('latest released version');
    act(() => ui.unmount());
  });
  it.each(['connection reset during download', 'download timed out'])('recovers from %s and retries without stale progress', async failure => {
    const attempts: { emit: (event: DownloadEvent) => void; resolve: () => void; reject: (reason: Error) => void }[] = [];
    const install = vi.fn((emit: (event: DownloadEvent) => void) => new Promise<void>((resolve, reject) => attempts.push({ emit, resolve, reject })));
    const release = vi.fn();
    vi.mocked(check).mockResolvedValue({ version: '0.3.0', downloadAndInstall: install, close: release } as never);
    const { ui, setBusy, close } = await mount();
    const installButton = () => ui.root.findAllByType('button').find(node => node.children.includes('Install update and restart'))!;
    const closeButton = () => ui.root.findAllByType('button').find(node => node.children.includes('Close'))!;
    await act(async () => installButton().props.onClick());
    expect(install).toHaveBeenCalledOnce();
    expect(install.mock.calls[0]).toEqual([expect.any(Function), { timeout: 120000 }]);
    expect(setBusy.mock.calls).toEqual([[true]]);
    expect(installButton().props.disabled).toBe(true);
    expect(closeButton().props.disabled).toBe(true);
    const preventDefault = vi.fn();
    act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await act(async () => installButton().props.onClick());
    expect(install).toHaveBeenCalledOnce();
    act(() => {
      attempts[0].emit({ event: 'Started', data: { contentLength: 100 } });
      attempts[0].emit({ event: 'Progress', data: { chunkLength: 75 } });
    });
    expect(JSON.stringify(ui.toJSON())).toContain('Downloading update: 75%');
    await act(async () => attempts[0].reject(new Error(failure)));
    expect(setBusy.mock.calls).toEqual([[true], [false]]);
    expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain(failure);
    expect(installButton().props.disabled).toBe(false);
    expect(closeButton().props.disabled).toBe(false);
    expect(release).not.toHaveBeenCalled();
    await act(async () => installButton().props.onClick());
    expect(install).toHaveBeenCalledTimes(2);
    expect(ui.root.findAllByProps({ role: 'alert' })).toHaveLength(0);
    expect(JSON.stringify(ui.toJSON())).toContain('Downloading signed update');
    act(() => {
      attempts[1].emit({ event: 'Started', data: { contentLength: 100 } });
      attempts[1].emit({ event: 'Progress', data: { chunkLength: 25 } });
    });
    expect(JSON.stringify(ui.toJSON())).toContain('Downloading update: 25%');
    act(() => attempts[1].emit({ event: 'Finished' }));
    expect(JSON.stringify(ui.toJSON())).toContain('Verifying update and starting installer');
    await act(async () => attempts[1].resolve());
    expect(setBusy.mock.calls).toEqual([[true], [false], [true], [false]]);
    act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault }));
    expect(close).toHaveBeenCalledOnce();
    act(() => ui.unmount());
    expect(release).toHaveBeenCalledOnce();
  });
});
