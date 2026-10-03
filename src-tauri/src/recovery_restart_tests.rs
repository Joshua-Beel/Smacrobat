use super::*;
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const ROOT_ENV: &str = "SMACROBAT_RECOVERY_RESTART_ROOT";
const NONCE_ENV: &str = "SMACROBAT_RECOVERY_RESTART_NONCE";
const MAX_FIXTURE_BYTES: u64 = 32 * 1024 * 1024;

fn direct<T>(service: &PdfService, request: impl FnOnce(Reply<T>) -> Request) -> Result<T, String> {
    let (reply, receiver) = oneshot::channel();
    service.sender.send(request(reply)).map_err(|error| error.to_string())?;
    receiver.blocking_recv().map_err(|error| error.to_string())?
}

fn begin_open(service: &PdfService, path: PathBuf) -> Result<OpenResult, String> {
    direct(service, |reply| Request::BeginOpen(path, reply)).map(ReplyLease::accept)
}

fn bounded_read(path: &Path) -> Vec<u8> {
    let metadata = std::fs::metadata(path).expect("restart fixture metadata");
    assert!(metadata.is_file() && metadata.len() <= MAX_FIXTURE_BYTES, "restart fixture exceeded its read bound");
    std::fs::read(path).expect("restart fixture read")
}

fn fixture_root() -> PathBuf {
    let root = PathBuf::from(std::env::var_os(ROOT_ENV).expect("restart fixture root must be supplied by the parent test"));
    assert!(root.is_absolute(), "restart fixture root must be absolute");
    let root = std::fs::canonicalize(root).expect("canonical restart fixture root");
    let temp = std::fs::canonicalize(std::env::temp_dir()).expect("canonical temporary directory");
    assert_eq!(root.parent(), Some(temp.as_path()), "restart fixture root must be a direct temporary-directory child");
    let nonce = std::env::var(NONCE_ENV).expect("restart fixture nonce must be supplied by the parent test");
    assert_eq!(bounded_read(&root.join(".owned")), nonce.as_bytes(), "restart fixture ownership marker mismatch");
    root
}

fn fixture_paths() -> (PathBuf, PathBuf, PathBuf) {
    let root = fixture_root();
    (root.join("source.pdf"), root.join("recovery"), root.join("render.sha256"))
}

fn worker(recovery: PathBuf) -> PdfService {
    PdfService::start_worker(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pdfium/bin/pdfium.dll"),
        4096,
        Some(recovery),
    )
}

fn source_identity(source: &[u8]) -> crate::recovery_journal::SourceIdentity {
    recovery_source_identity(source).expect("source identity")
}

#[test]
#[ignore = "spawned by restart_recovery_survives_fresh_workers"]
fn restart_child_a_persists_without_close() {
    let (source_path, recovery, render_receipt) = fixture_paths();
    let source = bounded_read(&source_path);
    let expected_source = bounded_read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/welcome.pdf"));
    assert_eq!(Sha256::digest(&source), Sha256::digest(&expected_source));

    let service = worker(recovery.clone());
    let opened = match begin_open(&service, source_path.clone()).expect("open source") {
        OpenResult::Opened { document, recovery: None } => document,
        _ => panic!("fresh source unexpectedly offered recovery"),
    };
    let edited = direct(&service, |reply| Request::DurableEdit(
        opened.id,
        PageEdit::Rotate { pages: vec![0], clockwise: true },
        1,
        reply,
    )).expect("durable edit");
    assert!(edited.dirty && edited.revision == 1);
    let pixels = direct(&service, |reply| Request::Render(edited.id, 0, 240, reply)).expect("render edited page");
    let mut receipt = OpenOptions::new().write(true).create_new(true).open(&render_receipt).expect("create owned render receipt");
    receipt.write_all(&Sha256::digest(&pixels)).expect("write bounded render receipt");
    receipt.sync_all().expect("synchronize bounded render receipt");

    let record = crate::recovery_store::read_recovery(&recovery, source_identity(&source), None, 0)
        .expect("read active recovery").expect("active recovery record");
    assert!(record.active);
    assert_eq!((record.generation, record.revision, record.current_page), (1, edited.revision, 1));
    assert_eq!(Sha256::digest(bounded_read(&source_path)), Sha256::digest(source));
    // Intentionally exit without Close: the next phase must rely only on the published record.
}

