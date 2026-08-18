use std::path::PathBuf;
use std::process::Command;

const WINDOWS_TEST_MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

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

    let Some(rc) = embed_resource::find_windows_sdk_tool("rc.exe") else {
        println!("cargo:warning=rc.exe not found; Windows cargo test may fail to start");
        return;
    };

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let manifest = out_dir.join("windows-test.manifest");
    let rc_file = out_dir.join("windows-test.rc");
    let lib_file = out_dir.join("lightink_windows_test_manifest.lib");
    std::fs::write(&manifest, WINDOWS_TEST_MANIFEST).expect("write windows-test.manifest");
    std::fs::write(&rc_file, "1 24 \"windows-test.manifest\"\n").expect("write windows-test.rc");

    let status = Command::new(&rc)
        .current_dir(&out_dir)
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
