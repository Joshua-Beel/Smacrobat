import { useEffect, useRef, useState } from 'react';
import { DEFAULT_CREATE_PDF_OPTIONS, validateCreatePdfOptions } from './CreatePdfDialog';
import type { CreatePdfOptions } from './bridge';
import { MAX_MULTI_IMAGE_SOURCES, moveImagePdfSource, validateImagePdfSources, type CancelImagePdfSources, type ChooseImagePdfSources, type CreatePdfFromImages, type ImagePdfSelection } from './multiImagePdf';
import dialogStyles from './CombineDialog.module.css';
import s from './MultiImagePdfDialog.module.css';

export default function MultiImagePdfDialog({ busy, choose, create, cancel, close }: { busy: boolean; choose: ChooseImagePdfSources; create: CreatePdfFromImages; cancel: CancelImagePdfSources; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const selectionRef = useRef<ImagePdfSelection | null>(null);
  const [selection, setSelection] = useState<ImagePdfSelection | null>(null);
  const [pageSize, setPageSize] = useState<CreatePdfOptions['pageSize']>(DEFAULT_CREATE_PDF_OPTIONS.pageSize);
  const [orientation, setOrientation] = useState<CreatePdfOptions['orientation']>(DEFAULT_CREATE_PDF_OPTIONS.orientation);
  const [margin, setMargin] = useState(String(DEFAULT_CREATE_PDF_OPTIONS.marginPoints));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const retain = (value: ImagePdfSelection | null) => { selectionRef.current=value; setSelection(value); };
  useEffect(() => { dialog.current?.showModal(); return () => { const current=selectionRef.current;selectionRef.current=null;if(current)void cancel(current.selectionId); }; }, [cancel]);
  const sources=selection?.sources??[];
  const updateSources=(next:ImagePdfSelection['sources'])=>{if(selection)retain({...selection,sources:next});};
  const working = busy || submitting;
  const changed = (callback: () => void) => { callback(); setError(''); setNotice(''); };
  const select = async () => {
    if (working || inFlight.current) return;
    inFlight.current = true; setSubmitting(true); setError(''); setNotice('');
    try {
      const selected = await choose(selection?.selectionId);
      if (selected) {
        const validation = validateImagePdfSources(selected.sources);
        if (!selected.selectionId.trim()) setError('Native image selection did not provide an opaque selection ID.');
        else if (validation) setError(validation); else retain(selected);
      } else setNotice('Image selection canceled. The current list is unchanged.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setSubmitting(false); }
  };
  const submit = async () => {
    if (working || inFlight.current) return;
    const sourceError = validateImagePdfSources(sources);
    if (sourceError) { setError(sourceError); return; }
    if (!margin.trim()) { setError('Margin must be between 0 and 72 points.'); return; }
    const options: CreatePdfOptions = { pageSize, orientation, marginPoints: Number(margin) };
    const optionError = validateCreatePdfOptions(options);
    if (optionError) { setError(optionError); return; }
    inFlight.current = true; setSubmitting(true); setError(''); setNotice('');
    try {
      if (!selection) { setError('Choose images before creating the PDF.'); return; }
      const result = await create({ selectionId:selection.selectionId,sourceIds:sources.map(source=>source.sourceId), options });
      if (result) { retain(null); close(); } else setNotice('Creation canceled. The image list and workspace are unchanged.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; setSubmitting(false); }
  };
  const releaseAndClose=async()=>{if(working||inFlight.current)return;const current=selectionRef.current;retain(null);setSubmitting(true);try{if(current)await cancel(current.selectionId);close();}catch(reason){retain(current);setError(reason instanceof Error?reason.message:String(reason));}finally{setSubmitting(false);}};
  return <dialog ref={dialog} className={dialogStyles.dialog} aria-labelledby="multi-image-pdf-title" onCancel={event => { event.preventDefault(); if (!working) void releaseAndClose(); }}>
    <h2 id="multi-image-pdf-title">Create a PDF from images</h2>
    <p>Choose 1–{MAX_MULTI_IMAGE_SOURCES} PNG or JPEG images. Each image becomes one page in the order shown.</p>
    <button className={s.choose} disabled={working} onClick={() => void select()}>{sources.length ? 'Choose different images' : 'Choose images'}</button>
    <ol className={s.list}>{sources.length ? sources.map((source, index) => <li className={s.item} key={source.sourceId}>
      <span className={s.name} title={source.name}>{index + 1}. {source.name}</span>
      <button aria-label={`Move image ${index + 1}, ${source.name}, up`} disabled={working || index === 0} onClick={() => changed(() => updateSources(moveImagePdfSource(sources, index, -1)))}>↑</button>
      <button aria-label={`Move image ${index + 1}, ${source.name}, down`} disabled={working || index === sources.length - 1} onClick={() => changed(() => updateSources(moveImagePdfSource(sources, index, 1)))}>↓</button>
      <button aria-label={`Remove image ${index + 1}, ${source.name}`} disabled={working} onClick={() => changed(() => updateSources(sources.filter((_, item) => item !== index)))}>Remove</button>
    </li>) : <li className={s.empty}>No images selected.</li>}</ol>
    <label>Page size <select aria-label="Page size" value={pageSize} disabled={working} onChange={event => changed(() => setPageSize(event.target.value as CreatePdfOptions['pageSize']))}><option value="letter">Letter</option><option value="a4">A4</option></select></label>
    <label>Orientation <select aria-label="Orientation" value={orientation} disabled={working} onChange={event => changed(() => setOrientation(event.target.value as CreatePdfOptions['orientation']))}><option value="auto">Auto (match each image)</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
    <label>Margin <span><input aria-label="Margin in points" type="number" min="0" max="72" step="0.01" value={margin} disabled={working} onChange={event => changed(() => setMargin(event.target.value))} /> pt</span></label>
    <p className={dialogStyles.preview}>Every image is contained and centered with upscaling allowed; images are never cropped. Output colors are 8-bit RGB, transparency is composited on white, and ICC color profiles and image metadata are not retained. All pages use the same options.</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{working && <p role="status">Waiting for the native file picker…</p>}
    <div className={dialogStyles.actions}><button disabled={working} onClick={() => void releaseAndClose()}>Cancel</button><button className={dialogStyles.confirm} disabled={working || sources.length === 0} onClick={() => void submit()}>Create PDF</button></div>
  </dialog>;
}