#[test]
#[ignore = "spawned by restart_recovery_survives_fresh_workers"]
fn restart_child_b_keeps_and_undoes() {
    let (source_path, recovery, render_receipt) = fixture_paths();
    let source = bounded_read(&source_path);
    let expected_source = bounded_read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/welcome.pdf"));
    assert_eq!(Sha256::digest(&source), Sha256::digest(&expected_source));
    let expected_render = bounded_read(&render_receipt);
    assert_eq!(expected_render.len(), 32);

    let service = worker(recovery.clone());
    let (clean, offer) = match begin_open(&service, source_path.clone()).expect("reopen source") {
        OpenResult::Opened { document, recovery: Some(offer) } => (document, offer),
        _ => panic!("fresh worker did not offer active recovery"),
    };
    assert_eq!((clean.revision, clean.dirty, offer.revision, offer.current_page), (0, false, 1, 1));
    let kept = direct(&service, |reply| Request::KeepRecoveredEdits(clean.id, clean.revision, reply)).expect("keep recovery");
    assert_eq!((kept.document.revision, kept.current_page), (offer.revision, offer.current_page));
    assert!(kept.document.dirty && kept.document.can_undo);
    let pixels = direct(&service, |reply| Request::Render(kept.document.id, 0, 240, reply)).expect("render kept page");
    assert_eq!(Sha256::digest(&pixels).as_slice(), expected_render.as_slice());

    let undone = direct(&service, |reply| Request::DurableEdit(
        kept.document.id,
        PageEdit::Undo,
        kept.current_page,
        reply,
    )).expect("durable undo");
    assert!(!undone.dirty && undone.can_redo);
    let record = crate::recovery_store::read_recovery(&recovery, source_identity(&source), None, 0)
        .expect("read tombstone").expect("inactive recovery record");
    assert!(!record.active);
    assert_eq!((record.generation, record.revision, record.current_page), (2, undone.revision, 0));
    assert_eq!(Sha256::digest(bounded_read(&source_path)), Sha256::digest(source));
}

#[test]
#[ignore = "spawned by restart_recovery_survives_fresh_workers"]
fn restart_child_c_observes_tombstone() {
    let (source_path, recovery, _) = fixture_paths();
    let source = bounded_read(&source_path);
    let expected_source = bounded_read(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/welcome.pdf"));
    assert_eq!(Sha256::digest(&source), Sha256::digest(&expected_source));
    let record = crate::recovery_store::read_recovery(&recovery, source_identity(&source), None, 0)
        .expect("read final tombstone").expect("final recovery record");
    assert!(!record.active);
    assert_eq!((record.generation, record.revision, record.current_page), (2, 2, 0));

    let service = worker(recovery);
    match begin_open(&service, source_path.clone()).expect("open after tombstone") {
        OpenResult::Opened { document, recovery: None } => assert_eq!((document.revision, document.dirty), (0, false)),
        _ => panic!("inactive higher-generation recovery was offered"),
    }
    assert_eq!(Sha256::digest(bounded_read(&source_path)), Sha256::digest(source));
}

fn run_child(name: &str, root: &Path, nonce: &str) {
    let mut command = Command::new(std::env::current_exe().expect("current test executable"));
    command.args(["--exact", name, "--ignored", "--test-threads=1"])
        .env_clear()
        .env(ROOT_ENV, root)
        .env(NONCE_ENV, nonce)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for name in ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"] {
        if let Some(value) = std::env::var_os(name) { command.env(name, value); }
    }
    let mut child = command.spawn().expect("spawn owned restart child");
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if let Some(status) = child.try_wait().expect("poll owned restart child") {
            assert!(status.success(), "restart child {name} failed");
            return;
        }
        if Instant::now() >= deadline {
            child.kill().expect("terminate timed-out owned restart child");
            let _ = child.wait();
            panic!("restart child {name} exceeded its deadline");
        }
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
#[ignore = "uses three fresh PDFium worker processes and retained owned fixtures"]
fn restart_recovery_survives_fresh_workers() {
    let seed = SystemTime::now().duration_since(UNIX_EPOCH).expect("system clock").as_nanos();
    let (root, nonce) = (0_u32..64).find_map(|attempt| {
        let nonce = format!("{}-{seed}-{attempt}", std::process::id());
        let root = std::env::temp_dir().join(format!("smacrobat-recovery-restart-{nonce}"));
        match std::fs::create_dir(&root) {
            Ok(()) => Some((root, nonce)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => None,
            Err(error) => panic!("create owned restart fixture: {error}"),
        }
    }).expect("create unique owned restart fixture");
    let recovery = root.join("recovery");
    std::fs::create_dir(&recovery).expect("create owned recovery fixture");
    let mut marker = OpenOptions::new().write(true).create_new(true).open(root.join(".owned")).expect("create ownership marker");
    marker.write_all(nonce.as_bytes()).expect("write ownership marker");
    marker.sync_all().expect("synchronize ownership marker");
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/welcome.pdf"),
        root.join("source.pdf"),
    ).expect("copy deterministic source fixture");

    let prefix = "service::recovery_restart_tests";
    run_child(&format!("{prefix}::restart_child_a_persists_without_close"), &root, &nonce);
    run_child(&format!("{prefix}::restart_child_b_keeps_and_undoes"), &root, &nonce);
    run_child(&format!("{prefix}::restart_child_c_observes_tombstone"), &root, &nonce);
}
