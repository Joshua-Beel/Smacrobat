import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import type { DocumentInfo } from './model';

const source: DocumentInfo = { id: 1, name: 'source.pdf', path: 'C:/source.pdf', pages: [{ width: 612, height: 792 }], revision: 4, dirty: true, can_undo: true, can_redo: false };
const created: DocumentInfo = { id: 2, name: 'new.pdf', path: 'C:/new.pdf', pages: [{ width: 612, height: 792 }], revision: 0, dirty: false, can_undo: false, can_redo: false };
const mocks = vi.hoisted(() => ({ openDocument: vi.fn(), createPdfFromImage: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  const storage = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

vi.mock('./bridge', () => ({ native: false, openDocument: mocks.openDocument, reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), splitDocument: vi.fn(), cropPages: vi.fn(), combineDocuments: vi.fn(), insertPagesCopy: vi.fn(), replacePagesCopy: vi.fn(), documentFormFields: vi.fn(), fillFormCopy: vi.fn(), documentAnnotations: vi.fn(), documentPageLabels: vi.fn(), createPdfFromImage: mocks.createPdfFromImage, createComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(), createHighlight: vi.fn(), createTextHighlight: vi.fn(), updateHighlight: vi.fn(), deleteHighlight: vi.fn() }));
vi.mock('./Viewer', () => ({ default: ({ document }: { document: DocumentInfo }) => <div data-viewed-document={document.id}>{document.name}</div> }));

async function mount() {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<App />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return ui;
}

const button = (ui: ReactTestRenderer, text: string) => ui.root.findAllByType('button').find(item => item.children.join('') === text)!;

it('keeps the source tab intact and appends one clean output tab after creation', async () => {
  mocks.openDocument.mockResolvedValue({ status: 'opened', document: source });
  mocks.createPdfFromImage.mockResolvedValue({ path: created.path, document: created });
  const ui = await mount();
  await act(async () => button(ui, 'Open a file').props.onClick());
  expect(JSON.stringify(ui.toJSON())).toContain('source.pdf');
  act(() => ui.root.findByProps({ title: 'Create a PDF from an image' }).props.onClick());
  act(() => ui.root.findByProps({ 'aria-label': 'Page size' }).props.onChange({ target: { value: 'a4' } }));
  act(() => ui.root.findByProps({ 'aria-label': 'Margin in points' }).props.onChange({ target: { value: '18' } }));
  await act(async () => ui.root.findAllByType('button').find(item => item.children.join('') === 'Create PDF')!.props.onClick());
  expect(mocks.createPdfFromImage).toHaveBeenCalledWith({ pageSize: 'a4', orientation: 'auto', marginPoints: 18 });
  expect(JSON.stringify(ui.toJSON())).toContain('source.pdf');
  expect(JSON.stringify(ui.toJSON())).toContain('new.pdf');
  expect(ui.root.findAllByProps({ 'data-viewed-document': 2 })).toHaveLength(1);
  act(() => ui.unmount());
});

it('leaves existing documents alone when native creation is canceled', async () => {
  mocks.openDocument.mockResolvedValue({ status: 'opened', document: source });
  mocks.createPdfFromImage.mockResolvedValue(null);
  const ui = await mount();
  await act(async () => button(ui, 'Open a file').props.onClick());
  act(() => ui.root.findByProps({ title: 'Create a PDF from an image' }).props.onClick());
  await act(async () => ui.root.findAllByType('button').find(item => item.children.join('') === 'Create PDF')!.props.onClick());
  const rendered = JSON.stringify(ui.toJSON());
  expect(rendered).toContain('source.pdf');
  expect(rendered).not.toContain('new.pdf');
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('unchanged');
  act(() => ui.unmount());
});
