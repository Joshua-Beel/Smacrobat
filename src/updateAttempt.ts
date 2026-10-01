import { invoke } from '@tauri-apps/api/core';

export type UpdateAttempt = {
  schemaVersion: 1;
  fromVersion: string;
  targetVersion: string;
  phase: 'downloading' | 'installing';
};

export const readUpdateAttempt = () => invoke<UpdateAttempt | null>('read_update_attempt');
export const writeUpdateAttempt = (attempt: UpdateAttempt) => invoke<void>('write_update_attempt', { attempt });
export const clearUpdateAttempt = () => invoke<void>('clear_update_attempt');
