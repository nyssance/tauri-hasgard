use assert_cmd::Command;

/// `tauri-hasgard --version` must print the CLI version. The flag was missing
/// entirely until issue #135 surfaced it (a caller couldn't tell which CLI
/// build they were running).
///
/// This doubles as the Windows stack-overflow guard. Building the clap command
/// tree overflowed the 1 MiB stack Windows gives a main thread, so every
/// invocation aborted with `STATUS_STACK_OVERFLOW` -- and `--version` is the
/// cheapest invocation there is, so a crash here means the binary is unusable
/// rather than that one flag is broken. It cannot fail on Linux or macOS, whose
/// 8 MiB main stacks were never close; only CI's Windows runner can see it.
#[test]
fn test_version_flag_prints_cli_version() {
    let mut cmd = Command::cargo_bin("tauri-hasgard").expect("tauri-hasgard binary builds");
    let assert = cmd.arg("--version").assert().success();
    let stdout = String::from_utf8_lossy(&assert.get_output().stdout).into_owned();
    assert_eq!(
        stdout.trim_end(),
        format!("tauri-hasgard {}", env!("CARGO_PKG_VERSION")),
        "expected `--version` to print `tauri-hasgard <version>`, got: {stdout}",
    );
}
