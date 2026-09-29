import { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { cancelPasswordRequest, closeDocument, openDocument, reopenDocument } from './bridge';
import type { DocumentInfo } from './model';

type DropEvent = { payload: { type: string; paths?: string[] } };
const listeners = vi.hoisted(() => ({ handlers: [] as ((event: DropEvent) => void)[], unlisten: vi.fn(), closeUnlisten: vi.fn(), deferred: false, reject: false, pending: [] as (() => void)[] }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  onCloseRequested: vi.fn().mockResolvedValue(listeners.closeUnlisten),
  onDragDropEvent: vi.fn((handler: (event: DropEvent) => void) => { if (listeners.reject) return Promise.reject(new Error('listener unavailable')); listeners.handlers.push(handler); return listeners.deferred ? new Promise(resolve => listeners.pending.push(() => resolve(listeners.unlisten))) : Promise.resolve(listeners.unlisten); }),
}) }));
vi.mock('./bridge', () => ({ native: true, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), cancelPasswordRequest: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), createPdfFromImage: vi.fn(), ocrCapability: vi.fn().mockResolvedValue({ available: false, reason: 'OCR is unavailable in this build.', language: null }), documentPageLabels: vi.fn(), documentFormFields: vi.fn() }));
vi.mock('./Viewer', () => ({ default: () => <div>Rendered document</div> }));
vi.mock('./PasswordDialog', () => ({ default: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>Cancel password</button> }));
vi.mock('./CreatePdfDialog', () => ({ default: () => <div>Create dialog</div> }));

