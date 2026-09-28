import { type ComponentProps } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageTextGeometry, type PageTextGeometry } from './bridge';
import TextLayer from './TextLayer';

vi.mock('./bridge', () => ({ pageTextGeometry: vi.fn() }));

const geometry = (overrides: Partial<PageTextGeometry> = {}): PageTextGeometry => ({
  id: 7, page: 2, revision: 4, status: 'ok', truncated: false,
  characters: [
    { text: '<script>', bounds: { x: .1, y: .2, width: .05, height: .04 }, angle: 0 },
    { text: ' ', bounds: null, angle: 0 },
    { text: 'copy', bounds: { x: .16, y: .2, width: .1, height: .04 }, angle: 0 }
  ], reason: null, ...overrides
});

async function mount(props: Partial<ComponentProps<typeof TextLayer>> = {}) {
  let ui!: ReactTestRenderer;
  await act(async () => { ui = create(<TextLayer id={7} page={2} revision={4} enabled imageReady pageWidth={400} pageHeight={500} {...props} />); });
  return ui;
}

describe('on-page text layer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses plain text nodes and normalized geometry sized to the rendered page', async () => {
    vi.mocked(pageTextGeometry).mockResolvedValue(geometry());
    const ui = await mount();
    const layer = ui.root.findByProps({ 'data-testid': 'text-layer' });
    const glyphs = layer.findAllByType('span');
    expect(glyphs).toHaveLength(3);
    expect(glyphs[0].children).toEqual(['<script>']);
    expect(glyphs.map(glyph => glyph.props['data-geometry-index'])).toEqual([0, 1, 2]);
    expect(ui.root.findAllByType('script')).toHaveLength(0);
    expect(glyphs[0].props.style).toMatchObject({ left: '0px', top: '0px', fontSize: '1px' });
    expect(glyphs[2].children).toEqual(['copy']);
    expect(pageTextGeometry).toHaveBeenCalledWith(7, 2, 4);
    act(() => ui.unmount());
  });

  it('does not request or render selectable text while the hand tool is active', async () => {
    const ui = await mount({ enabled: false });
    expect(pageTextGeometry).not.toHaveBeenCalled();
    expect(ui.root.findAllByProps({ 'data-testid': 'text-layer' })).toHaveLength(0);
    act(() => ui.unmount());
  });

  it('requests geometry for search in pan mode, highlights cross-glyph matches, and leaves text selection disabled', async () => {
    vi.mocked(pageTextGeometry).mockResolvedValue(geometry({ characters: [
      { text: 'A', bounds: { x: .1, y: .2, width: .05, height: .04 }, angle: 0 },
      { text: ' ', bounds: null, angle: 0 },
      { text: 'B', bounds: { x: .2, y: .2, width: .05, height: .04 }, angle: 0 }
    ] }));
    const ui = await mount({ enabled: false, search: { query: 'A B', matchCase: true } });
    const highlights = ui.root.findAllByProps({ 'data-testid': 'search-highlight' });
    expect(pageTextGeometry).toHaveBeenCalledWith(7, 2, 4);
    expect(highlights).toHaveLength(2);
    expect(highlights[0].props.style.left).toBe(40);
    expect(highlights[0].props.style.top).toBe(100);
    expect(highlights[0].props.style.width).toBeCloseTo(20);
    expect(highlights[0].props.style.height).toBeCloseTo(20);
    expect(ui.root.findAllByProps({ 'data-testid': 'text-layer' })).toHaveLength(0);
    act(() => ui.unmount());
  });

  it('clears stale highlight boxes when the current query changes', async () => {
    vi.mocked(pageTextGeometry).mockResolvedValue(geometry({ characters: [{ text: 'needle', bounds: { x: .1, y: .2, width: .1, height: .04 }, angle: 0 }] }));
    const ui = await mount({ enabled: false, search: { query: 'needle', matchCase: false } });
    expect(ui.root.findAllByProps({ 'data-testid': 'search-highlight' })).toHaveLength(1);
    await act(async () => { ui.update(<TextLayer id={7} page={2} revision={4} enabled={false} imageReady pageWidth={400} pageHeight={500} search={{ query: 'changed', matchCase: false }} />); });
    expect(ui.root.findAllByProps({ 'data-testid': 'search-highlight' })).toHaveLength(0);
    expect(JSON.stringify(ui.toJSON())).toContain('unavailable for this match');
    act(() => ui.unmount());
  });

  it('uses an honest fallback when a matching page cannot map a result to a positioned glyph', async () => {
    vi.mocked(pageTextGeometry).mockResolvedValue(geometry({ characters: [
      { text: 'needle', bounds: null, angle: 0 },
      { text: 'elsewhere', bounds: { x: .1, y: .2, width: .1, height: .04 }, angle: 0 }
    ] }));
    const ui = await mount({ enabled: false, search: { query: 'needle', matchCase: false } });
    expect(ui.root.findAllByProps({ 'data-testid': 'search-highlight' })).toHaveLength(0);
    expect(JSON.stringify(ui.toJSON())).toContain('Use Find results or Read and copy page text instead');
    act(() => ui.unmount());
  });

  it('ignores stale geometry after a page changes', async () => {
    let resolveOld!: (value: PageTextGeometry) => void;
    const old = new Promise<PageTextGeometry>(resolve => { resolveOld = resolve; });
    vi.mocked(pageTextGeometry).mockImplementationOnce(() => old).mockResolvedValueOnce(geometry({ id: 8, page: 3, revision: 5, characters: [{ text: 'fresh', bounds: { x: 0, y: 0, width: .1, height: .1 }, angle: 0 }] }));
    const ui = await mount();
    await act(async () => { ui.update(<TextLayer id={8} page={3} revision={5} enabled imageReady pageWidth={400} pageHeight={500} />); });
    expect(JSON.stringify(ui.toJSON())).toContain('fresh');
    await act(async () => { resolveOld(geometry()); });
    expect(JSON.stringify(ui.toJSON())).toContain('fresh');
    expect(JSON.stringify(ui.toJSON())).not.toContain('<script>');
    act(() => ui.unmount());
  });

  it('keeps cardinal orientation metadata on each selectable glyph', async () => {
    vi.mocked(pageTextGeometry).mockResolvedValue(geometry({ characters: [{ text: 'R', bounds: { x: .1, y: .2, width: .05, height: .04 }, angle: 90 }] }));
    const ui = await mount();
    expect(ui.root.findByType('span').props['data-angle']).toBe(90);
    act(() => ui.unmount());
  });

  it.each([
    geometry({ status: 'unsupported', characters: [], reason: 'Skewed text is unsupported.' }),
    geometry({ truncated: true, reason: 'Text geometry was capped.' }),
    geometry({ characters: [{ text: 'bad', bounds: { x: 1.1, y: 0, width: .1, height: .1 }, angle: 0 }] })
  ])('uses the page-text command when geometry cannot be safely positioned', async result => {
    vi.mocked(pageTextGeometry).mockResolvedValue(result);
    const ui = await mount();
    expect(ui.root.findAllByProps({ role: 'status' })).toHaveLength(1);
    expect(JSON.stringify(ui.toJSON())).toContain('Read and copy page text instead');
    expect(ui.root.findAllByProps({ 'data-testid': 'text-layer' })).toHaveLength(0);
    act(() => ui.unmount());
  });

  it.each([
    'This PDF does not allow text and graphics extraction.',
    'The PDF extraction permission could not be verified.'
  ])('does not direct a denied extraction request to Page text: %s', async error => {
    vi.mocked(pageTextGeometry).mockRejectedValue(new Error(error));
    const ui = await mount();
    expect(JSON.stringify(ui.toJSON())).toContain(error);
    expect(JSON.stringify(ui.toJSON())).not.toContain('Read and copy page text instead');
    act(() => ui.unmount());
  });
});
