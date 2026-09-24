import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import Viewer from './Viewer';
import { openDocument, replacePagesCopy } from './bridge';
import type { DocumentInfo } from './model';

vi.mock('./bridge', () => ({ native: false, openDocument: vi.fn(), reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), splitDocument: vi.fn(), cropPage: vi.fn(), combineDocuments: vi.fn(), insertPagesCopy: vi.fn(), replacePagesCopy: vi.fn(), documentPageLabels: vi.fn() }));
vi.mock('./Viewer', () => ({ default: () => <div>Viewer</div> }));
vi.mock('./Organizer', () => ({ default: ({ replace }: { replace: (pages: number[]) => void }) => <><button onClick={() => replace([1, 2])}>Replace pages</button><button onClick={() => replace([0, 2])}>Replace noncontiguous</button></> }));
const document = (id: number, revision: number): DocumentInfo => ({ id, name: `file-${id}.pdf`, path: `C:/file-${id}.pdf`, pages: Array.from({ length: id + 2 }, () => ({ width: 612, height: 792 })), revision, dirty: true, can_undo: true, can_redo: false });
beforeEach(() => { vi.clearAllMocks(); const storage = new Map(); vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
afterEach(() => vi.unstubAllGlobals());
async function open(ui: ReactTestRenderer, info: DocumentInfo) { vi.mocked(openDocument).mockResolvedValue({ status: 'opened', document: info }); await act(async () => ui.root.findAllByType('button').find(item => item.children.includes('Open a file'))!.props.onClick()); }

it('replaces the selected current range in a clean active copy without changing dirty source tabs', async () => {
  const target = document(1, 4), donor = document(2, 7), replaced: DocumentInfo = { ...document(3, 0), name: 'replaced.pdf', path: 'C:/replaced.pdf', pages: Array.from({ length: 5 }, () => ({ width: 612, height: 792 })), dirty: false, can_undo: false, can_redo: false };
  vi.mocked(replacePagesCopy).mockResolvedValue({ path: replaced.path, document: replaced });
  let ui!: ReactTestRenderer; act(() => { ui = create(<App />); });
  await open(ui, target); await open(ui, donor);
  act(() => ui.root.findAllByType('span').find(item => item.children.includes('file-1.pdf'))!.parent!.props.onClick());
  if (!ui.root.findAllByProps({ title: 'Organize pages' }).length) act(() => ui.root.findAllByType('button').find(item => item.children.includes('All tools'))!.props.onClick());
  act(() => ui.root.findByProps({ title: 'Organize pages' }).props.onClick());
  act(() => ui.root.findAllByType('button').find(item => item.children.join('') === 'Replace pages')!.props.onClick());
  expect(JSON.stringify(ui.toJSON())).toContain('pages 2–3');
  await act(async () => ui.root.findAllByType('button').find(item => item.children.join('') === 'Replace pages')!.props.onClick());
  expect(replacePagesCopy).toHaveBeenCalledWith({ id: 1, revision: 4 }, { id: 2, revision: 7 }, 1, 2);
  expect(ui.root.findByType(Viewer).props.document).toMatchObject({ id: 3, dirty: false, revision: 0 });
  expect(ui.root.findByType(Viewer).props.document.pages).toHaveLength(5);
  for (const name of ['file-1.pdf', 'file-2.pdf']) expect(ui.root.findAllByType('span').some(item => item.children.includes(name) && item.children.includes(' *'))).toBe(true);
  act(() => ui.unmount());
});

it('does not open replacement for a noncontiguous target selection', async () => {
  let ui!: ReactTestRenderer; act(() => { ui = create(<App />); });
  await open(ui, document(1, 4)); await open(ui, document(2, 7));
  if (!ui.root.findAllByProps({ title: 'Organize pages' }).length) act(() => ui.root.findAllByType('button').find(item => item.children.includes('All tools'))!.props.onClick());
  act(() => ui.root.findByProps({ title: 'Organize pages' }).props.onClick());
  act(() => ui.root.findAllByType('button').find(item => item.children.join('') === 'Replace noncontiguous')!.props.onClick());
  expect(JSON.stringify(ui.toJSON())).toContain('Select one contiguous target page range');
  expect(replacePagesCopy).not.toHaveBeenCalled(); act(() => ui.unmount());
});