const document: DocumentInfo = { id: 7, name: 'dropped.pdf', path: 'C:/docs/dropped.pdf', pages: [{ width: 612, height: 792 }], revision: 0, dirty: false, can_undo: false, can_redo: false };
beforeEach(() => { vi.clearAllMocks(); listeners.handlers = []; listeners.deferred = false; listeners.reject = false; listeners.pending = []; const storage = new Map<string, string>(); vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => vi.unstubAllGlobals());
async function settle() { await Promise.resolve(); await Promise.resolve(); }
async function mount(strict = false) { let ui!: ReactTestRenderer; await act(async () => { ui = create(strict ? <StrictMode><App /></StrictMode> : <App />); await settle(); }); expect(listeners.handlers.length).toBeGreaterThan(0); return ui; }
async function drop(paths: string[]) { await act(async () => { listeners.handlers.at(-1)?.({ payload: { type: 'drop', paths } }); await settle(); }); }

it('opens one native PDF drop through the existing reopen path in StrictMode', async () => {
  vi.mocked(reopenDocument).mockResolvedValue({ status: 'opened', document }); const ui = await mount(true); const registrations = listeners.handlers.length; await drop(['C:/docs/dropped.PDF']);
  expect(listeners.handlers).toHaveLength(registrations);
  expect(reopenDocument).toHaveBeenCalledWith('C:/docs/dropped.PDF'); expect(JSON.stringify(ui.toJSON())).toContain('Rendered document'); act(() => ui.unmount());
});
it('ignores non-drop events and rejects whitespace, multiple, and non-PDF paths', async () => {
  const ui = await mount(); await act(async () => { for (const type of ['enter', 'over', 'leave']) listeners.handlers.at(-1)?.({ payload: { type } }); await settle(); }); await drop(['   ']); await drop(['C:/docs/a.pdf', 'C:/docs/b.pdf']); await drop(['C:/docs/image.png']);
  expect(reopenDocument).not.toHaveBeenCalled(); expect(JSON.stringify(ui.toJSON())).toContain('Drop a PDF file to open it.'); act(() => ui.unmount());
});
it('serializes rapid drops and releases the guard after failure for retry', async () => {
  let reject!: (reason: Error) => void; vi.mocked(reopenDocument).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValueOnce({ status: 'opened', document }); const ui = await mount();
  await act(async () => { const handler = listeners.handlers.at(-1)!; handler({ payload: { type: 'drop', paths: ['C:/docs/a.pdf'] } }); handler({ payload: { type: 'drop', paths: ['C:/docs/b.pdf'] } }); await Promise.resolve(); }); expect(reopenDocument).toHaveBeenCalledOnce();
  await act(async () => { reject(new Error('missing')); await settle(); }); await drop(['C:/docs/dropped.pdf']); expect(reopenDocument).toHaveBeenCalledTimes(2); expect(JSON.stringify(ui.toJSON())).toContain('Rendered document'); act(() => ui.unmount());
});
it('routes password challenges through the existing modal and blocks another drop', async () => {
  vi.mocked(reopenDocument).mockResolvedValue({ status: 'password_required', request_id: 3, name: 'locked.pdf', incorrect: false }); const ui = await mount(); await drop(['C:/docs/locked.pdf']); expect(JSON.stringify(ui.toJSON())).toContain('Cancel password'); await drop(['C:/docs/other.pdf']); expect(reopenDocument).toHaveBeenCalledOnce(); act(() => ui.root.findAllByType('button').find(button => button.children.includes('Cancel password'))!.props.onClick()); act(() => ui.unmount());
});
it('cleans deferred opened/password results and late listener registration after unmount', async () => {
  let resolve!: (value: { status: 'opened'; document: DocumentInfo }) => void; vi.mocked(reopenDocument).mockImplementationOnce(() => new Promise(done => { resolve = done; })); const ui = await mount(); listeners.handlers.at(-1)?.({ payload: { type: 'drop', paths: ['C:/docs/dropped.pdf'] } }); act(() => ui.unmount()); await act(async () => { resolve({ status: 'opened', document }); await settle(); }); expect(closeDocument).toHaveBeenCalledWith(7);
  listeners.unlisten.mockClear(); listeners.deferred = true; const deferred = await mount(); act(() => deferred.unmount()); listeners.pending.forEach(done => done()); await settle(); expect(listeners.unlisten).toHaveBeenCalledOnce();
  let password!: (value: { status: 'password_required'; request_id: number; name: string; incorrect: boolean }) => void; vi.mocked(reopenDocument).mockImplementationOnce(() => new Promise(done => { password = done; })); const passwordUi = await mount(); listeners.handlers.at(-1)?.({ payload: { type: 'drop', paths: ['C:/docs/locked.pdf'] } }); act(() => passwordUi.unmount()); await act(async () => { password({ status: 'password_required', request_id: 9, name: 'locked.pdf', incorrect: false }); await settle(); }); expect(cancelPasswordRequest).toHaveBeenCalledWith(9);
});
it('keeps busy and already-open dirty documents out of another native reopen', async () => {
  const dirty = { ...document, dirty: true };
  vi.mocked(reopenDocument).mockResolvedValueOnce({ status: 'opened', document: dirty });
  const ui = await mount(); await drop([dirty.path]); await drop([dirty.path]);
  expect(reopenDocument).toHaveBeenCalledOnce(); expect(JSON.stringify(ui.toJSON())).toContain('Unsaved changes'); act(() => ui.unmount());
});
it('does not open a dropped path while the existing picker operation is busy', async () => {
  let resolve!: (value: null) => void; vi.mocked(openDocument).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const ui = await mount(); await act(async () => { ui.root.findAllByType('button').find(button => button.children.includes('Open a file'))!.props.onClick(); await Promise.resolve(); });
  await drop(['C:/docs/dropped.pdf']); expect(reopenDocument).not.toHaveBeenCalled();
  await act(async () => { resolve(null); await settle(); }); act(() => ui.unmount());
});
it('does not open a dropped path while a non-password modal is open', async () => {
  const ui = await mount(); await act(async () => { ui.root.findAllByType('button').find(button => button.props.title === 'Create a PDF from an image')!.props.onClick(); await settle(); });
  expect(JSON.stringify(ui.toJSON())).toContain('Create dialog'); await drop(['C:/docs/dropped.pdf']);
  expect(reopenDocument).not.toHaveBeenCalled(); expect(JSON.stringify(ui.toJSON())).toContain('Finish the current operation or dialog'); act(() => ui.unmount());
});
it('absorbs a listener registration failure without attempting an open', async () => {
  listeners.reject = true; let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<App />); await settle(); });
  expect(reopenDocument).not.toHaveBeenCalled(); act(() => ui.unmount());
});
