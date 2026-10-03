import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { closeDocument, discardRecovery, openDocument } from './bridge';
import type { DocumentInfo } from './model';

const nativeWindow = vi.hoisted(() => ({ close: null as null | ((event: { preventDefault: () => void }) => void), destroy: vi.fn() }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  onCloseRequested: vi.fn((handler: (event: { preventDefault: () => void }) => void) => { nativeWindow.close = handler; return Promise.resolve(vi.fn()); }),
  destroy: nativeWindow.destroy,
}) }));
vi.mock('./bridge', () => ({
  native: true, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), discardRecovery: vi.fn(),
  editPages: vi.fn(), saveCopy: vi.fn(), createPdfFromImage: vi.fn(), documentPageLabels: vi.fn(), documentFormFields: vi.fn(),
  ocrCapability: vi.fn().mockResolvedValue({ available: false, reason: 'Unavailable.', language: null, searchablePdfAvailable: false, searchablePdfReason: 'Unavailable.', searchablePdfDpi: null, searchablePdfMaxPages: 32, searchablePdfMaxPixels: 33_554_432, searchablePdfMaxWords: 100_000, searchablePdfMaxTextBytes: 8_388_608, searchablePdfCharacters: null }),
}));
vi.mock('./Viewer', () => ({ default: ({ document }: { document: DocumentInfo }) => <div data-viewed-document={document.id}>{document.name}</div> }));

const first: DocumentInfo = { id: 1, name: 'a.pdf', path: 'C:/a.pdf', pages: [{ width: 612, height: 792 }], revision: 3, dirty: true, can_undo: true, can_redo: false };
const second: DocumentInfo = { ...first, id: 2, name: 'b.pdf', path: 'C:/b.pdf', revision: 5 };
let ui: ReactTestRenderer;

beforeEach(() => {
  vi.clearAllMocks(); nativeWindow.close = null; nativeWindow.destroy.mockResolvedValue(undefined);
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(openDocument).mockResolvedValueOnce({ status: 'opened', document: first }).mockResolvedValueOnce({ status: 'opened', document: second });
  vi.mocked(discardRecovery).mockImplementation(async (id, revision) => ({ documentId: id, revision }));
});
afterEach(() => { if (ui) act(() => ui.unmount()); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => { ui = create(<App />); await Promise.resolve(); });
  const open = () => ui.root.findAllByType('button').find(button => button.children.includes('Open a file'))!;
  await act(async () => open().props.onClick()); await act(async () => open().props.onClick());
}
const confirm = () => ui.root.findAllByType('button').find(button => button.children.includes('Discard and close'))!;

it('tombstones every exact dirty revision before destroying the window', async () => {
  await mount(); const preventDefault = vi.fn();
  act(() => nativeWindow.close!({ preventDefault }));
  expect(preventDefault).toHaveBeenCalledOnce();
  await act(async () => confirm().props.onClick());
  expect(vi.mocked(discardRecovery).mock.calls).toEqual([[1, 3], [2, 5]]);
  expect(nativeWindow.destroy).toHaveBeenCalledOnce();
  expect(closeDocument).not.toHaveBeenCalled();
});

it('keeps every tab and the window open when a later discard fails', async () => {
  await mount();
  vi.mocked(discardRecovery).mockResolvedValueOnce({ documentId: 1, revision: 3 }).mockRejectedValueOnce(new Error('journal unavailable'));
  act(() => nativeWindow.close!({ preventDefault: vi.fn() }));
  await act(async () => confirm().props.onClick());
  expect(vi.mocked(discardRecovery).mock.calls).toEqual([[1, 3], [2, 5]]);
  expect(nativeWindow.destroy).not.toHaveBeenCalled();
  expect(ui.root.findAllByProps({ 'aria-label': 'Close a.pdf' })).toHaveLength(1);
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(1);
  expect(JSON.stringify(ui.toJSON())).toContain('Recovery was already discarded for 1 open document');
  expect(JSON.stringify(ui.toJSON())).toContain('journal unavailable');

  vi.mocked(discardRecovery).mockImplementation(async (id, revision) => ({ documentId: id, revision }));
  act(() => nativeWindow.close!({ preventDefault: vi.fn() }));
  await act(async () => confirm().props.onClick());
  expect(vi.mocked(discardRecovery).mock.calls).toEqual([[1, 3], [2, 5], [1, 3], [2, 5]]);
  expect(nativeWindow.destroy).toHaveBeenCalledOnce();
});

it('rejects a stale window-discard receipt before destroying the window', async () => {
  await mount();
  vi.mocked(discardRecovery).mockResolvedValueOnce({ documentId: 1, revision: 99 });
  act(() => nativeWindow.close!({ preventDefault: vi.fn() }));
  await act(async () => confirm().props.onClick());
  expect(nativeWindow.destroy).not.toHaveBeenCalled();
  expect(discardRecovery).toHaveBeenCalledOnce();
  expect(JSON.stringify(ui.toJSON())).toContain('did not match this document revision');
});

it('admits only one window discard loop when confirmation is invoked twice', async () => {
  await mount();
  let finish!: (receipt: { documentId: number; revision: number }) => void;
  vi.mocked(discardRecovery).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  act(() => nativeWindow.close!({ preventDefault: vi.fn() }));
  const submit = confirm().props.onClick;
  act(() => { submit(); submit(); });
  expect(discardRecovery).toHaveBeenCalledExactlyOnceWith(1, 3);
  await act(async () => finish({ documentId: 1, revision: 3 }));
  expect(vi.mocked(discardRecovery).mock.calls).toEqual([[1, 3], [2, 5]]);
  expect(nativeWindow.destroy).toHaveBeenCalledOnce();
});

it('reports completed tombstones when window destruction fails and permits an idempotent retry', async () => {
  await mount();
  nativeWindow.destroy.mockRejectedValueOnce(new Error('window stayed open')).mockResolvedValueOnce(undefined);
  act(() => nativeWindow.close!({ preventDefault: vi.fn() }));
  await act(async () => confirm().props.onClick());
  expect(JSON.stringify(ui.toJSON())).toContain('Recovery was already discarded for 2 open documents');
  expect(JSON.stringify(ui.toJSON())).toContain('window stayed open');
  expect(ui.root.findAllByProps({ 'aria-label': 'Close a.pdf' })).toHaveLength(1);
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(1);

  act(() => nativeWindow.close!({ preventDefault: vi.fn() }));
  await act(async () => confirm().props.onClick());
  expect(vi.mocked(discardRecovery).mock.calls).toEqual([[1, 3], [2, 5], [1, 3], [2, 5]]);
  expect(nativeWindow.destroy).toHaveBeenCalledTimes(2);
});

it('generic-closes the affected locked tab when the first window discard reports committed uncertainty', async () => {
  await mount();
  vi.mocked(discardRecovery).mockRejectedValueOnce({ code: 'recoveryCommittedReopenRequired', documentId: 1, requestedRevision: 3, committedRevision: 4 });
  act(() => nativeWindow.close!({ preventDefault: vi.fn() }));
  await act(async () => confirm().props.onClick());
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(1);
  expect(nativeWindow.destroy).not.toHaveBeenCalled();
  expect(ui.root.findAllByProps({ 'aria-label': 'Close a.pdf' })).toHaveLength(0);
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(1);
  expect(JSON.stringify(ui.toJSON())).toContain('edit may be saved in recovery');
});
