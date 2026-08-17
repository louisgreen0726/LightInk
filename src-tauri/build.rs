use std::path::PathBuf;
use std::process::Command;

fn main() {
    tauri_build::build();
    compile_windows_test_manifest_lib();
}

fn compile_windows_test_manifest_lib() {
    println!("cargo:rustc-check-cfg=cfg(lightink_windows_test_manifest)");
    if std::env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("windows") {
        return;
    }
    if std::env::var("CARGO_CFG_TARGET_ENV").ok().as_deref() != Some("msvc") {
        return;
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let rc_file = manifest_dir.join("windows-test.rc");
    let manifest = manifest_dir.join("windows-test.manifest");
    println!("cargo:rerun-if-changed={}", rc_file.display());
    println!("cargo:rerun-if-changed={}", manifest.display());

    let Some(rc) = embed_resource::find_windows_sdk_tool("rc.exe") else {
        println!("cargo:warning=rc.exe not found; Windows cargo test may fail to start");
        return;
    };

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let lib_file = out_dir.join("lightink_windows_test_manifest.lib");
    let status = Command::new(&rc)
        .current_dir(&manifest_dir)
        .args(["/nologo", "/fo"])
        .arg(&lib_file)
        .arg(&rc_file)
        .status()
        .unwrap_or_else(|error| panic!("spawn rc.exe: {error}"));
    if !status.success() {
        panic!("rc.exe failed with {status}");
    }
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!("cargo:rustc-cfg=lightink_windows_test_manifest");
}
