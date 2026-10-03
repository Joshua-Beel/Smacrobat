import { useEffect, useRef } from 'react';
import s from './ConfirmDialog.module.css';

export default function RecoveryOfferDialog({ name, revision, busy, error, keep, original }: { name: string; revision: number; busy: boolean; error: string; keep: () => void; original: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={s.dialog} aria-labelledby="recovery-offer-title" onCancel={event => event.preventDefault()}>
    <h2 id="recovery-offer-title">Recovered edits are available</h2>
    <p>A recovery record for {name} contains unsaved revision {revision}. Choose which version to open. Your source PDF will not be changed.</p>
    {error && <p role="alert">{error}</p>}
    <div><button disabled={busy} onClick={original}>Open original</button><button autoFocus className={s.confirm} disabled={busy} onClick={keep}>Keep recovered edits</button></div>
  </dialog>;
}
