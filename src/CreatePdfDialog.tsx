import { useEffect, useRef, useState } from 'react';
import type { CreatePdfOptions, SavedCopy } from './bridge';
import s from './CombineDialog.module.css';

export const DEFAULT_CREATE_PDF_OPTIONS: CreatePdfOptions = { pageSize: 'letter', orientation: 'auto', marginPoints: 36 };

export function validateCreatePdfOptions(options: CreatePdfOptions): string | null {
  if (options.pageSize !== 'letter' && options.pageSize !== 'a4') return 'Choose Letter or A4 page size.';
  if (options.orientation !== 'auto' && options.orientation !== 'portrait' && options.orientation !== 'landscape') return 'Choose an image orientation.';
  if (!Number.isFinite(options.marginPoints) || options.marginPoints < 0 || options.marginPoints > 72) return 'Margin must be between 0 and 72 points.';
  return null;
}

export default function CreatePdfDialog({ busy, create, close }: { busy: boolean; create: (options: CreatePdfOptions) => Promise<SavedCopy | null>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [pageSize, setPageSize] = useState<CreatePdfOptions['pageSize']>(DEFAULT_CREATE_PDF_OPTIONS.pageSize);
  const [orientation, setOrientation] = useState<CreatePdfOptions['orientation']>(DEFAULT_CREATE_PDF_OPTIONS.orientation);
  const [margin, setMargin] = useState(String(DEFAULT_CREATE_PDF_OPTIONS.marginPoints));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const working = busy || submitting;
  const changed = (callback: () => void) => { callback(); setError(''); setNotice(''); };
  const submit = async () => {
    if (working || inFlight.current) return;
    if (!margin.trim()) { setError('Margin must be between 0 and 72 points.'); return; }
    const options: CreatePdfOptions = { pageSize, orientation, marginPoints: Number(margin) };
    const validation = validateCreatePdfOptions(options);
    if (validation) { setError(validation); return; }
    inFlight.current = true; setSubmitting(true); setError(''); setNotice('');
    try {
      const result = await create(options);
      if (result) close(); else setNotice('Creation canceled. Your workspace is unchanged.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setSubmitting(false); }
  };
  return <dialog ref={dialog} className={s.dialog} aria-labelledby="create-pdf-title" onCancel={event => { event.preventDefault(); if (!working) close(); }}>
    <h2 id="create-pdf-title">Create a PDF from an image</h2>
    <p>Choose one PNG or JPEG image. Windows will ask you to choose the image, then where to save the new one-page PDF.</p>
    <label>Page size <select aria-label="Page size" value={pageSize} disabled={working} onChange={event => changed(() => setPageSize(event.target.value as CreatePdfOptions['pageSize']))}><option value="letter">Letter</option><option value="a4">A4</option></select></label>
    <label>Orientation <select aria-label="Orientation" value={orientation} disabled={working} onChange={event => changed(() => setOrientation(event.target.value as CreatePdfOptions['orientation']))}><option value="auto">Auto (match image)</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
    <label>Margin <span><input aria-label="Margin in points" type="number" min="0" max="72" step="0.01" value={margin} disabled={working} onChange={event => changed(() => setMargin(event.target.value))} /> pt</span></label>
    <p className={s.preview}>The image is contained and centered with upscaling allowed; it is never cropped. Output colors are 8-bit RGB, transparency is composited on white, and ICC color profiles and image metadata are not retained.</p>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {working && <p role="status">Choosing the image and output location…</p>}
    <div className={s.actions}><button disabled={working} onClick={close}>Cancel</button><button className={s.confirm} disabled={working} onClick={() => void submit()}>Create PDF</button></div>
  </dialog>;
}
