import { useEffect, useRef, useState } from 'react';
import type { PageImageExport, PageImageExportRequest, PageImageFormat } from './bridge';
import type { PageSize } from './model';
import s from './CombineDialog.module.css';

export const PNG_DPI = [72, 150, 300] as const;
export const DEFAULT_PNG_DPI = 150;
export const MAX_PNG_EDGE = 16_384;
export const MAX_PNG_PIXELS = 32_000_000;
export const MAX_PNG_DECODED_BYTES = 128 * 1024 * 1024;
export const MAX_PNG_ENCODED_BYTES = 256 * 1024 * 1024;
export type PageImageTarget = { id: number; revision: number; page: number; size: PageSize };
export type PageImageDimensions = { width: number; height: number };
const formatName = (format: PageImageFormat) => format === 'png' ? 'PNG' : 'JPEG';

export function pageImageDimensions(size: PageSize, dpi: number): PageImageDimensions | null {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0 || !PNG_DPI.includes(dpi as typeof PNG_DPI[number])) return null;
  const width = Math.ceil(size.width * dpi / 72), height = Math.ceil(size.height * dpi / 72);
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 ? { width, height } : null;
}
export function validatePageImageDimensions(dimensions: PageImageDimensions | null): string | null {
  if (!dimensions) return 'This page has invalid displayed dimensions.';
  const pixels = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixels) || dimensions.width > MAX_PNG_EDGE || dimensions.height > MAX_PNG_EDGE) return `Image output is limited to ${MAX_PNG_EDGE.toLocaleString()} pixels on either edge.`;
  if (pixels > MAX_PNG_PIXELS) return 'Image output is limited to 32 megapixels.';
  if (pixels * 4 > MAX_PNG_DECODED_BYTES) return 'Image output exceeds the decoded-image limit.';
  return null;
}
export function validPageImageReceipt(value: unknown, request: PageImageExportRequest, dimensions: PageImageDimensions): value is PageImageExport {
  if (typeof value !== 'object' || value === null) return false;
  const receipt = value as Record<string, unknown>;
  return typeof receipt.path === 'string' && receipt.path.trim().length > 0 && receipt.documentId === request.id && receipt.revision === request.revision && receipt.page === request.page && receipt.dpi === request.dpi && receipt.width === dimensions.width && receipt.height === dimensions.height && receipt.format === (request.format ?? 'png');
}
export default function ExportPageImageDialog({ target, busy, exportPage, close }: { target: PageImageTarget; busy: boolean; exportPage: (request: PageImageExportRequest) => Promise<PageImageExport | null>; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), inFlight = useRef(false), alive = useRef(true);
  const [dpi, setDpi] = useState<(typeof PNG_DPI)[number]>(DEFAULT_PNG_DPI);
  const [format, setFormat] = useState<PageImageFormat>('png');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [result, setResult] = useState<PageImageExport | null>(null), [submitting, setSubmitting] = useState(false);
  useEffect(() => { dialog.current?.showModal(); return () => { alive.current = false; }; }, []);
  const dimensions = pageImageDimensions(target.size, dpi), limit = validatePageImageDimensions(dimensions), working = busy || submitting;
  const chooseDpi = (value: number) => { if (PNG_DPI.includes(value as typeof PNG_DPI[number])) { setDpi(value as (typeof PNG_DPI)[number]); setError(''); setNotice(''); } };
  const chooseFormat = (value: string) => { if (value === 'png' || value === 'jpeg') { setFormat(value); setError(''); setNotice(''); } };
  const submit = async () => {
    if (working || result || inFlight.current) return;
    if (limit || !dimensions) { setError(limit || 'This page cannot be exported.'); return; }
    const request: PageImageExportRequest = { id: target.id, revision: target.revision, page: target.page, dpi, format };
    inFlight.current = true; setSubmitting(true); setError(''); setNotice('');
    try { const receipt = await exportPage(request); if (!alive.current) return; if (receipt === null) setNotice(`Export canceled. No ${formatName(format)} file was created.`); else if (!validPageImageReceipt(receipt, request, dimensions)) setError(`The exported ${formatName(format)} did not match the page requested. Nothing was added to this workspace.`); else setResult(receipt); }
    catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; if (alive.current) setSubmitting(false); }
  };
  return <dialog ref={dialog} className={s.dialog} aria-labelledby="export-image-title" onCancel={event => { event.preventDefault(); if (!working) close(); }}>
    {result ? <><h2 id="export-image-title">Image export complete</h2><p>Saved page {target.page + 1} as a {result.width.toLocaleString()} × {result.height.toLocaleString()} pixel {formatName(result.format)} at {result.dpi} DPI.</p><p>{result.path}</p><div className={s.actions}><button autoFocus onClick={close}>Close</button></div></> : <><h2 id="export-image-title">Export page as image</h2><p>Export the current edited physical page {target.page + 1}. Page labels are shown elsewhere for reference; this export always uses the physical page.</p><label>Format <select aria-label="Image format" value={format} disabled={working} onChange={event => chooseFormat(event.target.value)}><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label><label>Resolution <select aria-label="Image resolution" value={dpi} disabled={working} onChange={event => chooseDpi(Number(event.target.value))}>{PNG_DPI.map(value => <option key={value} value={value} disabled={validatePageImageDimensions(pageImageDimensions(target.size, value)) !== null}>{value} DPI</option>)}</select></label><p className={s.preview}>{dimensions ? `${dimensions.width.toLocaleString()} × ${dimensions.height.toLocaleString()} pixels at ${dpi} DPI.` : 'Dimensions unavailable.'} {limit || 'The native export checks these bounds again before saving.'}</p><p className={s.preview}>{format === 'png' ? 'The PNG is a white-flattened 8-bit RGB image of the visible current page.' : 'JPEG is a lossy, white-flattened 8-bit RGB image at fixed quality 90; quality cannot be adjusted.'} Both formats include crop, rotation, supported annotations and form appearances. They have no editable text, OCR, vector content, or additional pages. Encrypted, restricted, signed, and certified PDFs cannot be exported.</p>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{working && <p role="status">Choosing a {formatName(format)} location and rendering the current page…</p>}<div className={s.actions}><button disabled={working} onClick={close}>Cancel</button><button className={s.confirm} disabled={working || !!limit || !dimensions} onClick={() => void submit()}>Export {formatName(format)}</button></div></>}
  </dialog>;
}
