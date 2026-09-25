import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import type { DocumentInfo } from './model';

const source: DocumentInfo = { id: 3, name: 'source.pdf', path: 'C:/source.pdf', pages: [{ width: 612, height: 792 }, { width: 612, height: 792 }], revision: 9, dirty: true, can_undo: true, can_redo: false };
const mocks = vi.hoisted(() => ({ openDocument: vi.fn(), ocrCapability: vi.fn(), recognizePageOcr: vi.fn(), cancelPageOcr: vi.fn() }));

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onCloseRequested: vi.fn().mockResolvedValue(vi.fn()) }) }));
vi.mock('./bridge', () => ({
  native: true, openDocument: mocks.openDocument, reopenDocument: vi.fn(), closeDocument: vi.fn(), editPages: vi.fn(), saveCopy: vi.fn(), splitDocument: vi.fn(), cropPages: vi.fn(), resetCrops: vi.fn(), combineDocuments: vi.fn(), insertPagesCopy: vi.fn(), replacePagesCopy: vi.fn(), documentFormFields: vi.fn().mockResolvedValue({ status: 'unsupported', reason: null, fields: [] }), fillFormCopy: vi.fn(), documentAnnotations: vi.fn().mockResolvedValue({ status: 'unsupported', reason: null, annotations: [] }), documentPageLabels: vi.fn().mockResolvedValue({ documentId: 3, revision: 9, labels: [null, null] }), createPdfFromImage: vi.fn(), exportPageImage: vi.fn(), createComment: vi.fn(), updateComment: vi.fn(), deleteComment: vi.fn(), createHighlight: vi.fn(), createTextHighlight: vi.fn(), updateHighlight: vi.fn(), deleteHighlight: vi.fn(), ocrCapability: mocks.ocrCapability, recognizePageOcr: mocks.recognizePageOcr, cancelPageOcr: mocks.cancelPageOcr
}));
vi.mock('./Viewer', () => ({ default: ({ document }: { document: DocumentInfo }) => <div data-viewed-document={document.id}>{document.name}</div> }));

const button = (ui: ReactTestRenderer, text: string) => ui.root.findAllByType('button').find(item => item.children.join('') === text)!;
const openMenu = (ui: ReactTestRenderer) => act(() => ui.root.findByProps({ 'aria-expanded': false }).props.onClick());
async function mount() { let ui!: ReactTestRenderer; await act(async () => { ui = create(<App />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); }); return ui; }

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });
  mocks.openDocument.mockResolvedValue({ status: 'opened', document: source });
  mocks.cancelPageOcr.mockResolvedValue({ requestId: '11111111-1111-4111-8111-111111111111', status: 'cancelled' });
});
afterEach(() => vi.unstubAllGlobals());

it('keeps Scan & OCR disabled when this build has no opt-in engine', async () => {
  mocks.ocrCapability.mockResolvedValue({ available: false, reason: 'OCR is not enabled in this build.', language: null });
  const ui = await mount();
  await act(async () => button(ui, 'Open a file').props.onClick());
  openMenu(ui);
  const scan = button(ui, 'Recognize current page…');
  expect(scan.props.disabled).toBe(true);
  expect(scan.props.title).toBe('OCR is not enabled in this build.');
  act(() => ui.unmount());
});

it('fails closed for an incoherent OCR capability response', async () => {
  mocks.ocrCapability.mockResolvedValue({ available: true, reason: 'unexpected', language: 'eng' });
  const ui = await mount();
  await act(async () => button(ui, 'Open a file').props.onClick());
  openMenu(ui);
  const scan = button(ui, 'Recognize current page…');
  expect(scan.props.disabled).toBe(true);
  expect(scan.props.title).toBe('OCR is unavailable in this build.');
  act(() => ui.unmount());
});

it('uses capability-gated OCR for the current physical page without mutating source state', async () => {
  mocks.ocrCapability.mockResolvedValue({ available: true, reason: null, language: 'eng' });
  mocks.recognizePageOcr.mockImplementation((request: { requestId: string }) => Promise.resolve({ status: 'recognized', requestId: request.requestId, documentId: 3, revision: 9, page: 1, dpi: 150, language: 'eng', width: 612, height: 792, text: 'OCR text' }));
  const ui = await mount();
  await act(async () => button(ui, 'Open a file').props.onClick());
  act(() => ui.root.findByProps({ 'aria-label': 'Next page' }).props.onClick());
  openMenu(ui);
  await act(async () => button(ui, 'Recognize current page…').props.onClick());
  expect(mocks.recognizePageOcr).toHaveBeenCalledWith({ requestId: '11111111-1111-4111-8111-111111111111', id: 3, revision: 9, page: 1 });
  expect(ui.root.findByType('textarea').props.value).toBe('OCR text');
  const rendered = JSON.stringify(ui.toJSON());
  expect(rendered).toContain('source.pdf"," *');
  expect(ui.root.findAllByProps({ 'data-viewed-document': 3 })).toHaveLength(1);
  expect(ui.root.findAllByProps({ 'data-viewed-document': 4 })).toHaveLength(0);
  act(() => ui.unmount());
});
