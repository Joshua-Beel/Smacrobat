import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import ExportPageImageDialog, { DEFAULT_PNG_DPI, MAX_PNG_PIXELS, pageImageDimensions, validPageImageReceipt, validatePageImageDimensions, type PageImageTarget } from './ExportPageImageDialog';
import type { PageImageExport } from './bridge';

const target: PageImageTarget = { id: 7, revision: 4, page: 2, size: { width: 612, height: 792 } };
const receipt = (overrides: Partial<PageImageExport> = {}): PageImageExport => ({ path: 'C:/exports/source-page-3.png', documentId: 7, revision: 4, page: 2, dpi: 150, width: 1275, height: 1650, ...overrides });
const button = (ui: ReactTestRenderer, text: string) => ui.root.findAllByType('button').find(item => item.children.join('') === text)!;
const field = (ui: ReactTestRenderer) => ui.root.findByProps({ 'aria-label': 'PNG resolution' });

async function mount({ busy = false, exportPage = vi.fn().mockResolvedValue(receipt()), close = vi.fn() }: { busy?: boolean; exportPage?: ReturnType<typeof vi.fn>; close?: ReturnType<typeof vi.fn> } = {}) {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<ExportPageImageDialog target={target} busy={busy} exportPage={exportPage} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, exportPage, close };
}

it('derives bounded pixels from displayed points and accepts only exact receipts', () => {
  expect(DEFAULT_PNG_DPI).toBe(150);
  expect(pageImageDimensions({ width: 612, height: 792 }, 72)).toEqual({ width: 612, height: 792 });
  expect(pageImageDimensions({ width: 612, height: 792 }, 150)).toEqual({ width: 1275, height: 1650 });
  expect(validatePageImageDimensions({ width: 5_000, height: 6_400 })).toBeNull();
  expect(validatePageImageDimensions({ width: 5_000, height: Math.floor(MAX_PNG_PIXELS / 5_000) + 1 })).toContain('32 megapixels');
  const request = { id: 7, revision: 4, page: 2, dpi: 150 } as const;
  expect(validPageImageReceipt(receipt(), request, { width: 1275, height: 1650 })).toBe(true);
  expect(validPageImageReceipt(receipt({ page: 1 }), request, { width: 1275, height: 1650 })).toBe(false);
  expect(validPageImageReceipt(receipt({ width: 1274 }), request, { width: 1275, height: 1650 })).toBe(false);
});

it('submits the current zero-based physical page and reports its pixel output', async () => {
  const { ui, exportPage } = await mount();
  expect(JSON.stringify(ui.toJSON())).toContain('physical page ","3');
  expect(JSON.stringify(ui.toJSON())).toContain('white-flattened 8-bit RGB');
  await act(async () => button(ui, 'Export PNG').props.onClick());
  expect(exportPage).toHaveBeenCalledWith({ id: 7, revision: 4, page: 2, dpi: 150 });
  expect(JSON.stringify(ui.toJSON())).toContain('1,275"," × ","1,650"," pixel PNG at ","150"," DPI');
  act(() => ui.unmount());
});

it('uses only the supported DPI values and previews exact dimensions', async () => {
  const { ui, exportPage } = await mount();
  expect(field(ui).props.value).toBe(150);
  expect(field(ui).findAllByType('option').map(option => option.props.value)).toEqual([72, 150, 300]);
  act(() => field(ui).props.onChange({ target: { value: '72' } }));
  expect(JSON.stringify(ui.toJSON())).toContain('612 × 792 pixels at 72 DPI');
  await act(async () => button(ui, 'Export PNG').props.onClick());
  expect(exportPage).toHaveBeenCalledWith({ id: 7, revision: 4, page: 2, dpi: 72 });
  act(() => ui.unmount());
});

it('keeps cancellation and errors retryable, rejecting stale or malformed native receipts', async () => {
  const exportPage = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(receipt({ revision: 5 })).mockRejectedValueOnce(new Error('Native export refused.')).mockResolvedValueOnce(receipt());
  const { ui, close } = await mount({ exportPage });
  await act(async () => button(ui, 'Export PNG').props.onClick());
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('canceled');
  await act(async () => button(ui, 'Export PNG').props.onClick());
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('did not match');
  await act(async () => button(ui, 'Export PNG').props.onClick());
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toBe('Native export refused.');
  await act(async () => button(ui, 'Export PNG').props.onClick());
  expect(close).not.toHaveBeenCalled();
  expect(JSON.stringify(ui.toJSON())).toContain('PNG export complete');
  act(() => ui.unmount());
});

it('blocks duplicate submits and dialog cancellation while work is in flight', async () => {
  let resolve!: (value: PageImageExport | null) => void;
  const exportPage = vi.fn().mockImplementation(() => new Promise<PageImageExport | null>(done => { resolve = done; }));
  const { ui, close } = await mount({ exportPage });
  act(() => { button(ui, 'Export PNG').props.onClick(); button(ui, 'Export PNG').props.onClick(); });
  expect(exportPage).toHaveBeenCalledOnce();
  expect(field(ui).props.disabled).toBe(true);
  const preventDefault = vi.fn();
  act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault }));
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await act(async () => resolve(null));
  act(() => ui.unmount());
});

it('ignores a late native result after the dialog is removed', async () => {
  let resolve!: (value: PageImageExport | null) => void;
  const exportPage = vi.fn().mockImplementation(() => new Promise<PageImageExport | null>(done => { resolve = done; }));
  const { ui } = await mount({ exportPage });
  act(() => button(ui, 'Export PNG').props.onClick());
  act(() => ui.unmount());
  await act(async () => resolve(receipt()));
  expect(exportPage).toHaveBeenCalledOnce();
});
