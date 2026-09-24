import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { openDocument } from './bridge';
import { readRecentFiles } from './recentFiles';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), createPdfFromImage: vi.fn(), documentPageLabels: vi.fn() }));
vi.mock('./Viewer', () => ({ default: () => <div>Rendered document</div> }));
vi.mock('./PasswordDialog', () => ({ default: (props: { onOpened: (document: DocumentInfo) => void; onClose: () => void }) => <div><button onClick={() => props.onOpened(document)}>Simulate unlock</button><button onClick={props.onClose}>Simulate cancel</button></div> }));
const document: DocumentInfo = { id: 3, name: 'locked.pdf', path: 'C:/docs/locked.pdf', pages: [{ width: 612, height: 792 }], revision: 0, dirty: false, can_undo: false, can_redo: false };
beforeEach(() => {
  vi.clearAllMocks(); const storage = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
it('adds a protected file to the workspace and history only after successful unlock', async () => {
  vi.mocked(openDocument).mockResolvedValue({ status: 'password_required', request_id: 9, name: 'locked.pdf', incorrect: false });
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<App />); });
  await act(async () => ui.root.findAllByType('button').find(button => button.children.includes('Open a file'))!.props.onClick());
  expect(readRecentFiles()).toEqual([]);
  expect(JSON.stringify(ui.toJSON())).not.toContain('Rendered document');
  act(() => ui.root.findAllByType('button').find(button => button.children.includes('Simulate unlock'))!.props.onClick());
  expect(readRecentFiles()).toEqual([{ path: document.path, name: document.name, pages: 1, starred: false }]);
  expect(JSON.stringify(ui.toJSON())).toContain('Rendered document');
  expect(JSON.stringify(ui.toJSON())).not.toContain('Simulate unlock');
  act(() => ui.unmount());
});
it('canceling a password prompt leaves the workspace and history unchanged', async () => {
  vi.mocked(openDocument).mockResolvedValue({ status: 'password_required', request_id: 10, name: 'locked.pdf', incorrect: false });
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<App />); });
  await act(async () => ui.root.findAllByType('button').find(button => button.children.includes('Open a file'))!.props.onClick());
  act(() => ui.root.findAllByType('button').find(button => button.children.includes('Simulate cancel'))!.props.onClick());
  expect(readRecentFiles()).toEqual([]);
  expect(JSON.stringify(ui.toJSON())).not.toContain('Rendered document');
  expect(JSON.stringify(ui.toJSON())).not.toContain('Simulate unlock');
  act(() => ui.unmount());
});
