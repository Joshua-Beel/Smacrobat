import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Annotation, CommentRect } from './bridge';
import s from './CommentLayer.module.css';

const clamp = (value: number, lower: number, upper: number) => Math.max(lower, Math.min(upper, value));
const positioned = (rect: CommentRect) => ({ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` });
const redactionPositioned = (rect: CommentRect, pageWidth: number, pageHeight: number) => positioned({ x: rect.x / pageWidth, y: rect.y / pageHeight, width: rect.width / pageWidth, height: rect.height / pageHeight });
const MAX_PAGE_HIT_RECTS = 512;

function hitRects(annotation: Annotation) {
  const rects = annotation.kind === 'highlight' && annotation.quads !== undefined && annotation.quads !== null ? annotation.quads : annotation.rect ? [annotation.rect] : [];
  return rects.filter(rect => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0);
}

export function commentRectAtPoint(x: number, y: number, pageWidth: number, pageHeight: number): CommentRect | null {
  if (![x, y, pageWidth, pageHeight].every(Number.isFinite) || pageWidth < 1 || pageHeight < 1) return null;
  const width = Math.min(20, pageWidth) / pageWidth;
  const height = Math.min(20, pageHeight) / pageHeight;
  return { x: clamp(x - width / 2, 0, 1 - width), y: clamp(y - height / 2, 0, 1 - height), width, height };
}

export function highlightRectFromPoints(first: { x: number; y: number }, second: { x: number; y: number }, pageWidth: number, pageHeight: number): CommentRect | null {
  if (![first.x, first.y, second.x, second.y, pageWidth, pageHeight].every(Number.isFinite) || pageWidth < 1 || pageHeight < 1) return null;
  const left = clamp(Math.min(first.x, second.x), 0, 1);
  const top = clamp(Math.min(first.y, second.y), 0, 1);
  const right = clamp(Math.max(first.x, second.x), 0, 1);
  const bottom = clamp(Math.max(first.y, second.y), 0, 1);
  const rect = { x: left, y: top, width: right - left, height: bottom - top };
  return rect.width * pageWidth >= 1 && rect.height * pageHeight >= 1 ? rect : null;
}

function point(event: PointerEvent<HTMLDivElement>, bounds: DOMRect) {
  return { x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1), y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) };
}
function sameBounds(first: DOMRect, second: DOMRect | null) {
  return !!second && first.left === second.left && first.top === second.top && first.width === second.width && first.height === second.height;
}

type Drag = { point: { x: number; y: number }; bounds: DOMRect; pointerId: number };

export default function CommentLayer({ page, pageWidth, pageHeight, annotations, creatingComment, creatingHighlight, creatingRedaction = false, redactions = [], interactive = false, onCommentCreate, onHighlightCreate, onRedactionCreate = () => {}, onSelect, imageBounds = () => null, layoutKey = '' }: { page: number; pageWidth: number; pageHeight: number; annotations: Annotation[]; creatingComment: boolean; creatingHighlight: boolean; creatingRedaction?: boolean; redactions?: CommentRect[]; interactive?: boolean; onCommentCreate: (page: number, rect: CommentRect) => void; onHighlightCreate: (page: number, rect: CommentRect) => void; onRedactionCreate?: (page: number, rect: CommentRect) => void; onSelect: (annotation: Annotation) => void; imageBounds?: () => DOMRect | null; layoutKey?: string }) {
  const drag = useRef<Drag | null>(null);
  const [draft, setDraft] = useState<CommentRect | null>(null);
  const cancel = () => { drag.current = null; setDraft(null); };
  useEffect(() => { cancel(); }, [creatingHighlight, creatingRedaction, layoutKey]);
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.target !== event.currentTarget || drag.current) return;
    const bounds = imageBounds();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    if (creatingComment) {
      const at = point(event, bounds);
      const rect = commentRectAtPoint(at.x, at.y, pageWidth, pageHeight);
      if (rect) onCommentCreate(page, rect);
      return;
    }
    if (!creatingHighlight && !creatingRedaction) return;
    drag.current = { point: point(event, bounds), bounds, pointerId: event.pointerId }; event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    if (!sameBounds(drag.current.bounds, imageBounds())) { cancel(); return; }
    setDraft(highlightRectFromPoints(drag.current.point, point(event, drag.current.bounds), pageWidth, pageHeight));
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    const activeDrag = drag.current;
    if (!activeDrag || activeDrag.pointerId !== event.pointerId) return;
    if (!sameBounds(activeDrag.bounds, imageBounds())) { cancel(); return; }
    const rect = highlightRectFromPoints(activeDrag.point, point(event, activeDrag.bounds), pageWidth, pageHeight);
    cancel();
    if (rect) creatingRedaction ? onRedactionCreate(page, { x: rect.x * pageWidth, y: rect.y * pageHeight, width: rect.width * pageWidth, height: rect.height * pageHeight }) : onHighlightCreate(page, rect);
  };
  const placing = creatingComment || creatingHighlight || creatingRedaction;
  const targets = interactive && !creatingHighlight && !creatingRedaction ? annotations.flatMap(annotation => hitRects(annotation).map((rect, index) => ({ annotation, rect, index }))) : [];
  const tooManyTargets = targets.length > MAX_PAGE_HIT_RECTS;
  return <div className={`${s.layer} ${placing ? s.creating : ''}`} data-testid="comment-layer" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}>
    {redactions.map((rect, index) => <span key={index} className={s.redaction} aria-hidden="true" style={redactionPositioned(rect, pageWidth, pageHeight)} />)}
    {draft && <span className={s.draft} aria-hidden="true" style={positioned(draft)} />}
    {tooManyTargets ? <p className={s.targetFallback} role="status">Use Comments to edit annotations on this page.</p> : targets.map(({ annotation, rect, index }) => <button key={`${annotation.id}:${index}`} type="button" className={s.note} aria-label={`Edit ${annotation.kind === 'note' ? 'comment' : 'highlight'} on page ${page + 1}`} title={annotation.kind === 'note' ? 'Edit comment' : 'Edit highlight'} style={positioned(rect)} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onSelect(annotation); }} />)}
  </div>;
}
