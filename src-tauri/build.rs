fn main() {
    // Re-embed the app icon whenever the icon files change. The icon lives in two places: the
    // .exe's resources (from tauri_build) and the window/tray icon compiled into the app code by
    // `generate_context!`. A fingerprint of the icon passed as an env var (read in lib.rs) makes
    // the app code recompile too, so a rebuild can't keep an old icon in either place.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=capabilities");
    let mut hash: u64 = 0xcbf29ce484222325;
    for f in ["icons/icon.png", "icons/icon.ico", "icons/32x32.png", "icons/128x128.png"] {
        for b in std::fs::read(f).unwrap_or_default() {
            hash = (hash ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    println!("cargo:rustc-env=POST_ICON_FINGERPRINT={hash:016x}");
    tauri_build::build()
}
