import type { RasterRedactionRect } from './bridge';
import s from './RedactPanel.module.css';

export default function RedactPanel({ page, rectangles, busy, remove, clear, apply, close }: { page: number; rectangles: RasterRedactionRect[]; busy: boolean; remove: (index: number) => void; clear: () => void; apply: () => void; close: () => void }) {
  return <aside className={s.panel} aria-label="Redact a PDF">
    <div className={s.heading}><h2>Redact page {page + 1}</h2><button aria-label="Close redaction" onClick={close} disabled={busy}>×</button></div>
    <p>Drag rectangles over content on this page. The output rasterizes every page at 150 DPI and permanently blanks only these marked areas.</p>
    <p className={s.warning} role="note"><strong>The new copy loses searchable text, vectors, forms, annotations, metadata, bookmarks, and attachments.</strong> Your source PDF stays unchanged.</p>
    <div className={s.list} aria-label="Redaction rectangles">
      {!rectangles.length ? <p>No areas marked yet.</p> : rectangles.map((_, index) => <div key={index}><span>Area {index + 1}</span><button onClick={() => remove(index)} disabled={busy}>Remove</button></div>)}
    </div>
    <div className={s.actions}><button onClick={clear} disabled={busy || !rectangles.length}>Clear</button><button className={s.apply} onClick={apply} disabled={busy || !rectangles.length}>{busy ? 'Creating copy…' : 'Create redacted copy…'}</button></div>
    <p>{rectangles.length} of 256 areas marked.</p>
  </aside>;
}
