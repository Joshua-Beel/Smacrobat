import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import MultiImagePdfDialog from './MultiImagePdfDialog';
import type { SavedCopy } from './bridge';
import type { ImagePdfSelection } from './multiImagePdf';

const selection:ImagePdfSelection={selectionId:'selection-1',sources:[{sourceId:'source-a',name:'a.png'},{sourceId:'source-b',name:'b.jpg'},{sourceId:'source-c',name:'c.png'}]};
const replacement:ImagePdfSelection={selectionId:'selection-2',sources:[{sourceId:'source-d',name:'d.png'}]};
const saved: SavedCopy = { path: 'C:/output.pdf', document: { id: 4, name: 'output.pdf', path: 'C:/output.pdf', pages: [{ width: 612, height: 792 }], revision: 0, dirty: false, can_undo: false, can_redo: false } };
const button = (ui: ReactTestRenderer, text: string) => ui.root.findAllByType('button').find(item => item.children.join('') === text)!;
const field = (ui: ReactTestRenderer, label: string) => ui.root.findByProps({ 'aria-label': label });

async function mount(choose = vi.fn().mockResolvedValue(selection), createPdf = vi.fn().mockResolvedValue(saved), cancel = vi.fn().mockResolvedValue(undefined)) {
  const close = vi.fn(); let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<MultiImagePdfDialog busy={false} choose={choose} create={createPdf} cancel={cancel} close={close} />, { createNodeMock: element => element.type === 'dialog' ? { showModal: vi.fn() } : null }); });
  return { ui, choose, createPdf, cancel, close };
}

it('keeps native selection order, supports deterministic reorder and removal, and submits exact shared options', async () => {
  const { ui, createPdf, cancel, close } = await mount();
  expect(button(ui, 'Create PDF').props.disabled).toBe(true);
  await act(async () => button(ui, 'Choose images').props.onClick());
  expect(ui.root.findAllByType('li').map(item => item.children.filter(child => typeof child === 'string').join(''))).toEqual(['', '', '']);
  act(() => field(ui, 'Move image 2, b.jpg, up').props.onClick());
  act(() => field(ui, 'Remove image 3, c.png').props.onClick());
  act(() => field(ui, 'Page size').props.onChange({ target: { value: 'a4' } }));
  act(() => field(ui, 'Orientation').props.onChange({ target: { value: 'landscape' } }));
  act(() => field(ui, 'Margin in points').props.onChange({ target: { value: '12.5' } }));
  await act(async () => button(ui, 'Create PDF').props.onClick());
  expect(createPdf).toHaveBeenCalledWith({ selectionId:'selection-1',sourceIds:['source-b','source-a'], options: { pageSize: 'a4', orientation: 'landscape', marginPoints: 12.5 } });
  expect(close).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
  act(() => ui.unmount());
});

it('retains the reservation on replacement picker cancel/error and on save cancellation', async () => {
  const choose = vi.fn().mockResolvedValueOnce(selection).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Picker failed.')).mockResolvedValueOnce(replacement);
  const createPdf = vi.fn().mockResolvedValue(null);
  const { ui, close, cancel } = await mount(choose, createPdf);
  await act(async () => button(ui, 'Choose images').props.onClick());
  await act(async () => button(ui, 'Choose different images').props.onClick());
  expect(choose).toHaveBeenNthCalledWith(2,'selection-1');
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('current list is unchanged');
  expect(JSON.stringify(ui.toJSON())).toContain('a.png');
  await act(async () => button(ui, 'Choose different images').props.onClick());
  expect(ui.root.findByProps({role:'alert'}).children.join('')).toBe('Picker failed.');
  expect(JSON.stringify(ui.toJSON())).toContain('a.png');
  await act(async () => button(ui, 'Create PDF').props.onClick());
  expect(close).not.toHaveBeenCalled();
  expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('image list');
  await act(async () => button(ui, 'Choose different images').props.onClick());
  expect(JSON.stringify(ui.toJSON())).toContain('d.png');
  expect(createPdf).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
  act(() => ui.unmount());
});

it('gives equal basenames distinct position-qualified controls', async () => {
  const sameNames:ImagePdfSelection={selectionId:'same-names',sources:[{sourceId:'file-one',name:'a.png'},{sourceId:'file-two',name:'a.png'}]};
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

it('releases an active reservation on explicit close and restores it when release fails',async()=>{const cancel=vi.fn().mockRejectedValueOnce(new Error('Release failed.')).mockResolvedValueOnce(undefined);const{ui,close}=await mount(undefined,undefined,cancel);await act(async()=>button(ui,'Choose images').props.onClick());await act(async()=>button(ui,'Cancel').props.onClick());expect(close).not.toHaveBeenCalled();expect(ui.root.findByProps({role:'alert'}).children.join('')).toBe('Release failed.');expect(JSON.stringify(ui.toJSON())).toContain('a.png');await act(async()=>button(ui,'Cancel').props.onClick());expect(cancel).toHaveBeenCalledTimes(2);expect(close).toHaveBeenCalledOnce();act(()=>ui.unmount());});

it('releases an active reservation when its dialog owner unmounts unexpectedly',async()=>{const cancel=vi.fn().mockResolvedValue(undefined);const{ui}=await mount(undefined,undefined,cancel);await act(async()=>button(ui,'Choose images').props.onClick());act(()=>ui.unmount());expect(cancel).toHaveBeenCalledWith('selection-1');});
