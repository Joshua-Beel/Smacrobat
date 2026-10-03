param([string]$CargoPath = 'cargo')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$manifest = 'src-tauri/Cargo.toml'
& $CargoPath test --locked --manifest-path $manifest -- --test-threads=1
if ($LASTEXITCODE -ne 0) { throw 'The serialized native test gate failed.' }

$required = @(
  'service::tests::recovery_checkpoint_ack_is_durable_and_explicit_restore_replays_exact_state',
  'service::tests::explicit_discard_is_idempotent_and_resolves_post_publish_lock',
  'service::recovery_restart_tests::restart_recovery_survives_fresh_workers'
)
foreach ($testName in $required) {
  $output = @(& $CargoPath test --locked --manifest-path $manifest --bin pdf-workstation $testName -- --ignored --exact --test-threads=1 2>&1 | ForEach-Object { $_.ToString() })
  $status = $LASTEXITCODE
  $text = $output -join "`n"
  if ([Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw "The required native test receipt exceeded its output bound: $testName" }
  $output | Write-Output
  if ($status -ne 0) { throw "The required native test failed: $testName" }
  $footers = @([regex]::Matches($text, 'test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; \d+ filtered out; finished in [^\r\n]+'))
  if ($footers.Count -ne 1) { throw "The required native test did not produce one exact passing receipt: $testName" }
}
