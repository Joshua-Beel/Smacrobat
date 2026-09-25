import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cancelPageOcr, recognizePageOcr, type OcrReceipt } from './bridge';
import PageOcrDialog, { validPageOcrReceipt, type PageOcrTarget } from './PageOcrDialog';

vi.mock('./bridge', () => ({ recognizePageOcr: vi.fn(), cancelPageOcr: vi.fn() }));

const target: PageOcrTarget = { id: 7, revision: 4, page: 2, name: 'source.pdf' };
const receipt = (overrides: Partial<OcrReceipt> = {}): OcrReceipt => ({ status: 'recognized', requestId: '11111111-1111-4111-8111-111111111111', documentId: 7, revision: 4, page: 2, dpi: 150, language: 'eng', width: 800, height: 600, text: 'Recognized text', ...overrides });
const button = (ui: ReactTestRenderer, text: string) => ui.root.findAllByType('button').find(item => item.children.join('') === text)!;

beforeEach(() => {
  vi.clearAllMocks();
  let index = 0;
  vi.stubGlobal('crypto', { randomUUID: () => [`11111111-1111-4111-8111-111111111111`, `22222222-2222-4222-8222-222222222222`][index++] });
  vi.mocked(cancelPageOcr).mockResolvedValue({ requestId: '11111111-1111-4111-8111-111111111111', status: 'cancelled' });
});
afterEach(() => vi.unstubAllGlobals());

async function mount({ close = vi.fn(), setBusy = vi.fn() }: { close?: ReturnType<typeof vi.fn>; setBusy?: ReturnType<typeof vi.fn> } = {}) {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<PageOcrDialog target={target} setBusy={setBusy} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, close, setBusy };
}

it('captures one physical page and accepts only its bounded English receipt', async () => {
  vi.mocked(recognizePageOcr).mockImplementation(request => Promise.resolve(receipt({ requestId: request.requestId })));
  const { ui, setBusy } = await mount();
  expect(recognizePageOcr).toHaveBeenCalledWith({ requestId: '11111111-1111-4111-8111-111111111111', id: 7, revision: 4, page: 2 });
  const area = ui.root.findByType('textarea');
  expect(area.props.value).toBe('Recognized text');
  expect(area.props.readOnly).toBe(true);
  expect(ui.root.findAllByType('p')[0].children.join('')).toContain('physical page 3');
  expect(setBusy.mock.calls).toEqual([[true], [false]]);
  expect(validPageOcrReceipt(receipt(), { requestId: '11111111-1111-4111-8111-111111111111', id: 7, revision: 4, page: 2 })).toBe(true);
  expect(validPageOcrReceipt(receipt({ page: 1 }), { requestId: '11111111-1111-4111-8111-111111111111', id: 7, revision: 4, page: 2 })).toBe(false);
  expect(validPageOcrReceipt(receipt({ width: 16_384, height: 342 }), { requestId: '11111111-1111-4111-8111-111111111111', id: 7, revision: 4, page: 2 })).toBe(false);
  act(() => ui.unmount());
});

it('shows empty OCR separately and retries malformed receipts with a new operation identity', async () => {
  vi.mocked(recognizePageOcr).mockImplementationOnce(request => Promise.resolve(receipt({ requestId: request.requestId, revision: 5 }))).mockImplementationOnce(request => Promise.resolve(receipt({ requestId: request.requestId, status: 'no_text', text: '   ' })));
  const { ui } = await mount();
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('different page or document');
  await act(async () => button(ui, 'Try again').props.onClick());
  expect(recognizePageOcr).toHaveBeenLastCalledWith({ requestId: '22222222-2222-4222-8222-222222222222', id: 7, revision: 4, page: 2 });
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('No text was recognized');
  act(() => ui.unmount());
});

it('keeps the app busy while cancellation drains and discards a late result', async () => {
  let finish!: (value: OcrReceipt) => void;
  vi.mocked(recognizePageOcr).mockImplementation(request => new Promise(done => { finish = value => done({ ...value, requestId: request.requestId }); }));
  const { ui, setBusy, close } = await mount();
  const preventDefault = vi.fn();
  await act(async () => ui.root.findByType('dialog').props.onCancel({ preventDefault }));
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(cancelPageOcr).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('Canceling OCR');
  expect(setBusy.mock.calls.at(-1)).toEqual([true]);
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish(receipt()));
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('OCR canceled');
  expect(ui.root.findAllByType('textarea')).toHaveLength(0);
  expect(setBusy.mock.calls.at(-1)).toEqual([false]);
  act(() => ui.unmount());
});

it('keeps a truthful cancellation error while suppressing a late result or unmounted reply', async () => {
  let finish!: (value: OcrReceipt) => void;
  vi.mocked(recognizePageOcr).mockImplementation(request => new Promise(done => { finish = value => done({ ...value, requestId: request.requestId }); }));
  vi.mocked(cancelPageOcr).mockRejectedValue(new Error('transport failed'));
  const { ui } = await mount();
  await act(async () => button(ui, 'Cancel OCR').props.onClick());
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('Could not cancel OCR');
  await act(async () => finish(receipt()));
  expect(ui.root.findAllByType('textarea')).toHaveLength(0);
  act(() => ui.unmount());
  expect(cancelPageOcr).toHaveBeenCalledOnce();
});

it('cancels a pending unmount but releases global busy only after the original command settles', async () => {
  let finish!: (value: OcrReceipt) => void;
  vi.mocked(recognizePageOcr).mockImplementation(request => new Promise(done => { finish = value => done({ ...value, requestId: request.requestId }); }));
  const { ui, setBusy } = await mount();
  act(() => ui.unmount());
  expect(cancelPageOcr).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
  expect(setBusy.mock.calls).toEqual([[true]]);
  await act(async () => finish(receipt()));
  expect(setBusy.mock.calls).toEqual([[true], [false]]);
});
