import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import Viewer from './Viewer';
import { combineDocuments, openDocument } from './bridge';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), splitDocument: vi.fn(), cropPage: vi.fn(), cropPages: vi.fn(), combineDocuments: vi.fn(), createPdfFromImage: vi.fn(), documentPageLabels: vi.fn() }));
vi.mock('./Viewer', () => ({ default: () => <div>Viewer</div> }));
const document = (id: number, revision: number): DocumentInfo => ({ id, name: `file-${id}.pdf`, path: `C:/file-${id}.pdf`, pages: Array.from({ length: id + 1 }, () => ({ width: 612, height: 792 })), revision, dirty: true, can_undo: true, can_redo: false });
beforeEach(() => { vi.clearAllMocks(); const storage = new Map(); vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => vi.unstubAllGlobals());
async function open(ui: ReactTestRenderer, info: DocumentInfo) { vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: info }); await act(async () => ui.root.findAllByType('button').find(item => item.children.includes('Open a file'))!.props.onClick()); }

it('combines the selected current revisions into a clean active tab without changing dirty source tabs', async () => {
  const first = document(1, 4), second = document(2, 7), combined: DocumentInfo = { ...document(3, 0), name: 'combined.pdf', path: 'C:/combined.pdf', dirty: false, can_undo: false, can_redo: false };
  vi.mocked(combineDocuments).mockResolvedValue({ path: combined.path, document: combined });
  let ui!: ReactTestRenderer; act(() => { ui = create(<App />); });
  await open(ui, first); await open(ui, second);
  if (!ui.root.findAllByProps({ title: 'Combine files' }).length) act(() => ui.root.findAllByType('button').find(item => item.children.includes('All tools'))!.props.onClick());
  act(() => ui.root.findByProps({ title: 'Combine files' }).props.onClick());
  act(() => ui.root.findByProps({ 'aria-label': 'First PDF' }).props.onChange({ target: { value: '1' } }));
  act(() => ui.root.findByProps({ 'aria-label': 'Second PDF' }).props.onChange({ target: { value: '2' } }));
  await act(async () => ui.root.findAllByType('button').find(item => item.children.join('') === 'Combine PDFs')!.props.onClick());
  expect(combineDocuments).toHaveBeenCalledWith({ id: 1, revision: 4 }, { id: 2, revision: 7 });
  expect(ui.root.findByType(Viewer).props.document).toMatchObject({ id: 3, dirty: false, revision: 0 });
  for (const name of ['file-1.pdf', 'file-2.pdf']) expect(ui.root.findAllByType('span').some(item => item.children.includes(name) && item.children.includes(' *'))).toBe(true);
  act(() => ui.unmount());
});
