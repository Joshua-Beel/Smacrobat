import { useEffect, useRef, useState } from 'react';
import { cancelPageOcr, recognizePageOcr, type OcrReceipt, type OcrRequest } from './bridge';
import s from './PageText.module.css';

export type PageOcrTarget = { id: number; revision: number; page: number; name: string };
type State =
  | { kind: 'running' }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelling' }
  | { kind: 'cancelled'; message: string };

const MAX_INPUT_BYTES = 16_777_216;
const MAX_OUTPUT_BYTES = 1_048_576;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function createPageOcrRequestId() {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id || !REQUEST_ID.test(id)) throw new Error('OCR request IDs are unavailable in this environment.');
  return id;
}

export function validPageOcrReceipt(receipt: OcrReceipt, request: OcrRequest) {
  if (!receipt || receipt.requestId !== request.requestId || receipt.documentId !== request.id || receipt.revision !== request.revision || receipt.page !== request.page || receipt.dpi !== 150 || receipt.language !== 'eng' || (receipt.status !== 'recognized' && receipt.status !== 'no_text') || typeof receipt.text !== 'string') return false;
  if (![receipt.documentId, receipt.revision, receipt.page, receipt.width, receipt.height].every(Number.isSafeInteger) || receipt.documentId < 0 || receipt.revision < 0 || receipt.page < 0 || receipt.width < 1 || receipt.height < 1 || receipt.width > 16_384 || receipt.height > 16_384) return false;
  const p6HeaderBytes = `P6\n${receipt.width} ${receipt.height}\n255\n`.length;
  return p6HeaderBytes + receipt.width * receipt.height * 3 <= MAX_INPUT_BYTES && new TextEncoder().encode(receipt.text).byteLength <= MAX_OUTPUT_BYTES && (receipt.status === 'no_text') === (receipt.text.trim().length === 0);
}

export default function PageOcrDialog({ target, setBusy, close }: { target: PageOcrTarget; setBusy: (busy: boolean) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);
  const active = useRef<string | null>(null);
  const pending = useRef<string | null>(null);
  const cancelled = useRef(false);
  const cancellationFailed = useRef(false);
  const cancelMessage = useRef('OCR canceled.');
  const [state, setState] = useState<State>({ kind: 'running' });
  const [pendingOcr, setPendingOcr] = useState(false);

  const begin = () => {
    if (pending.current) return;
    let requestId: string;
    try { requestId = createPageOcrRequestId(); }
    catch (reason) { setState({ kind: 'error', message: String(reason) }); return; }
    const request: OcrRequest = { requestId, id: target.id, revision: target.revision, page: target.page };
    active.current = requestId; pending.current = requestId; cancelled.current = false; cancellationFailed.current = false; cancelMessage.current = 'OCR canceled.';
    setPendingOcr(true);
    setBusy(true);
    setState({ kind: 'running' });
    void recognizePageOcr(request).then(receipt => {
      if (!mounted.current || active.current !== requestId) return;
      if (!validPageOcrReceipt(receipt, request)) { active.current = null; setState({ kind: 'error', message: 'OCR returned text for a different page or document. Try again.' }); return; }
      active.current = null;
      setState(receipt.status === 'no_text' || !receipt.text.trim() ? { kind: 'empty' } : { kind: 'text', text: receipt.text });
    }).catch(reason => {
      if (!mounted.current || active.current !== requestId) return;
      active.current = null;
      setState({ kind: 'error', message: `OCR could not read this page: ${String(reason)}` });
    }).finally(() => {
      if (pending.current !== requestId) return;
      pending.current = null;
      setPendingOcr(false);
      setBusy(false);
      if (mounted.current && cancelled.current && !cancellationFailed.current) setState({ kind: 'cancelled', message: cancelMessage.current });
    });
  };

  useEffect(() => {
    dialog.current?.showModal();
    begin();
    return () => {
      mounted.current = false;
      const requestId = pending.current;
      active.current = null;
      if (requestId) void cancelPageOcr(requestId);
      if (!requestId) setBusy(false);
    };
  }, []);

  async function cancel() {
    const requestId = active.current;
    if (!requestId) { close(); return; }
    active.current = null;
    cancelled.current = true;
    setState({ kind: 'cancelling' });
    try {
      const receipt = await cancelPageOcr(requestId);
      if (!mounted.current) return;
      if (receipt.requestId !== requestId || !['cancelled', 'already_cancelled', 'finished'].includes(receipt.status)) throw new Error('OCR cancellation returned an unexpected response.');
      cancelMessage.current = receipt.status === 'finished' ? 'OCR had already finished. Its text was discarded.' : 'OCR canceled.';
      if (pending.current === null) setState({ kind: 'cancelled', message: cancelMessage.current });
    } catch (reason) {
      cancellationFailed.current = true;
      if (mounted.current) setState({ kind: 'error', message: `Could not cancel OCR: ${String(reason)} The operation may still be running, but any late text will be discarded.` });
    }
  }

  const running = state.kind === 'running' || state.kind === 'cancelling';
  return <dialog ref={dialog} className={s.dialog} aria-labelledby="page-ocr-title" onCancel={event => { event.preventDefault(); void cancel(); }}>
    <h2 id="page-ocr-title">Recognize text on page {target.page + 1}</h2>
    <p>{target.name} · physical page {target.page + 1}. OCR reads this one page in English. Recognition may contain errors.</p>
    <p>It does not change the PDF, add searchable text, index the document, or send content to a service.</p>
    {state.kind === 'running' && <p role="status" aria-live="polite">Recognizing text…</p>}
    {state.kind === 'cancelling' && <p role="status" aria-live="polite">Canceling OCR…</p>}
    {state.kind === 'empty' && <p role="status">No text was recognized on this page.</p>}
    {state.kind === 'cancelled' && <p role="status">{state.message}</p>}
    {state.kind === 'error' && <p role="alert">{state.message}</p>}
    {state.kind === 'text' && <textarea ref={textArea} aria-label={`Recognized text on page ${target.page + 1}`} readOnly value={state.text} spellCheck={false} />}
    <div className={s.actions}>
      {state.kind === 'text' && <button onClick={() => { textArea.current?.focus(); textArea.current?.select(); }}>Select all text</button>}
      {state.kind === 'error' && <button onClick={begin}>Try again</button>}
      <button disabled={state.kind === 'cancelling' || pendingOcr && state.kind !== 'running'} onClick={() => void cancel()}>{running ? 'Cancel OCR' : pendingOcr ? 'Canceling OCR…' : 'Close'}</button>
    </div>
  </dialog>;
}
