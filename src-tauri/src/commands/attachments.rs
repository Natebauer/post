//! Opening, saving and attaching files.

use super::*;

// ---------------- attachments ----------------

/// Open an attachment in its usual app. Files that run code (an .exe, a script, a shortcut)
/// answer "confirm" first so the user can choose to open them anyway.
#[tauri::command]
pub async fn open_attachment(app: AppHandle, st: St<'_>, message_id: String, part_id: String, confirmed: Option<bool>) -> R<String> {
    let (bytes, _, filename) = crate::protocols::fetch_attachment(&st, &message_id, &part_id).await?;
    if crate::files::is_risky(&filename) && confirmed != Some(true) {
        return Ok("confirm".into());
    }
    let dir = std::env::temp_dir().join("Post").join(format!("{}", now_ms()));
    std::fs::create_dir_all(&dir).map_err(|e| CmdError(e.to_string()))?;
    let path = dir.join(crate::files::safe_name(&filename));
    crate::files::write_download(&path, &bytes)?;
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path.to_string_lossy(), None::<&str>)
        .map_err(|e| CmdError(e.to_string()))?;
    Ok("opened".into())
}

/// Save an attachment where the user picks. Returns where it went, or nothing if they cancel.
#[tauri::command]
pub async fn save_attachment(app: AppHandle, st: St<'_>, message_id: String, part_id: String) -> R<Option<String>> {
    let (bytes, _, filename) = crate::protocols::fetch_attachment(&st, &message_id, &part_id).await?;
    let Some(path) = crate::files::ask_save_path(&app, &filename, None).await else { return Ok(None) };
    crate::files::write_download(&path, &bytes)?;
    Ok(Some(remember_saved(path)))
}

// Files and folders Post saved this session: the only paths the window may open or show,
// so a page can't ask Post to open anything else on the computer.
static SAVED: std::sync::Mutex<Vec<std::path::PathBuf>> = std::sync::Mutex::new(Vec::new());

pub(crate) fn remember_saved(path: std::path::PathBuf) -> String {
    let s = path.to_string_lossy().into_owned();
    SAVED.lock().unwrap().push(path);
    s
}

fn saved(path: &str) -> R<std::path::PathBuf> {
    SAVED
        .lock()
        .unwrap()
        .iter()
        .find(|p| p.to_string_lossy() == path)
        .cloned()
        .ok_or_else(|| CmdError("Post didn't save that file".into()))
}

/// Open a file (or folder) Post just saved. Files that run code answer "confirm" first, as when opening an attachment.
#[tauri::command]
pub fn open_saved(app: AppHandle, path: String, confirmed: Option<bool>) -> R<String> {
    let p = saved(&path)?;
    if p.is_file() && crate::files::is_risky(&p.to_string_lossy()) && confirmed != Some(true) {
        return Ok("confirm".into());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(|e| CmdError(e.to_string()))?;
    Ok("opened".into())
}

/// Show a file Post just saved, selected in its folder in File Explorer.
#[tauri::command]
pub fn show_saved(app: AppHandle, path: String) -> R<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(saved(&path)?).map_err(|e| CmdError(e.to_string()))
}

/// Pick files to attach; they're copied somewhere only Post sends from.
#[tauri::command]
pub async fn pick_attachments(app: AppHandle, st: St<'_>) -> R<Vec<crate::files::Staged>> {
    let paths = crate::files::ask_files(&app).await;
    Ok(crate::files::stage(&st, &paths))
}
