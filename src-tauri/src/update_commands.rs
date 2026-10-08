use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::{ipc::Channel, AppHandle, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

/// The only update facts the webview may send back: which offer it is acting on.
/// Endpoint, public key, proxy, headers, target and version policy come from the
/// backend and `tauri.conf.json`; unknown fields are rejected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct UpdateKey {
    pub version: String,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    pub current_version: String,
    pub version: String,
    pub body: Option<String>,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

enum Stage<U, B> {
    Empty,
    Checked(UpdateKey, U),
    Downloading(UpdateKey),
    Downloaded(UpdateKey, U, B),
}

/// Holds the single update the backend itself fetched in the latest check.
/// Download and install act only on that update, matched by version and
/// signature; install consumes it.
pub struct UpdateSlot<U, B> {
    stage: Stage<U, B>,
}

impl<U, B> Default for UpdateSlot<U, B> {
    fn default() -> Self {
        Self { stage: Stage::Empty }
    }
}

impl<U, B> UpdateSlot<U, B> {
    pub fn offer(&mut self, key: UpdateKey, update: U) -> Result<(), String> {
        if matches!(self.stage, Stage::Downloading(_)) {
            return Err("An update download is already in progress.".into());
        }
        self.stage = Stage::Checked(key, update);
        Ok(())
    }

    pub fn clear_unless_downloading(&mut self) -> Result<(), String> {
        if matches!(self.stage, Stage::Downloading(_)) {
            return Err("An update download is already in progress.".into());
        }
        self.stage = Stage::Empty;
        Ok(())
    }

    pub fn release(&mut self) {
        self.stage = Stage::Empty;
    }

    pub fn begin_download(&mut self, key: &UpdateKey) -> Result<U, String> {
        match std::mem::replace(&mut self.stage, Stage::Empty) {
            Stage::Checked(held, update) if held == *key => {
                self.stage = Stage::Downloading(held);
                Ok(update)
            }
            Stage::Checked(held, update) => {
                self.stage = Stage::Checked(held, update);
                Err("This update no longer matches the latest check. Check for updates again.".into())
            }
            Stage::Downloaded(held, update, bytes) if held == *key => {
                self.stage = Stage::Downloading(held);
                drop(bytes);
                Ok(update)
            }
            other => {
                let message = if matches!(other, Stage::Downloading(_)) { "An update download is already in progress." } else { "No checked update is available. Check for updates again." };
                self.stage = other;
                Err(message.into())
            }
        }
    }

    /// Returns false when the slot was released or replaced during the download.
    pub fn finish_download(&mut self, key: &UpdateKey, update: U, bytes: Result<B, ()>) -> bool {
        match &self.stage {
            Stage::Downloading(held) if held == key => {
                let held = held.clone();
                self.stage = match bytes {
                    Ok(bytes) => Stage::Downloaded(held, update, bytes),
                    Err(()) => Stage::Checked(held, update),
                };
                true
            }
            _ => false,
        }
    }

    pub fn take_for_install(&mut self, key: &UpdateKey) -> Result<(U, B), String> {
        match std::mem::replace(&mut self.stage, Stage::Empty) {
            Stage::Downloaded(held, update, bytes) if held == *key => Ok((update, bytes)),
            other => {
                let message = match &other {
                    Stage::Downloading(_) => "The update download has not finished.",
                    Stage::Downloaded(..) | Stage::Checked(..) => "This update was not downloaded by the latest check. Check for updates again.",
                    Stage::Empty => "No downloaded update is available. Check for updates again.",
                };
                self.stage = other;
                Err(message.into())
            }
        }
    }
}

pub fn is_upgrade(current: &semver::Version, offered: &str) -> bool {
    semver::Version::parse(offered).map(|offered| offered > *current).unwrap_or(false)
}

pub type PendingUpdate = Mutex<UpdateSlot<Update, Vec<u8>>>;

fn lock<'a>(state: &'a State<'_, PendingUpdate>) -> Result<std::sync::MutexGuard<'a, UpdateSlot<Update, Vec<u8>>>, String> {
    state.lock().map_err(|_| "The updater state is unavailable. Restart PDF Workstation and try again.".to_string())
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(app: AppHandle<R>, state: State<'_, PendingUpdate>) -> Result<Option<UpdateOffer>, String> {
    lock(&state)?.clear_unless_downloading()?;
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .version_comparator(|current, release| release.version > current)
        .build()
        .map_err(|error| error.to_string())?;
    let Some(update) = updater.check().await.map_err(|error| error.to_string())? else { return Ok(None) };
    if !is_upgrade(&app.package_info().version, &update.version) {
        return Ok(None);
    }
    let offer = UpdateOffer { current_version: update.current_version.clone(), version: update.version.clone(), body: update.body.clone(), signature: update.signature.clone() };
    lock(&state)?.offer(UpdateKey { version: offer.version.clone(), signature: offer.signature.clone() }, update)?;
    Ok(Some(offer))
}

#[tauri::command]
pub async fn download_update(state: State<'_, PendingUpdate>, update: UpdateKey, on_event: Channel<DownloadEvent>) -> Result<(), String> {
    let mut pending = lock(&state)?.begin_download(&update)?;
    pending.timeout = Some(DOWNLOAD_TIMEOUT);
    let mut first_chunk = true;
    let result = pending
        .download(
            |chunk_length, content_length| {
                if first_chunk {
                    first_chunk = false;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await;
    let (bytes, outcome) = match result {
        Ok(bytes) => (Ok(bytes), Ok(())),
        Err(error) => (Err(()), Err(error.to_string())),
    };
    if !lock(&state)?.finish_download(&update, pending, bytes) {
        return Err("The update was released before its download finished. Check for updates again.".into());
    }
    outcome
}

#[tauri::command]
pub async fn install_update<R: Runtime>(app: AppHandle<R>, state: State<'_, PendingUpdate>, update: UpdateKey) -> Result<(), String> {
    let (pending, bytes) = lock(&state)?.take_for_install(&update)?;
    if !is_upgrade(&app.package_info().version, &pending.version) {
        return Err("The offered update is not newer than the installed version.".into());
    }
    pending.restart_after_install(true).install(&bytes).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn release_update(state: State<'_, PendingUpdate>) -> Result<(), String> {
    lock(&state)?.release();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(version: &str, signature: &str) -> UpdateKey {
        UpdateKey { version: version.into(), signature: signature.into() }
    }

    fn downloaded(k: &UpdateKey) -> UpdateSlot<&'static str, Vec<u8>> {
        let mut slot = UpdateSlot::default();
        slot.offer(k.clone(), "update").unwrap();
        let update = slot.begin_download(k).unwrap();
        assert!(slot.finish_download(k, update, Ok(vec![1, 2, 3])));
        slot
    }

    #[test]
    fn webview_key_rejects_endpoint_proxy_header_target_and_downgrade_fields() {
        assert_eq!(serde_json::from_value::<UpdateKey>(serde_json::json!({ "version": "0.3.0", "signature": "sig" })).unwrap(), key("0.3.0", "sig"));
        for extra in ["proxy", "headers", "target", "allowDowngrades", "endpoints", "pubkey", "timeout", "restartAfterInstall", "rid"] {
            let mut value = serde_json::json!({ "version": "0.3.0", "signature": "sig" });
            value[extra] = serde_json::json!("http://attacker.invalid");
            assert!(serde_json::from_value::<UpdateKey>(value).is_err(), "{extra} must be rejected");
        }
    }

    #[test]
    fn install_rejects_without_a_prior_check_or_download() {
        let k = key("0.3.0", "sig");
        let mut slot: UpdateSlot<&str, Vec<u8>> = UpdateSlot::default();
        assert!(slot.take_for_install(&k).is_err());
        assert!(slot.begin_download(&k).is_err());
        slot.offer(k.clone(), "update").unwrap();
        assert!(slot.take_for_install(&k).is_err(), "a checked but undownloaded update must not install");
    }

    #[test]
    fn install_takes_the_checked_update_once() {
        let k = key("0.3.0", "sig");
        let mut slot = downloaded(&k);
        let (update, bytes) = slot.take_for_install(&k).unwrap();
        assert_eq!((update, bytes), ("update", vec![1, 2, 3]));
        assert!(slot.take_for_install(&k).is_err(), "a consumed update must not install twice");
        assert!(slot.begin_download(&k).is_err());
    }

    #[test]
    fn mismatched_version_or_signature_is_rejected_and_keeps_the_real_offer() {
        let k = key("0.3.0", "sig");
        let mut slot = downloaded(&k);
        assert!(slot.take_for_install(&key("0.3.0", "other")).is_err());
        assert!(slot.take_for_install(&key("0.4.0", "sig")).is_err());
        assert!(slot.take_for_install(&k).is_ok());
        let mut checked: UpdateSlot<&str, Vec<u8>> = UpdateSlot::default();
        checked.offer(k.clone(), "update").unwrap();
        assert!(checked.begin_download(&key("0.3.0", "forged")).is_err());
        assert!(checked.begin_download(&k).is_ok());
    }

    #[test]
    fn a_new_check_replaces_the_previous_offer() {
        let old = key("0.3.0", "old");
        let new = key("0.3.1", "new");
        let mut slot = downloaded(&old);
        slot.clear_unless_downloading().unwrap();
        slot.offer(new.clone(), "newer").unwrap();
        assert!(slot.begin_download(&old).is_err());
        assert_eq!(slot.begin_download(&new).unwrap(), "newer");
    }

    #[test]
    fn failed_download_keeps_the_offer_for_retry_and_concurrent_download_is_refused() {
        let k = key("0.3.0", "sig");
        let mut slot: UpdateSlot<&str, Vec<u8>> = UpdateSlot::default();
        slot.offer(k.clone(), "update").unwrap();
        let update = slot.begin_download(&k).unwrap();
        assert!(slot.begin_download(&k).is_err());
        assert!(slot.offer(key("0.3.1", "x"), "other").is_err());
        assert!(slot.take_for_install(&k).is_err());
        assert!(slot.finish_download(&k, update, Err(())));
        assert!(slot.take_for_install(&k).is_err());
        let update = slot.begin_download(&k).unwrap();
        assert!(slot.finish_download(&k, update, Ok(vec![9])));
        assert_eq!(slot.take_for_install(&k).unwrap().1, vec![9]);
    }

    #[test]
    fn release_during_download_discards_the_result() {
        let k = key("0.3.0", "sig");
        let mut slot: UpdateSlot<&str, Vec<u8>> = UpdateSlot::default();
        slot.offer(k.clone(), "update").unwrap();
        let update = slot.begin_download(&k).unwrap();
        slot.release();
        assert!(!slot.finish_download(&k, update, Ok(vec![1])));
        assert!(slot.take_for_install(&k).is_err());
    }

    #[test]
    fn only_strictly_newer_versions_are_upgrades() {
        let current = semver::Version::parse("0.2.12").unwrap();
        assert!(is_upgrade(&current, "0.2.13"));
        assert!(is_upgrade(&current, "0.3.0"));
        assert!(!is_upgrade(&current, "0.2.12"));
        assert!(!is_upgrade(&current, "0.2.11"));
        assert!(!is_upgrade(&current, "0.2.0"));
        assert!(!is_upgrade(&current, "not-a-version"));
        assert!(!is_upgrade(&current, ""));
    }
}
