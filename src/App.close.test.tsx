import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { closeDocument, discardRecovery, editPages, openDocument, saveCopy } from './bridge';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), discardRecovery: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), createPdfFromImage: vi.fn(), documentPageLabels: vi.fn() }));
vi.mock('./Viewer', () => ({ default: ({ document }: { document: DocumentInfo }) => <div data-viewed-document={document.id}>{document.name}</div> }));

const first: DocumentInfo = { id: 1, name: 'a.pdf', path: 'C:/docs/a.pdf', pages: [{ width: 612, height: 792 }], revision: 0, dirty: false, can_undo: true, can_redo: false };
const second = { ...first, id: 2, name: 'b.pdf', path: 'C:/docs/b.pdf' };
let ui: ReactTestRenderer;
let finishClose: () => void, failClose: (error: Error) => void;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.mocked(closeDocument).mockImplementation(() => new Promise<void>((resolve, reject) => { finishClose = resolve; failClose = reject; }));
  vi.mocked(saveCopy).mockResolvedValue(null);
  vi.mocked(discardRecovery).mockImplementation(async (id, revision) => ({ documentId: id, revision }));
  vi.mocked(editPages).mockResolvedValue(second);
});
afterEach(() => { if (ui) act(() => ui.unmount()); vi.unstubAllGlobals(); });

const openButton = () => ui.root.findAllByType('button').find(button => button.children.includes('Open a file'))!;
const tab = (name: string) => ui.root.findAllByType('button').find(button => button.findAllByType('span').some(span => span.children.includes(name)))!;
const action = (label: string) => ui.root.findAllByType('button').find(button => button.props['aria-label'] === label)!;
async function mount(dirty = false) {
  vi.mocked(openDocument).mockResolvedValueOnce({ status: 'opened', document: first }).mockResolvedValueOnce({ status: 'opened', document: { ...second, dirty } });
  await act(async () => { ui = create(<App />); });
  await act(async () => openButton().props.onClick());
  await act(async () => openButton().props.onClick());
  vi.mocked(openDocument).mockClear();
}

it('blocks rapid activation/open/edit/save while a background tab closes and preserves the active tab', async () => {
  await mount();
  const callbacks = [tab('a.pdf').props.onClick, openButton().props.onClick, action('Undo').props.onClick, action('Save a copy').props.onClick];
  const close = action('Close a.pdf').props.onClick;
  act(() => { close(); for (const callback of callbacks) callback(); close(); });
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(1);
  expect(openDocument).not.toHaveBeenCalled();
  expect(editPages).not.toHaveBeenCalled();
  expect(saveCopy).not.toHaveBeenCalled();
  expect(action('Close b.pdf').props.disabled).toBe(true);
  await act(async () => finishClose());
  expect(ui.root.findByProps({ 'data-viewed-document': 2 })).toBeTruthy();
  expect(action('Close b.pdf').props.disabled).toBe(false);
  expect(ui.root.findAllByProps({ 'aria-label': 'Close a.pdf' })).toHaveLength(0);
});

it('does not activate a closing tab or leave a blank view after the active tab closes', async () => {
  await mount();
  const activateFirst = tab('a.pdf').props.onClick;
  act(() => { action('Close b.pdf').props.onClick(); activateFirst(); });
  expect(ui.root.findByProps({ 'data-viewed-document': 2 })).toBeTruthy();
  await act(async () => finishClose());
  expect(JSON.stringify(ui.toJSON())).toContain('Work with your PDFs.');
  act(() => tab('a.pdf').props.onClick());
  expect(ui.root.findByProps({ 'data-viewed-document': 1 })).toBeTruthy();
});

