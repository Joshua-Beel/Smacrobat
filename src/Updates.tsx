import { useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { native } from './bridge';
import s from './Updates.module.css';

export default function Updates({ dirty, busy, setBusy, close }: { dirty: boolean; busy: boolean; setBusy: (value: boolean) => void; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef<Update | null>(null);
  const [version, setVersion] = useState('');
  const [available, setAvailable] = useState<Update | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState('Checking GitHub releases…');
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
    let disposed = false;
    void (async () => {
      try {
        if (!native) throw new Error('Updates are available in the installed Windows app.');
        const current = await getVersion();
        if (!disposed) setVersion(current);
        const update = await check({ timeout: 20000 });
        if (disposed) { await update?.close(); return; }
        pending.current = update; setAvailable(update);
        setStatus(update ? `Version ${update.version} is available.` : 'You have the latest released version.');
      } catch (e) { if (!disposed) { setError(`Could not check for updates: ${String(e)}`); setStatus('Close and try again when you are online.'); } }
      finally { if (!disposed) setChecking(false); }
    })();
    return () => { disposed = true; const release = pending.current?.close(); if (release) void release.catch(() => {}); };
  }, []);
  const install = async () => {
    if (!available || dirty || busy || installing) return;
    setInstalling(true); setBusy(true); setError(''); setStatus('Downloading signed update…');
    let downloaded = 0, total = 0;
    try {
      await available.downloadAndInstall(event => {
        if (event.event === 'Started') total = event.data.contentLength || 0;
        if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          setStatus(total ? `Downloading update: ${Math.min(100, Math.round(downloaded / total * 100))}%` : `Downloaded ${(downloaded / 1048576).toFixed(1)} MB`);
        }
        if (event.event === 'Finished') setStatus('Verifying update and starting installer…');
      }, { timeout: 120000 });
    } catch (e) { setError(`Update failed: ${String(e)}`); setStatus('Your installed version is unchanged. You can retry.'); }
    finally { setInstalling(false); setBusy(false); }
  };
  return <dialog ref={dialog} className={s.dialog} aria-labelledby="updates-title" onCancel={e => { e.preventDefault(); if (!installing) close(); }}>
    <h2 id="updates-title">Software updates</h2>
    {version && <p>Installed version: {version}</p>}
    <p role="status" aria-live="polite">{status}</p>
    {error && <p role="alert" className={s.error}>{error}</p>}
    {available?.body && <pre className={s.notes}>{available.body}</pre>}
    {available && <p>The app will close and reopen during installation. {dirty ? 'Save a copy of every edited document or discard those edits before updating.' : 'Save your work before continuing.'}</p>}
    <div className={s.actions}><button autoFocus disabled={installing} onClick={close}>Close</button>{available && <button disabled={checking || installing || dirty || busy} onClick={() => void install()}>Install update and restart</button>}</div>
  </dialog>;
}
