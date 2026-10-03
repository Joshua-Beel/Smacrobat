import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import CommentLayer, { commentRectAtPoint, highlightRectFromPoints } from './CommentLayer';

const imageBounds = () => ({ left: 10, top: 20, width: 400, height: 200 } as DOMRect);

describe('CommentLayer', () => {
  it('converts a redaction drag to displayed-page points and renders point rectangles', () => {
    const createRedaction = vi.fn(); const bounds = { left: 10, top: 20, width: 200, height: 100 } as DOMRect;
    let ui!: ReactTestRenderer;
    act(() => { ui = create(<CommentLayer page={3} pageWidth={400} pageHeight={200} creatingComment={false} creatingHighlight={false} creatingRedaction redactions={[{ x: 40, y: 40, width: 80, height: 60 }]} onCommentCreate={vi.fn()} onHighlightCreate={vi.fn()} onRedactionCreate={createRedaction} onSelect={vi.fn()} imageBounds={() => bounds} annotations={[]} />); });
    const layer = ui.root.findByProps({ 'data-testid': 'comment-layer' });
    const target = { setPointerCapture:vi.fn() };
    act(() => layer.props.onPointerDown({ button:0, target, currentTarget:target, clientX:30, clientY:30, pointerId:7 }));
    act(() => layer.props.onPointerUp({ currentTarget:target, clientX:110, clientY:70, pointerId:7 }));
    expect(createRedaction).toHaveBeenCalledWith(3, { x:40, y:20, width:160, height:80 });
    const preview = ui.root.findAllByProps({ 'aria-hidden': 'true' }).find(node => node.props.style?.left === '10%');
    expect(preview?.props.style).toMatchObject({ left:'10%', top:'20%', width:'20%', height:'30%' });
  });
  it('creates a centered 20-point displayed-page rectangle and clamps it at the edge', () => {
    expect(commentRectAtPoint(.5, .5, 200, 100)).toEqual({ x: .45, y: .4, width: .1, height: .2 });
    expect(commentRectAtPoint(0, 1, 200, 100)).toEqual({ x: 0, y: .8, width: .1, height: .2 });
    expect(commentRectAtPoint(.5, .5, 0, 100)).toBeNull();
  });

  it('clamps a dragged area highlight and rejects zero or sub-point rectangles', () => {
    expect(highlightRectFromPoints({ x: .8, y: .7 }, { x: .2, y: .1 }, 200, 100)).toMatchObject({ x: .2, y: .1, height: .6 });
    expect(highlightRectFromPoints({ x: .8, y: .7 }, { x: .2, y: .1 }, 200, 100)?.width).toBeCloseTo(.6);
    expect(highlightRectFromPoints({ x: .1, y: .1 }, { x: .104, y: .2 }, 200, 100)).toBeNull();
    expect(highlightRectFromPoints({ x: -1, y: -1 }, { x: 2, y: 2 }, 200, 100)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('uses transparent note hit targets without creating a second icon', () => {
    const select = vi.fn();
    let ui!: ReactTestRenderer;
    act(() => { ui = create(<CommentLayer page={2} pageWidth={612} pageHeight={792} creatingComment={false} creatingHighlight={false} interactive onCommentCreate={vi.fn()} onHighlightCreate={vi.fn()} onSelect={select} imageBounds={imageBounds} annotations={[{ id: 'one', kind: 'note', page: 2, rect: { x: .1, y: .2, width: .03, height: .03 }, contents: 'Note' }, { id: 'hidden', kind: 'highlight', page: 2, rect: null, contents: null }]} />); });
    const buttons = ui.root.findAllByType('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props.style).toEqual({ left: '10%', top: '20%', width: '3%', height: '3%' });
    act(() => buttons[0].props.onClick({ stopPropagation: vi.fn() }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'one' }));
  });

  it('uses text-highlight quads instead of a multiline union rectangle', () => {
    const select = vi.fn();
    const annotation = { id: 'text', kind: 'highlight' as const, page: 2, rect: { x: .1, y: .1, width: .8, height: .7 }, quads: [{ x: .1, y: .1, width: .2, height: .04 }, { x: .1, y: .7, width: .2, height: .04 }], contents: null };
    let ui!: ReactTestRenderer;
    act(() => { ui = create(<CommentLayer page={2} pageWidth={612} pageHeight={792} creatingComment={false} creatingHighlight={false} interactive onCommentCreate={vi.fn()} onHighlightCreate={vi.fn()} onSelect={select} imageBounds={imageBounds} annotations={[annotation]} />); });
    const buttons = ui.root.findAllByType('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[1].props.style).toEqual({ left: '10%', top: '70%', width: '20%', height: '4%' });
    act(() => buttons[1].props.onClick({ stopPropagation: vi.fn() }));
    expect(select).toHaveBeenCalledWith(annotation);
  });

  it('keeps all on-page targets through 512 visible rects and routes 513 to the Comments list', () => {
    const annotations = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `h${index}`, kind: 'highlight' as const, page: 0, rect: { x: 0, y: 0, width: .1, height: .1 }, quads: index === count - 1 ? [] : [{ x: .1, y: .1, width: .01, height: .01 }], contents: null }));
    let ui!: ReactTestRenderer;
    act(() => { ui = create(<CommentLayer page={0} pageWidth={612} pageHeight={792} creatingComment={false} creatingHighlight={false} interactive onCommentCreate={vi.fn()} onHighlightCreate={vi.fn()} onSelect={vi.fn()} imageBounds={imageBounds} annotations={annotations(513)} />); });
    expect(ui.root.findAllByType('button')).toHaveLength(512);
    act(() => { ui.update(<CommentLayer page={0} pageWidth={612} pageHeight={792} creatingComment={false} creatingHighlight={false} interactive onCommentCreate={vi.fn()} onHighlightCreate={vi.fn()} onSelect={vi.fn()} imageBounds={imageBounds} annotations={annotations(514)} />); });
    expect(ui.root.findAllByType('button')).toHaveLength(0);
    expect(ui.root.findByProps({ role: 'status' }).children.join('')).toContain('Use Comments');
  });

  it('leaves large saved highlight areas out of Pan and Select pointer handling', () => {
    const annotation = { id: 'h1', kind: 'highlight' as const, page: 0, rect: { x: .05, y: .05, width: .9, height: .9 }, contents: null };
    let ui!: ReactTestRenderer;
    act(() => { ui = create(<CommentLayer page={0} pageWidth={612} pageHeight={792} creatingComment={false} creatingHighlight={false} interactive={false} onCommentCreate={vi.fn()} onHighlightCreate={vi.fn()} onSelect={vi.fn()} imageBounds={imageBounds} annotations={[annotation]} />); });
    expect(ui.root.findAllByType('button')).toHaveLength(0);
    act(() => { ui.update(<CommentLayer page={0} pageWidth={612} pageHeight={792} creatingComment={false} creatingHighlight={false} interactive onCommentCreate={vi.fn()} onHighlightCreate={vi.fn()} onSelect={vi.fn()} imageBounds={imageBounds} annotations={[annotation]} />); });
    expect(ui.root.findAllByType('button')).toHaveLength(1);
  });

  it('creates only in comment mode using the displayed image bounds', () => {
    const createComment = vi.fn();
    let ui!: ReactTestRenderer;
    act(() => { ui = create(<CommentLayer page={0} pageWidth={200} pageHeight={100} creatingComment creatingHighlight={false} onCommentCreate={createComment} onHighlightCreate={vi.fn()} onSelect={vi.fn()} imageBounds={imageBounds} annotations={[]} />); });
    const layer = ui.root.findByProps({ 'data-testid': 'comment-layer' });
    const target = { setPointerCapture: vi.fn() };
    act(() => layer.props.onPointerDown({ button: 0, target, currentTarget: target, clientX: 210, clientY: 120 }));
    expect(createComment).toHaveBeenCalledWith(0, { x: .45, y: .4, width: .1, height: .2 });
    act(() => { ui.update(<CommentLayer page={0} pageWidth={200} pageHeight={100} creatingComment={false} creatingHighlight={false} onCommentCreate={createComment} onHighlightCreate={vi.fn()} onSelect={vi.fn()} imageBounds={imageBounds} annotations={[]} />); });
    act(() => layer.props.onPointerDown({ button: 0, target, currentTarget: target, clientX: 210, clientY: 120 }));
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it('uses the image client rectangle for a drag, then cancels it when the layout changes', () => {
    const createHighlight = vi.fn();
    let bounds = imageBounds();
    let ui!: ReactTestRenderer;
    act(() => { ui = create(<CommentLayer page={0} pageWidth={200} pageHeight={100} creatingComment={false} creatingHighlight onCommentCreate={vi.fn()} onHighlightCreate={createHighlight} onSelect={vi.fn()} imageBounds={() => bounds} layoutKey="0:200:100" annotations={[]} />); });
    const layer = ui.root.findByProps({ 'data-testid': 'comment-layer' });
    const target = { setPointerCapture: vi.fn() };
    act(() => layer.props.onPointerDown({ button: 0, pointerId: 3, target, currentTarget: target, clientX: 30, clientY: 40 }));
    act(() => layer.props.onPointerMove({ pointerId: 3, currentTarget: target, clientX: 230, clientY: 140 }));
    expect(ui.root.findAllByProps({ 'aria-hidden': 'true' })).toHaveLength(1);
    act(() => { ui.update(<CommentLayer page={0} pageWidth={200} pageHeight={100} creatingComment={false} creatingHighlight onCommentCreate={vi.fn()} onHighlightCreate={createHighlight} onSelect={vi.fn()} imageBounds={() => bounds} layoutKey="0:400:200" annotations={[]} />); });
    act(() => layer.props.onPointerUp({ pointerId: 3, currentTarget: target, clientX: 230, clientY: 140 }));
    expect(createHighlight).not.toHaveBeenCalled();
    act(() => layer.props.onPointerDown({ button: 0, pointerId: 4, target, currentTarget: target, clientX: 30, clientY: 40 }));
    bounds = { ...bounds, top: 48 } as DOMRect;
    act(() => layer.props.onPointerUp({ pointerId: 4, currentTarget: target, clientX: 230, clientY: 140 }));
    expect(createHighlight).not.toHaveBeenCalled();
  });

  it('creates a valid drag once and ignores zero-area and lost-capture drafts', () => {
    const createHighlight = vi.fn();
    let ui!: ReactTestRenderer;
    act(() => { ui = create(<CommentLayer page={0} pageWidth={200} pageHeight={100} creatingComment={false} creatingHighlight onCommentCreate={vi.fn()} onHighlightCreate={createHighlight} onSelect={vi.fn()} imageBounds={imageBounds} annotations={[]} />); });
    const layer = ui.root.findByProps({ 'data-testid': 'comment-layer' });
    const target = { setPointerCapture: vi.fn() };
    act(() => layer.props.onPointerDown({ button: 0, pointerId: 3, target, currentTarget: target, clientX: 30, clientY: 40 }));
    act(() => layer.props.onPointerUp({ pointerId: 3, currentTarget: target, clientX: 230, clientY: 140 }));
    expect(createHighlight).toHaveBeenCalledWith(0, { x: .05, y: .1, width: .5, height: .5 });
    act(() => layer.props.onPointerDown({ button: 0, pointerId: 4, target, currentTarget: target, clientX: 30, clientY: 40 }));
    act(() => layer.props.onPointerDown({ button: 0, pointerId: 5, target, currentTarget: target, clientX: 230, clientY: 140 }));
    act(() => layer.props.onPointerUp({ pointerId: 5, currentTarget: target, clientX: 230, clientY: 140 }));
    expect(createHighlight).toHaveBeenCalledTimes(1);
    act(() => layer.props.onPointerCancel());
    act(() => layer.props.onPointerUp({ pointerId: 4, currentTarget: target, clientX: 30, clientY: 40 }));
    expect(createHighlight).toHaveBeenCalledTimes(1);
  });
});
