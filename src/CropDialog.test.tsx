import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import CropDialog, { batchCropPreview, cropPreview } from './CropDialog';

const validInsets = { top: '72', right: '36', bottom: '36', left: '72' };
const input = (ui: ReactTestRenderer, edge: string) => ui.root.findByProps({ 'aria-label': `${edge} crop inset` });
const apply = (ui: ReactTestRenderer) => ui.root.findAllByType('button').find(button => button.children.join('') === 'Apply crop')!;

describe('current-page crop', () => {
  it('validates finite non-negative insets, overlap, and the one-point boundary', () => {
    expect(cropPreview(100, 80, { top: '-1', right: '0', bottom: '0', left: '0' })).toBe('Enter finite, non-negative inset values in points.');
    expect(cropPreview(100, 80, { top: 'Infinity', right: '0', bottom: '0', left: '0' })).toBe('Enter finite, non-negative inset values in points.');
    expect(cropPreview(100, 80, { top: '0', right: '50', bottom: '0', left: '50' })).toBe('Insets must leave at least 1 point in both dimensions.');
    expect(cropPreview(100, 80, { top: '0', right: '99', bottom: '0', left: '0' })).toEqual({ rect: { x: 0, y: 0, width: .01, height: 1 }, width: 1, height: 80 });
  });

  it('summarizes mixed displayed sizes and identifies the last invalid target', () => {
    const preview = batchCropPreview([{ page: 0, width: 612, height: 792 }, { page: 1, width: 792, height: 612 }], validInsets);
    expect(preview).toMatchObject({ minWidth: 504, maxWidth: 684, minHeight: 504, maxHeight: 684 });
    expect(batchCropPreview([{ page: 0, width: 612, height: 792 }, { page: 4, width: 100, height: 80 }], { top: '0', right: '100', bottom: '0', left: '0' })).toBe('Insets must leave at least 1 point in both dimensions on page 5.');
  });

  it('uses the displayed rotated page dimensions for point insets and preview', () => {
    expect(cropPreview(792, 612, validInsets)).toEqual({ rect: { x: 72 / 792, y: 72 / 612, width: 684 / 792, height: 504 / 612 }, width: 684, height: 504 });
  });

  it('does not apply an unchanged page or duplicate an in-flight crop', async () => {
    let resolve!: () => void;
    const crop = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const close = vi.fn();
    let ui!: ReactTestRenderer;
    await act(async () => { ui = create(<CropDialog pages={[{ page: 0, width: 612, height: 792 }]} busy={false} crop={crop} close={close} />); });
    await act(async () => apply(ui).props.onClick());
    expect(crop).not.toHaveBeenCalled();
    for (const [edge, value] of Object.entries(validInsets)) act(() => input(ui, edge[0].toUpperCase() + edge.slice(1)).props.onChange({ target: { value } }));
    act(() => apply(ui).props.onClick());
    act(() => apply(ui).props.onClick());
    expect(crop).toHaveBeenCalledOnce();
    expect(crop).toHaveBeenCalledWith({ top: 72, right: 36, bottom: 36, left: 72 });
    expect(ui.root.findByProps({ 'aria-label': 'Top crop inset' }).props.disabled).toBe(true);
    act(() => ui.root.findByType('dialog').props.onCancel({ preventDefault: vi.fn() }));
    expect(close).not.toHaveBeenCalled();
    await act(async () => resolve());
    act(() => ui.unmount());
  });

  it('keeps the dialog open after a stale document failure so the user can retry or cancel', async () => {
    const crop = vi.fn().mockRejectedValueOnce(new Error('Document changed. Crop again.')).mockResolvedValueOnce(undefined);
    const close = vi.fn(); let ui!: ReactTestRenderer;
    await act(async () => { ui = create(<CropDialog pages={[{ page: 1, width: 612, height: 792 }]} busy={false} crop={crop} close={close} />); });
    for (const [edge, value] of Object.entries(validInsets)) act(() => input(ui, edge[0].toUpperCase() + edge.slice(1)).props.onChange({ target: { value } }));
    await act(async () => apply(ui).props.onClick());
    expect(JSON.stringify(ui.toJSON())).toContain('Document changed. Crop again.');
    expect(close).not.toHaveBeenCalled();
    await act(async () => apply(ui).props.onClick());
    expect(close).toHaveBeenCalledOnce();
    act(() => ui.unmount());
  });
});
