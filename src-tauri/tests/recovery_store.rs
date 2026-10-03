#[path = "../src/recovery_journal.rs"]
mod recovery_journal;
#[path = "../src/recovery_store.rs"]
mod recovery_store;
use recovery_journal::*;
use recovery_store::*;
use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
fn identity() -> SourceIdentity {
    SourceIdentity {
        bytes: 4096,
        sha256: [0x5a; 32],
    }
}
fn record(generation: u64, revision: u64) -> RecoveryRecord {
    RecoveryRecord {
        generation,
        revision,
        current_page: 0,
        source_pages: 1,
        source: identity(),
        edit_state: RecoveryEditState {
            pages: vec![RecoveryPage {
                source: 0,
                turns: 0,
                crop: None,
                annotations: vec![],
            }],
        },
    }
}
fn fresh_root(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "smacrobat-recovery-store-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    root
}
#[test]
fn atomically_publishes_and_replaces_only_newer_records() {
    let root = fresh_root("replace");
    let path = write_recovery(&root, &record(1, 2)).unwrap();
    assert_eq!(
        path.file_name().unwrap().to_str().unwrap(),
        format!("{}.smacrec", "5a".repeat(32))
    );
    assert_eq!(
        read_recovery(&root, identity(), None, 0).unwrap().unwrap(),
        record(1, 2)
    );
    let replaced = write_recovery(&root, &record(2, 3)).unwrap();
    assert_eq!(path, replaced);
    assert_eq!(
        read_recovery(&root, identity(), Some(1), 3)
            .unwrap()
            .unwrap(),
        record(2, 3)
    );
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}
#[test]
fn rejects_stale_or_regressed_writes_without_changing_the_record() {
    let root = fresh_root("stale");
    let path = write_recovery(&root, &record(4, 8)).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(write_recovery(&root, &record(4, 9))
        .unwrap_err()
        .contains("stale"));
    assert!(write_recovery(&root, &record(5, 7))
        .unwrap_err()
        .contains("stale"));
    assert_eq!(fs::read(&path).unwrap(), before);
}
#[test]
fn rejects_corrupt_wrong_source_and_stale_reads() {
    let root = fresh_root("read");
    let path = write_recovery(&root, &record(1, 2)).unwrap();
    assert!(read_recovery(
        &root,
        SourceIdentity {
            bytes: 4097,
            ..identity()
        },
        None,
        0
    )
    .unwrap_err()
    .contains("source"));
    assert!(read_recovery(&root, identity(), Some(1), 0)
        .unwrap_err()
        .contains("generation"));
    assert!(read_recovery(&root, identity(), None, 3)
        .unwrap_err()
        .contains("revision"));
    let mut corrupt = fs::read(&path).unwrap();
    corrupt[78] ^= 1;
    fs::write(&path, corrupt).unwrap();
    assert!(read_recovery(&root, identity(), None, 0)
        .unwrap_err()
        .contains("integrity"));
}
#[test]
fn refuses_missing_relative_non_directory_and_reparse_roots() {
    let missing = fresh_root("parent").join("missing");
    assert!(write_recovery(&missing, &record(1, 1))
        .unwrap_err()
        .contains("unavailable"));
    assert!(
        write_recovery(PathBuf::from("relative").as_path(), &record(1, 1))
            .unwrap_err()
            .contains("unsafe")
    );
    let parent = fresh_root("file");
    let file = parent.join("not-a-directory");
    fs::write(&file, b"x").unwrap();
    assert!(write_recovery(&file, &record(1, 1))
        .unwrap_err()
        .contains("unsafe"));
    let link = parent.join("directory-link");
    if std::os::windows::fs::symlink_dir(&parent, &link).is_ok() {
        assert!(write_recovery(&link, &record(1, 1))
            .unwrap_err()
            .contains("unsafe"));
    }
}

#[test]
fn refuses_non_file_destination_without_clobbering_it() {
    let root = fresh_root("destination");
    let destination = root.join(format!("{}.smacrec", "5a".repeat(32)));
    fs::create_dir(&destination).unwrap();
    assert!(write_recovery(&root, &record(1, 1))
        .unwrap_err()
        .contains("unsafe"));
    assert!(destination.is_dir());
    assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
}

#[test]
fn bounds_retained_temporary_artifacts_before_writing() {
    let root = fresh_root("temps");
    for index in 0..4 {
        fs::write(
            root.join(format!(".smacrec-owned-{index}.tmp")),
            b"sentinel",
        )
        .unwrap();
    }
    assert!(write_recovery(&root, &record(1, 1))
        .unwrap_err()
        .contains("temporary record limit"));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 4);
}

#[test]
fn concurrent_writers_cannot_replace_the_newest_generation_with_an_older_one() {
    let root = Arc::new(fresh_root("concurrent"));
    let writers = (1..=8)
        .map(|generation| {
            let root = Arc::clone(&root);
            thread::spawn(move || write_recovery(&root, &record(generation, generation)))
        })
        .collect::<Vec<_>>();
    for writer in writers {
        let _ = writer.join().unwrap();
    }
    let recovered = read_recovery(&root, identity(), None, 0).unwrap().unwrap();
    assert_eq!(recovered.generation, 8);
    assert_eq!(recovered.revision, 8);
    assert_eq!(fs::read_dir(root.as_ref()).unwrap().count(), 1);
}
