import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import type { DocumentInfo } from './model';

const source: DocumentInfo = { id: 1, name: 'source.pdf', path: 'C:/source.pdf', pages: [{ width: 612, height: 792 }, { width: 600, height: 800 }], revision: 4, dirty: true, can_undo: true, can_redo: false };
const mocks = vi.hoisted(() => ({ openDocument: vi.fn(), exportPageImage: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
vi.mock('./bridge', () => ({ native: false, openDocument: mocks.openDocument, reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), splitDocument: vi.fn(), cropPages: vi.fn(), combineDocuments: vi.fn(), insertPagesCopy: vi.fn(), replacePagesCopy: vi.fn(), documentFormFields: vi.fn(), fillFormCopy: vi.fn(), documentAnnotations: vi.fn(), documentPageLabels: vi.fn(), createPdfFromImage: vi.fn(), exportPageImage: mocks.exportPageImage, createComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(), createHighlight: vi.fn(), createTextHighlight: vi.fn(), updateHighlight: vi.fn(), deleteHighlight: vi.fn() }));
vi.mock('./Viewer', () => ({ default: ({ document }: { document: DocumentInfo }) => <div data-viewed-document={document.id}>{document.name}</div> }));

const button = (ui: ReactTestRenderer, text: string) => ui.root.findAllByType('button').find(item => item.children.join('') === text)!;
async function mount() { let ui!: ReactTestRenderer; await act(async () => { ui = create(<App />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); }); return ui; }

it('exports the captured physical page without creating a tab, recent entry, or source mutation', async () => {
  mocks.openDocument.mockResolvedValue({ status: 'opened', document: source });
  mocks.exportPageImage.mockResolvedValue({ path: 'C:/exports/source-page-2.png', documentId: 1, revision: 4, page: 1, dpi: 150, width: 1250, height: 1667 });
  const ui = await mount();
  await act(async () => button(ui, 'Open a file').props.onClick());
  act(() => ui.root.findByProps({ 'aria-label': 'Next page' }).props.onClick());
  act(() => ui.root.findByProps({ 'aria-expanded': false }).props.onClick());
  await act(async () => button(ui, 'Export page as PNG…').props.onClick());
  await act(async () => button(ui, 'Export PNG').props.onClick());
  expect(mocks.exportPageImage).toHaveBeenCalledWith({ id: 1, revision: 4, page: 1, dpi: 150 });
  const rendered = JSON.stringify(ui.toJSON());
  expect(rendered).toContain('PNG export complete');
  expect(rendered).toContain('source.pdf"," *');
  expect(ui.root.findAllByProps({ 'data-viewed-document': 1 })).toHaveLength(1);
  expect(ui.root.findAllByProps({ 'data-viewed-document': 2 })).toHaveLength(0);
  act(() => ui.unmount());
});
