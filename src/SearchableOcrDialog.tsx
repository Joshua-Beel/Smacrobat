import { useEffect, useRef, useState } from 'react';
import type { SavedCopy } from './bridge';
import { validateSearchableOcrCapability, validateSearchableOcrRequest, type CancelSearchableOcr, type CreateSearchableOcrCopy, type SearchableOcrCapability, type SearchableOcrRequest } from './searchableOcr';
import s from './CombineDialog.module.css';

export default function SearchableOcrDialog({ capability, request, create, cancel, close, opened }: { capability: SearchableOcrCapability; request: SearchableOcrRequest; create: CreateSearchableOcrCopy; cancel: CancelSearchableOcr; close: () => void; opened: (copy: SavedCopy) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const active = useRef(false);
  const cancelSent = useRef(false);
  const [working,setWorking]=useState(false),[cancelling,setCancelling]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  useEffect(()=>{dialog.current?.showModal();},[]);
  const capabilityError=validateSearchableOcrCapability(capability),requestError=validateSearchableOcrRequest(request),blocked=capabilityError||requestError;
  const submit=async()=>{if(active.current||blocked)return;active.current=true;cancelSent.current=false;setWorking(true);setError('');setNotice('');try{const result=await create(request);if(result){opened(result);close();}else setNotice('Save canceled. The source document and this dialog are unchanged.');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{active.current=false;cancelSent.current=false;setWorking(false);setCancelling(false);}};
  const stop=async()=>{if(!active.current||cancelSent.current)return;cancelSent.current=true;setCancelling(true);setError('');try{const ack=await cancel(request.requestId);if(ack.requestId!==request.requestId)throw new Error('OCR cancellation returned the wrong request ID.');setNotice(ack.status==='cancelled'?'Cancellation requested. Waiting for OCR to stop.':ack.status==='already_cancelled'?'Cancellation was already requested.':'OCR has already finished.');}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}};
  return <dialog ref={dialog} className={s.dialog} aria-labelledby="searchable-ocr-title" onCancel={event=>{event.preventDefault();if(!working)close();}}>
    <h2 id="searchable-ocr-title">Create searchable OCR copy</h2>
    <p>Creates a new copy from every current page at fixed 150 DPI using the verified local English OCR engine. The source document and its history stay unchanged.</p>
    <p className={s.preview}>Every page becomes a white-flattened raster with invisible searchable text limited to printable ASCII words. Editable text, vectors, forms, annotations, metadata, bookmarks, and attachments are not preserved as editable PDF structures.</p>
    <p className={s.preview}>Limited to 32 pages, 33,554,432 pixels across the document, 100,000 words, and 8 MiB of reconstructed text. Unsupported Unicode or layout, protected or signed files, malformed input, stale revisions, timeouts, and existing output paths are refused without publishing a file.</p>
    {blocked&&<p role="alert">{blocked}</p>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{working&&<p role="status">{cancelling?'Stopping OCR…':'Choosing an output location or processing OCR…'}</p>}
    <div className={s.actions}><button disabled={working} onClick={close}>Close</button>{working?<button className={s.confirm} disabled={cancelling} onClick={()=>void stop()}>Cancel OCR</button>:<button className={s.confirm} disabled={!!blocked} onClick={()=>void submit()}>Create searchable copy</button>}</div>
  </dialog>;
}
