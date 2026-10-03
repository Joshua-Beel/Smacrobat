import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import MultiImagePdfDialog from './MultiImagePdfDialog';
import type { SavedCopy } from './bridge';
import type { ImagePdfSource } from './multiImagePdf';

const sources: ImagePdfSource[] = [{ path: 'C:/images/a.png', name: 'a.png', identity: 'file-a' }, { path: 'C:/images/b.jpg', name: 'b.jpg', identity: 'file-b' }, { path: 'C:/images/c.png', name: 'c.png', identity: 'file-c' }];
const saved: SavedCopy = { path: 'C:/output.pdf', document: { id: 4, name: 'output.pdf', path: 'C:/output.pdf', pages: [{ width: 612, height: 792 }], revision: 0, dirty: false, can_undo: false, can_redo: false } };
const button = (ui: ReactTestRenderer, text: string) => ui.root.findAllByType('button').find(item => item.children.join('') === text)!;
const field = (ui: ReactTestRenderer, label: string) => ui.root.findByProps({ 'aria-label': label });

async function mount(choose = vi.fn().mockResolvedValue(sources), createPdf = vi.fn().mockResolvedValue(saved)) {
  const close = vi.fn(); let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<MultiImagePdfDialog busy={false} choose={choose} create={createPdf} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, choose, createPdf, close };
}

it('keeps native selection order, supports deterministic reorder and removal, and submits exact shared options', async () => {
  const { ui, createPdf, close } = await mount();
  expect(button(ui, 'Create PDF').props.disabled).toBe(true);
  await act(async () => button(ui, 'Choose images').props.onClick());
  expect(ui.root.findAllByType('li').map(item => item.children.filter(child => typeof child === 'string').join(''))).toEqual(['', '', '']);
  act(() => field(ui, 'Move image 2, b.jpg, up').props.onClick());
  act(() => field(ui, 'Remove image 3, c.png').props.onClick());
  act(() => field(ui, 'Page size').props.onChange({ target: { value: 'a4' } }));
  act(() => field(ui, 'Orientation').props.onChange({ target: { value: 'landscape' } }));
  act(() => field(ui, 'Margin in points').props.onChange({ target: { value: '12.5' } }));
  await act(async () => button(ui, 'Create PDF').props.onClick());
  expect(createPdf).toHaveBeenCalledWith({ sources: [sources[1], sources[0]], options: { pageSize: 'a4', orientation: 'landscape', marginPoints: 12.5 } });
  expect(close).toHaveBeenCalledOnce();
  act(() => ui.unmount());
});

it('retains the list on picker or save cancellation and surfaces invalid native selections', async () => {
  const choose = vi.fn().mockResolvedValueOnce(sources).mockResolvedValueOnce(null).mockResolvedValueOnce([sources[0], { ...sources[0], path: 'C:/images/./a.png', name: 'duplicate.png' }]);
  const createPdf = vi.fn().mockResolvedValue(null);
  const { ui, close } = await mount(choose, createPdf);
  await act(async () => button(ui, 'Choose images').props.onClick());
  await act(async () => button(ui, 'Choose different images').props.onClick());
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('current list is unchanged');
  await act(async () => button(ui, 'Create PDF').props.onClick());
  expect(close).not.toHaveBeenCalled();
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('image list');
  await act(async () => button(ui, 'Choose different images').props.onClick());
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('unique');
  expect(createPdf).toHaveBeenCalledOnce();
  act(() => ui.unmount());
});

it('gives equal basenames distinct position-qualified controls', async () => {
  const sameNames: ImagePdfSource[] = [{ path: 'C:/one/a.png', name: 'a.png', identity: 'file-one' }, { path: 'C:/two/a.png', name: 'a.png', identity: 'file-two' }];
  const { ui } = await mount(vi.fn().mockResolvedValue(sameNames));
  await act(async () => button(ui, 'Choose images').props.onClick());
  expect(field(ui, 'Remove image 1, a.png')).toBeTruthy();
  expect(field(ui, 'Remove image 2, a.png')).toBeTruthy();
  expect(ui.root.findAllByProps({ 'aria-label': 'Remove a.png' })).toHaveLength(0);
  act(() => ui.unmount());
});

it('discloses normalization and refuses invalid options before native creation', async () => {
  const { ui, createPdf } = await mount();
  expect(JSON.stringify(ui.toJSON())).toContain('ICC color profiles and image metadata are not retained');
  await act(async () => button(ui, 'Choose images').props.onClick());
  act(() => field(ui, 'Margin in points').props.onChange({ target: { value: '72.01' } }));
  await act(async () => button(ui, 'Create PDF').props.onClick());
  expect(ui.root.findByProps({ role: 'alert' }).children.join('')).toContain('between 0 and 72');
  expect(createPdf).not.toHaveBeenCalled();
  act(() => ui.unmount());
});
