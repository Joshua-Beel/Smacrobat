import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import Viewer from './Viewer';
import { insertPagesCopy, openDocument } from './bridge';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), splitDocument: vi.fn(), cropPage: vi.fn(), cropPages: vi.fn(), combineDocuments: vi.fn(), insertPagesCopy: vi.fn(), createPdfFromImage: vi.fn(), documentPageLabels: vi.fn() }));
vi.mock('./Viewer', () => ({ default: () => <div>Viewer</div> }));
vi.mock('./Organizer', () => ({ default: ({ insert }: { insert: () => void }) => <button onClick={insert}>Insert pages</button> }));
const document = (id: number, revision: number): DocumentInfo => ({ id, name: `file-${id}.pdf`, path: `C:/file-${id}.pdf`, pages: Array.from({ length: id + 1 }, () => ({ width: 612, height: 792 })), revision, dirty: true, can_undo: true, can_redo: false });
beforeEach(() => { vi.clearAllMocks(); const storage = new Map(); vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => vi.unstubAllGlobals());
async function open(ui: ReactTestRenderer, info: DocumentInfo) { vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: info }); await act(async () => ui.root.findAllByType('button').find(item => item.children.includes('Open a file'))!.props.onClick()); }

it('inserts at the selected boundary into a clean active copy without changing dirty source tabs', async () => {
  const target = document(1, 4), donor = document(2, 7), inserted: DocumentInfo = { ...document(3, 0), name: 'inserted.pdf', path: 'C:/inserted.pdf', pages: Array.from({ length: 5 }, () => ({ width: 612, height: 792 })), dirty: false, can_undo: false, can_redo: false };
  vi.mocked(insertPagesCopy).mockResolvedValue({ path: inserted.path, document: inserted });
  let ui!: ReactTestRenderer; act(() => { ui = create(<App />); });
  await open(ui, target); await open(ui, donor);
  if (!ui.root.findAllByProps({ title: 'Organize pages' }).length) act(() => ui.root.findAllByType('button').find(item => item.children.includes('All tools'))!.props.onClick());
  act(() => ui.root.findByProps({ title: 'Organize pages' }).props.onClick());
  act(() => ui.root.findAllByType('button').find(item => item.children.join('') === 'Insert pages')!.props.onClick());
  act(() => ui.root.findByProps({ 'aria-label': 'Target PDF' }).props.onChange({ target: { value: '1' } }));
  act(() => ui.root.findByProps({ 'aria-label': 'Donor PDF' }).props.onChange({ target: { value: '2' } }));
  act(() => ui.root.findByProps({ 'aria-label': 'Insertion boundary' }).props.onChange({ target: { value: '1' } }));
  await act(async () => ui.root.findAllByType('button').find(item => item.children.join('') === 'Insert pages')!.props.onClick());
  expect(insertPagesCopy).toHaveBeenCalledWith({ id: 1, revision: 4 }, { id: 2, revision: 7 }, 1);
  expect(ui.root.findByType(Viewer).props.document).toMatchObject({ id: 3, dirty: false, revision: 0 });
  expect(ui.root.findByType(Viewer).props.document.pages).toHaveLength(5);
  for (const name of ['file-1.pdf', 'file-2.pdf']) expect(ui.root.findAllByType('span').some(item => item.children.includes(name) && item.children.includes(' *'))).toBe(true);
  act(() => ui.unmount());
});
