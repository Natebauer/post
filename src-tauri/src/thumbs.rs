//! Attachment thumbnails from the Windows shell, the same previews Explorer shows
//! (Office documents, videos, and anything else with a registered thumbnail provider).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use base64::Engine;
use sha2::{Digest, Sha256};

use crate::state::AppState;

const SIZE: i32 = 256;
/// Don't download huge files just to preview them.
const MAX_BYTES: i64 = 25 * 1024 * 1024;

fn hash(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// A PNG data URL for the attachment, or None when Windows has no thumbnail for it.
pub async fn thumbnail(st: &AppState, msg_id: &str, part_id: &str) -> Result<Option<String>> {
    let key = hash(&format!("{msg_id}/{part_id}"));
    let dir = st.cache_dir.join("thumbs");
    let png_path = dir.join(format!("{key}.png"));
    let none_path = dir.join(format!("{key}.none"));
    if let Ok(png) = tokio::fs::read(&png_path).await {
        return Ok(Some(data_url(&png)));
    }
    if none_path.exists() {
        return Ok(None);
    }
    let meta = st
        .db
        .message_attachments(msg_id)
        .and_then(|a| a.into_iter().find(|a| a.part_id == part_id));
    if meta.as_ref().map(|m| m.size > MAX_BYTES).unwrap_or(false) {
        return Ok(None);
    }

    let (bytes, _, filename) = crate::protocols::fetch_attachment(st, msg_id, part_id).await?;
    tokio::fs::create_dir_all(&dir).await?;
    // The shell picks a thumbnail provider by file extension, so keep it.
    let ext = Path::new(&filename).extension().and_then(|e| e.to_str()).unwrap_or("bin").to_lowercase();
    let src = dir.join(format!("{key}.src.{ext}"));
    tokio::fs::write(&src, &bytes).await?;

    let src2 = src.clone();
    let png = tauri::async_runtime::spawn_blocking(move || shell_thumbnail(&src2)).await?;
    let _ = tokio::fs::remove_file(&src).await;
    match png {
        Ok(png) => {
            tokio::fs::write(&png_path, &png).await?;
            Ok(Some(data_url(&png)))
        }
        Err(e) => {
            log::info!("no thumbnail for {filename}: {e}");
            let _ = tokio::fs::write(&none_path, b"").await;
            Ok(None)
        }
    }
}

fn data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png))
}

#[cfg(windows)]
fn shell_thumbnail(path: &PathBuf) -> Result<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY,
    };

    unsafe {
        let inited = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result = (|| -> Result<Vec<u8>> {
            let factory: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path.as_os_str()), None)?;
            // THUMBNAILONLY: a real preview or nothing (never the generic file-type icon).
            let hbmp = factory.GetImage(SIZE { cx: SIZE, cy: SIZE }, SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK)?;
            let obj = HGDIOBJ(hbmp.0);
            let mut bm = BITMAP::default();
            if GetObjectW(obj, std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
                let _ = DeleteObject(obj);
                return Err(anyhow!("GetObject failed"));
            }
            let (w, h) = (bm.bmWidth, bm.bmHeight);
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut buf = vec![0u8; (w * h * 4) as usize];
            let dc = GetDC(None);
            let lines = GetDIBits(dc, hbmp, 0, h as u32, Some(buf.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS);
            ReleaseDC(None, dc);
            let _ = DeleteObject(obj);
            if lines == 0 {
                return Err(anyhow!("GetDIBits failed"));
            }
            // BGRA -> RGBA. Opaque bitmaps often report alpha 0; treat that as fully opaque.
            let all_clear = buf.chunks_exact(4).all(|p| p[3] == 0);
            for p in buf.chunks_exact_mut(4) {
                p.swap(0, 2);
                if all_clear {
                    p[3] = 255;
                }
            }
            let mut png = Vec::new();
            {
                let mut enc = png::Encoder::new(&mut png, w as u32, h as u32);
                enc.set_color(png::ColorType::Rgba);
                enc.set_depth(png::BitDepth::Eight);
                enc.write_header()?.write_image_data(&buf)?;
            }
            Ok(png)
        })();
        if inited {
            CoUninitialize();
        }
        result
    }
}

#[cfg(not(windows))]
fn shell_thumbnail(_path: &PathBuf) -> Result<Vec<u8>> {
    Err(anyhow!("thumbnails need Windows"))
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn shell_thumbnail_of_png() {
        let dir = std::env::temp_dir().join(format!("post-thumb-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sample.png");
        // A 300x200 orange image.
        let (w, h) = (300u32, 200u32);
        let mut data = Vec::new();
        {
            let mut enc = png::Encoder::new(&mut data, w, h);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let px: Vec<u8> = (0..w * h).flat_map(|_| [240u8, 140, 60]).collect();
            enc.write_header().unwrap().write_image_data(&px).unwrap();
        }
        std::fs::write(&path, data).unwrap();
        let out = super::shell_thumbnail(&path).expect("thumbnail");
        let dec = png::Decoder::new(std::io::Cursor::new(out));
        let reader = dec.read_info().unwrap();
        let info = reader.info();
        assert!(info.width > 0 && info.height > 0, "{}x{}", info.width, info.height);
    }
}
