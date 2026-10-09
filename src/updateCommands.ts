import { Channel, invoke } from '@tauri-apps/api/core';

export type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number | null } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export type InstallOutcome = 'cancelled' | 'started';

type UpdateOffer = { currentVersion: string; version: string; body: string | null; signature: string; check: number };

export type Update = {
  version: string;
  body: string | null;
  download: (onEvent: (event: DownloadEvent) => void) => Promise<void>;
  install: () => Promise<InstallOutcome>;
  close: () => Promise<void>;
};

export async function checkForUpdate(): Promise<Update | null> {
  const offer = await invoke<UpdateOffer | null>('check_for_update');
  if (!offer) return null;
  const update = { version: offer.version, signature: offer.signature, check: offer.check };
  return {
    version: offer.version,
    body: offer.body,
    download: onEvent => {
      const channel = new Channel<DownloadEvent>();
      channel.onmessage = onEvent;
      return invoke<void>('download_update', { update, onEvent: channel });
    },
    install: () => invoke<InstallOutcome>('install_update', { update }),
    close: () => invoke<void>('release_update', { update })
  };
}