it('restores controls after close fails, keeps the document and permits retry', async () => {
  await mount();
  act(() => action('Close b.pdf').props.onClick());
  await act(async () => failClose(new Error('PDF worker unavailable')));
  expect(ui.root.findByProps({ 'data-viewed-document': 2 })).toBeTruthy();
  expect(JSON.stringify(ui.toJSON())).toContain('PDF worker unavailable');
  expect(action('Close b.pdf').props.disabled).toBe(false);
  act(() => action('Close b.pdf').props.onClick());
  expect(closeDocument).toHaveBeenCalledTimes(2);
  await act(async () => finishClose());
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(0);
});

it('asks before discarding edits and acquires the close guard only after confirmation', async () => {
  await mount(true);
  act(() => action('Close b.pdf').props.onClick());
  expect(closeDocument).not.toHaveBeenCalled();
  expect(action('Close b.pdf').props.disabled).toBe(false);
  act(() => ui.root.findAllByType('button').find(button => button.children.includes('Cancel'))!.props.onClick());
  expect(closeDocument).not.toHaveBeenCalled();
  act(() => action('Close b.pdf').props.onClick());
  await act(async () => ui.root.findAllByType('button').find(button => button.children.includes('Discard and close'))!.props.onClick());
  expect(discardRecovery).toHaveBeenCalledExactlyOnceWith(2, 0);
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(2);
  expect(action('Close b.pdf').props.disabled).toBe(true);
  await act(async () => finishClose());
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(0);
});

it('keeps a dirty tab open when discard persistence fails or acknowledges stale state', async () => {
  await mount(true);
  vi.mocked(discardRecovery).mockRejectedValueOnce(new Error('recovery unavailable'));
  act(() => action('Close b.pdf').props.onClick());
  await act(async () => ui.root.findAllByType('button').find(button => button.children.includes('Discard and close'))!.props.onClick());
  expect(closeDocument).not.toHaveBeenCalled();
  expect(ui.root.findByProps({ 'data-viewed-document': 2 })).toBeTruthy();
  expect(JSON.stringify(ui.toJSON())).toContain('recovery unavailable');

  vi.mocked(discardRecovery).mockResolvedValueOnce({ documentId: 2, revision: 99 });
  act(() => action('Close b.pdf').props.onClick());
  await act(async () => ui.root.findAllByType('button').find(button => button.children.includes('Discard and close'))!.props.onClick());
  expect(closeDocument).not.toHaveBeenCalled();
  expect(JSON.stringify(ui.toJSON())).toContain('did not match this document revision');
});

it('closes a native recovery-locked tab without discarding and guides reopening', async () => {
  await mount(true);
  vi.mocked(editPages).mockRejectedValueOnce({ code: 'recoveryCommittedReopenRequired', documentId: 2, requestedRevision: 0, committedRevision: 1 });
  await act(async () => { action('Undo').props.onClick(); await Promise.resolve(); });
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(2);
  expect(discardRecovery).not.toHaveBeenCalled();
  await act(async () => finishClose());
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(0);
  expect(JSON.stringify(ui.toJSON())).toContain('edit may be saved in recovery');
  expect(JSON.stringify(ui.toJSON())).toContain('Reopen this PDF');
});

it('retains a recovery-locked tab after cleanup close fails and retries generic close only', async () => {
  await mount(true);
  vi.mocked(editPages).mockRejectedValueOnce({ code: 'recoveryCommittedReopenRequired', documentId: 2, requestedRevision: 0, committedRevision: 1 });
  await act(async () => { action('Undo').props.onClick(); await Promise.resolve(); });
  await act(async () => failClose(new Error('worker unavailable')));
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(1);
  expect(JSON.stringify(ui.toJSON())).toContain('locked PDF could not close');
  expect(ui.root.findAllByType('button').some(button => button.children.includes('Discard and close'))).toBe(false);
  act(() => ui.root.findAllByType('button').find(button => button.children.includes('Retry closing tab'))!.props.onClick());
  expect(closeDocument).toHaveBeenCalledTimes(2);
  expect(discardRecovery).not.toHaveBeenCalled();
  await act(async () => finishClose());
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(0);
});
