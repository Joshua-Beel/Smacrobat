import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pageTextGeometry, type PageTextGeometry } from './bridge';
import { matchedCharacterIndexes, type SearchHighlightQuery } from './searchHighlights';
import { textHighlightFromBrowserSelection, type TextHighlightSelection, type TextHighlightSelectionSource } from './textHighlightSelection';
import styles from './TextLayer.module.css';

const MAX_GLYPHS = 20_000;
type State = { request: string; kind: 'loading' } | { request: string; kind: 'ready'; geometry: PageTextGeometry } | { request: string; kind: 'fallback'; message: string; suggestPageText: boolean };
type Bounds = NonNullable<PageTextGeometry['characters'][number]['bounds']>;

function geometryProblem(geometry: PageTextGeometry): string | null {
  if (geometry.status !== 'ok') return geometry.reason || 'This page does not provide positioned text.';
  if (geometry.truncated) return geometry.reason || 'This page has more text than can be positioned safely.';
  if (geometry.characters.length > MAX_GLYPHS) return 'This page has more text than can be positioned safely.';
  if (!geometry.characters.some(character => character.bounds)) return 'This page has no positioned embedded text.';
  for (const character of geometry.characters) {
    const bounds = character.bounds;
    if (!bounds) continue;
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.x < 0 || bounds.y < 0 || bounds.width <= 0 || bounds.height <= 0 || bounds.x > 1 || bounds.y > 1 || bounds.x + bounds.width > 1.0001 || bounds.y + bounds.height > 1.0001 || ![0, 90, 180, 270].includes(character.angle)) return 'This page returned invalid text positions.';
  }
  return null;
}

function targetBox(bounds: Bounds, pageWidth: number, pageHeight: number) {
  const targetWidth = (Math.min(1, bounds.x + bounds.width) - bounds.x) * pageWidth;
  const targetHeight = (Math.min(1, bounds.y + bounds.height) - bounds.y) * pageHeight;
  return { left: bounds.x * pageWidth, top: bounds.y * pageHeight, width: targetWidth, height: targetHeight };
}

function Glyph({ index, text, bounds, angle, pageWidth, pageHeight }: { index: number; text: string; bounds: Bounds; angle: number; pageWidth: number; pageHeight: number }) {
  const element = useRef<HTMLSpanElement>(null);
  const target = targetBox(bounds, pageWidth, pageHeight);
  const signature = `${angle}:${pageWidth}:${pageHeight}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${text}`;
  const [layout, setLayout] = useState<{ signature: string; left: number; top: number; scaleX: number; scaleY: number; pass: number } | null>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const range = document.createRange(); range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    if (!layout || layout.signature !== signature) {
      const width = angle % 180 ? target.height : target.width;
      const height = angle % 180 ? target.width : target.height;
      setLayout({ signature, left: target.left, top: target.top, scaleX: width / rect.width, scaleY: height / rect.height, pass: 1 });
      return;
    }
    if (layout.pass < 3) {
      const parent = node.parentElement?.getBoundingClientRect();
      if (!parent) return;
      const deltaX = parent.left + target.left - rect.left, deltaY = parent.top + target.top - rect.top;
      if (Math.abs(deltaX) > .1 || Math.abs(deltaY) > .1) setLayout(value => value && { ...value, left: value.left + deltaX, top: value.top + deltaY, pass: value.pass + 1 });
    }
  }, [angle, layout, signature, target.height, target.left, target.top, target.width, text]);
  const style = layout?.signature === signature ? { left: `${layout.left}px`, top: `${layout.top}px`, fontSize: '1px', transform: `${angle ? `rotate(${angle}deg) ` : ''}scale(${layout.scaleX}, ${layout.scaleY})` } : { left: '0px', top: '0px', fontSize: '1px' };
  return <span ref={element} className={styles.glyph} data-angle={angle} data-geometry-index={index} style={style}>{text}</span>;
}

