import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import CreatePdfDialog from './CreatePdfDialog';
import type { SavedCopy } from './bridge';
import type { DocumentInfo } from './model';

const document = (id: number): DocumentInfo => ({ id, name: `created-${id}.pdf`, path: `C:/created-${id}.pdf`, pages: [{ width: 612, height: 792 }], revision: 0, dirty: false, can_undo: false, can_redo: false });
const output = (id = 1): SavedCopy => ({ path: `C:/created-${id}.pdf`, document: document(id) });
const field = (ui: ReactTestRenderer, label: string) => ui.root.findByProps({ 'aria-label': label });
const createButton = (ui: ReactTestRenderer) => ui.root.findAllByType('button').find(button => button.children.join('') === 'Create PDF')!;

async function mount({ busy = false, createPdf = vi.fn().mockResolvedValue(output()), close = vi.fn() }: { busy?: boolean; createPdf?: ReturnType<typeof vi.fn>; close?: ReturnType<typeof vi.fn> } = {}) {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<CreatePdfDialog busy={busy} create={createPdf} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, createPdf, close };
}

it('uses the bounded default page policy and closes after a new copy is returned', async () => {
  const { ui, createPdf, close } = await mount();
  expect(JSON.stringify(ui.toJSON())).toContain('ICC color profiles and image metadata are not retained.');
  await act(async () => createButton(ui).props.onClick());
  expect(createPdf).toHaveBeenCalledWith({ pageSize: 'letter', orientation: 'auto', marginPoints: 36 });
  expect(close).toHaveBeenCalledOnce();
  act(() => ui.unmount());
});

it('passes the selected A4 landscape policy and decimal point margin', async () => {
  const { ui, createPdf } = await mount();
  act(() => field(ui, 'Page size').props.onChange({ target: { value: 'a4' } }));
  act(() => field(ui, 'Orientation').props.onChange({ target: { value: 'landscape' } }));
  act(() => field(ui, 'Margin in points').props.onChange({ target: { value: '12.5' } }));
  await act(async () => createButton(ui).props.onClick());
  expect(createPdf).toHaveBeenCalledWith({ pageSize: 'a4', orientation: 'landscape', marginPoints: 12.5 });
  act(() => ui.unmount());
});

it('rejects blank and out-of-range margins without native work', async () => {
  const blank = await mount();
  act(() => field(blank.ui, 'Margin in points').props.onChange({ target: { value: '' } }));
  await act(async () => createButton(blank.ui).props.onClick());
  expect(blank.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('between 0 and 72');
  expect(blank.createPdf).not.toHaveBeenCalled();
  act(() => blank.ui.unmount());

  const large = await mount();
  act(() => field(large.ui, 'Margin in points').props.onChange({ target: { value: '72.01' } }));
  await act(async () => createButton(large.ui).props.onClick());
  expect(large.ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('between 0 and 72');
  expect(large.createPdf).not.toHaveBeenCalled();
  act(() => large.ui.unmount());
});

it('keeps the dialog open on picker cancellation and permits retry', async () => {
  const createPdf = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(output(2));
  const { ui, close } = await mount({ createPdf });
  await act(async () => createButton(ui).props.onClick());
  expect(close).not.toHaveBeenCalled();
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('canceled');
  await act(async () => createButton(ui).props.onClick());
  expect(createPdf).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
  act(() => ui.unmount());
});

it('retains errors for retry and blocks duplicate work while native dialogs are open', async () => {
  let resolve!: (value: SavedCopy | null) => void;
  const createPdf = vi.fn().mockRejectedValueOnce(new Error('Unsupported image.')).mockImplementationOnce(() => new Promise<SavedCopy | null>(done => { resolve = done; }));
  const { ui, close } = await mount({ createPdf });
  await act(async () => createButton(ui).props.onClick());
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toBe('Unsupported image.');
  act(() => { createButton(ui).props.onClick(); createButton(ui).props.onClick(); });
  expect(createPdf).toHaveBeenCalledTimes(2);
  expect(field(ui, 'Margin in points').props.disabled).toBe(true);
  const preventDefault = vi.fn();
  act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault }));
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  await act(async () => resolve(null));
  act(() => ui.unmount());
});

it('blocks opening and submitting while another workspace operation is busy', async () => {
  const { ui, createPdf, close } = await mount({ busy: true });
  expect(field(ui, 'Page size').props.disabled).toBe(true);
  act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault: vi.fn() }));
  expect(close).not.toHaveBeenCalled();
  await act(async () => createButton(ui).props.onClick());
  expect(createPdf).not.toHaveBeenCalled();
  act(() => ui.unmount());
});
