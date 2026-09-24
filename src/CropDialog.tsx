import { useEffect, useRef, useState } from 'react';
import type { CropInsets } from './bridge';
import s from './CropDialog.module.css';

type Insets = { top: string; right: string; bottom: string; left: string };
type CropRect = { x: number; y: number; width: number; height: number };
export type CropPage = { page: number; width: number; height: number };
type CropPreview = { insets: CropInsets; sizes: { page: number; width: number; height: number }[]; minWidth: number; maxWidth: number; minHeight: number; maxHeight: number };
const emptyInsets: Insets = { top: '0', right: '0', bottom: '0', left: '0' };

function readInset(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function cropPreview(pageWidth: number, pageHeight: number, insets: Insets): { rect: CropRect; width: number; height: number } | string {
  const top = readInset(insets.top), right = readInset(insets.right), bottom = readInset(insets.bottom), left = readInset(insets.left);
  if ([top, right, bottom, left].some(value => value === null)) return 'Enter finite, non-negative inset values in points.';
  const width = pageWidth - left! - right!, height = pageHeight - top! - bottom!;
  if (width < 1 || height < 1) return 'Insets must leave at least 1 point in both dimensions.';
  return { rect: { x: left! / pageWidth, y: top! / pageHeight, width: width / pageWidth, height: height / pageHeight }, width, height };
}

export function batchCropPreview(pages: CropPage[], insets: Insets): CropPreview | string {
  const top = readInset(insets.top), right = readInset(insets.right), bottom = readInset(insets.bottom), left = readInset(insets.left);
  if ([top, right, bottom, left].some(value => value === null)) return 'Enter finite, non-negative inset values in points.';
  if (!pages.length) return 'Select at least one page to crop.';
  const sizes: CropPreview['sizes'] = [];
  for (const page of pages) {
    const width = page.width - left! - right!, height = page.height - top! - bottom!;
    if (!Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0) return `Page ${page.page + 1} has unavailable dimensions.`;
    if (width < 1 || height < 1) return `Insets must leave at least 1 point in both dimensions on page ${page.page + 1}.`;
    sizes.push({ page: page.page, width, height });
  }
  return { insets: { top: top!, right: right!, bottom: bottom!, left: left! }, sizes, minWidth: Math.min(...sizes.map(size => size.width)), maxWidth: Math.max(...sizes.map(size => size.width)), minHeight: Math.min(...sizes.map(size => size.height)), maxHeight: Math.max(...sizes.map(size => size.height)) };
}

export default function CropDialog({ pages, busy, crop, close }: { pages: CropPage[]; busy: boolean; crop: (insets: CropInsets) => Promise<void>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [insets, setInsets] = useState<Insets>(emptyInsets);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const preview = batchCropPreview(pages, insets);
  const hasInsets = Object.values(insets).some(value => Number(value) > 0);
  const working = busy || submitting;
  const updateInset = (name: keyof Insets, value: string) => { setInsets(current => ({ ...current, [name]: value })); setError(''); };
  const submit = async () => {
    if (working || inFlight.current) return;
    if (typeof preview === 'string') { setError(preview); return; }
    if (!hasInsets) { setError('Enter an inset to crop the selected pages.'); return; }
    inFlight.current = true; setSubmitting(true); setError('');
    try { await crop(preview.insets); close(); }
    catch (reason) { setError(String(reason)); }
    finally { inFlight.current = false; setSubmitting(false); }
  };
  const uniform = typeof preview !== 'string' && preview.sizes.every(size => size.width === preview.sizes[0].width && size.height === preview.sizes[0].height);
  const sizeSummary = typeof preview === 'string' ? preview : uniform ? `Result: ${preview.sizes[0].width.toFixed(1)} × ${preview.sizes[0].height.toFixed(1)} pt on every selected page.` : `Result widths: ${preview.minWidth.toFixed(1)}–${preview.maxWidth.toFixed(1)} pt; heights: ${preview.minHeight.toFixed(1)}–${preview.maxHeight.toFixed(1)} pt. Mixed page sizes or rotations use a size-only preview.`;
  return <dialog ref={dialog} className={s.dialog} aria-labelledby="crop-title" onCancel={event => { event.preventDefault(); if (!working) close(); }}>
    <h2 id="crop-title">Crop {pages.length === 1 ? `page ${pages[0].page + 1}` : `${pages.length} pages`}</h2>
    <p>Enter the same amount to hide from each edge in points. Cropping hides content; it is not redaction.</p>
    <div className={s.insets}>
      {(['top', 'right', 'bottom', 'left'] as const).map(name => <label key={name}>{name[0].toUpperCase() + name.slice(1)} <input aria-label={`${name[0].toUpperCase() + name.slice(1)} crop inset`} inputMode="decimal" value={insets[name]} disabled={working} onChange={event => updateInset(name, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void submit(); } }} /> <span>pt</span></label>)}
    </div>
    <p className={s.preview}>{sizeSummary}</p>
    {error && <p role="alert">{error}</p>}
    {working && <p role="status">Applying crop…</p>}
    <div className={s.actions}><button disabled={working} onClick={close}>Cancel</button><button className={s.confirm} disabled={working} onClick={() => void submit()}>Apply crop</button></div>
  </dialog>;
}