function SearchHighlights({ geometry, indexes, pageWidth, pageHeight }: { geometry: PageTextGeometry; indexes: Set<number>; pageWidth: number; pageHeight: number }) {
  return <div className={styles.highlightLayer} aria-hidden="true" data-testid="search-highlights">
    {geometry.characters.map((character, index) => character.bounds && indexes.has(index) ? <span key={index} className={styles.highlight} data-testid="search-highlight" style={targetBox(character.bounds, pageWidth, pageHeight)} /> : null)}
  </div>;
}

export default function TextLayer({ id, page, revision, imageReady, enabled, pageWidth, pageHeight, search, onTextSelection }: { id: number; page: number; revision: number; imageReady: boolean; enabled: boolean; pageWidth: number; pageHeight: number; search?: SearchHighlightQuery; onTextSelection?: (selection: TextHighlightSelection | null, source: TextHighlightSelectionSource) => void }) {
  const request = `${id}:${page}:${revision}`;
  const [state, setState] = useState<State>({ request: '', kind: 'loading' });
  const layer = useRef<HTMLDivElement>(null);
  const sentSelection = useRef(false);
  const needsGeometry = enabled || Boolean(search);
  useEffect(() => {
    if (!needsGeometry || !imageReady) return;
    let disposed = false;
    setState({ request, kind: 'loading' });
    pageTextGeometry(id, page, revision).then(geometry => {
      if (disposed || geometry.id !== id || geometry.page !== page || geometry.revision !== revision) return;
      const problem = geometryProblem(geometry);
      setState(problem ? { request, kind: 'fallback', message: problem, suggestPageText: true } : { request, kind: 'ready', geometry });
    }).catch(error => { if (!disposed) setState({ request, kind: 'fallback', message: String(error), suggestPageText: false }); });
    return () => { disposed = true; };
  }, [id, imageReady, needsGeometry, page, request, revision]);

  useEffect(() => {
    const element = layer.current;
    if (!enabled || !onTextSelection || !element || state.request !== request || state.kind !== 'ready') return;
    const context = { id, page, revision };
    const changed = () => {
      const selection = textHighlightFromBrowserSelection(document.getSelection(), element, context);
      if (selection) { sentSelection.current = true; onTextSelection(selection, context); }
      else if (sentSelection.current) { sentSelection.current = false; onTextSelection(null, context); }
    };
    document.addEventListener('selectionchange', changed);
    changed();
    return () => {
      document.removeEventListener('selectionchange', changed);
      if (sentSelection.current) { sentSelection.current = false; onTextSelection(null, context); }
    };
  }, [enabled, id, onTextSelection, page, request, revision, state]);

  if (!needsGeometry || !imageReady || state.request !== request || state.kind === 'loading') return null;
  if (state.kind === 'fallback') return <div className={styles.fallback} role="status">{search ? 'On-page search highlights are unavailable.' : 'On-page text selection is unavailable.'} {state.message}{state.suggestPageText ? ' Use Read and copy page text instead.' : null}</div>;
  const highlightIndexes = search ? matchedCharacterIndexes(state.geometry.characters, search) : null;
  const hasPositionedHighlight = highlightIndexes ? [...highlightIndexes].some(index => Boolean(state.geometry.characters[index].bounds)) : false;
  return <>
    {search && (hasPositionedHighlight
      ? <SearchHighlights geometry={state.geometry} indexes={highlightIndexes!} pageWidth={pageWidth} pageHeight={pageHeight} />
      : <div className={styles.fallback} role="status">On-page search highlights are unavailable for this match. Use Find results or Read and copy page text instead.</div>)}
    {enabled && <div ref={layer} className={styles.layer} aria-hidden="true" data-testid="text-layer" data-text-layer={request}>
      {state.geometry.characters.map((character, index) => character.bounds
        ? <Glyph key={index} index={index} text={character.text} bounds={character.bounds} angle={character.angle} pageWidth={pageWidth} pageHeight={pageHeight} />
        : <span className={styles.unpositioned} data-geometry-index={index} key={index}>{character.text}</span>)}
    </div>}
  </>;
}
