import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { closeDocument, editPages, openDocument, saveCopy } from './bridge';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), createPdfFromImage: vi.fn(), documentPageLabels: vi.fn() }));
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
  act(() => ui.root.findAllByType('button').find(button => button.children.includes('Discard and close'))!.props.onClick());
  expect(closeDocument).toHaveBeenCalledExactlyOnceWith(2);
  expect(action('Close b.pdf').props.disabled).toBe(true);
  await act(async () => finishClose());
  expect(ui.root.findAllByProps({ 'aria-label': 'Close b.pdf' })).toHaveLength(0);
});
