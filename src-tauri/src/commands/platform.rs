//! Windows integration, plus smaller mailbox and message tools.

use super::*;

// ---------------- platform ----------------

#[tauri::command]
pub fn set_badge(app: AppHandle, png: Option<Vec<u8>>) -> R<()> {
    crate::platform::set_overlay(&app, png)?;
    Ok(())
}

#[tauri::command]
pub fn make_default_mail_app(app: AppHandle) -> R<()> {
    crate::platform::register_mailto()?;
    use tauri_plugin_opener::OpenerExt;
    let _ = app
        .opener()
        .open_url("ms-settings:defaultapps?registeredAppUser=Post", None::<&str>);
    Ok(())
}

#[tauri::command]
pub fn take_launch_mailto(st: St<'_>) -> Option<ComposeData> {
    let v = st.compose_inits.lock().unwrap().remove("__launch_mailto")?;
    serde_json::from_value(v).ok()
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    crate::platform::show_main(&app);
}

// ---------------- review additions ----------------

#[tauri::command]
pub async fn mark_all_read(app: AppHandle, st: St<'_>, folder: String) -> R<usize> {
    let ids = st.db.unread_threads(&folder);
    let n = ids.len();
    if n > 0 {
        set_read(&app, ids, true).await?;
    }
    Ok(n)
}

#[tauri::command]
pub async fn get_raw(st: St<'_>, message_id: String) -> R<String> {
    let raw = st.gmail.get_raw(&message_id).await?;
    Ok(String::from_utf8_lossy(&raw).into_owned())
}

/// Save a message as .eml where the user picks. Returns false if they cancel.
#[tauri::command]
pub async fn save_raw(app: AppHandle, st: St<'_>, message_id: String, name: String) -> R<bool> {
    let Some(path) = crate::files::ask_save_path(&app, &format!("{name}.eml"), Some(("Email message", &["eml"]))).await else {
        return Ok(false);
    };
    let raw = st.gmail.get_raw(&message_id).await?;
    crate::files::write_download(&path, &raw)?;
    Ok(true)
}

/// Save every attachment into a folder the user picks. Returns how many, and the folder.
#[tauri::command]
pub async fn save_all_attachments(app: AppHandle, st: St<'_>, message_id: String) -> R<Option<(usize, String)>> {
    let Some(dir) = crate::files::ask_folder(&app, "Save attachments to…").await else { return Ok(None) };
    let atts = st.db.message_attachments(&message_id).unwrap_or_default();
    let mut used = HashSet::new();
    let mut n = 0;
    for a in atts.iter().filter(|a| !a.inline) {
        let (bytes, _, filename) = crate::protocols::fetch_attachment(&st, &message_id, &a.part_id).await?;
        let safe = crate::files::safe_name(&filename);
        let (stem, ext) = match safe.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), format!(".{e}")),
            None => (safe.clone(), String::new()),
        };
        let mut name = safe.clone();
        let mut i = 1;
        while used.contains(&name.to_lowercase()) || dir.join(&name).exists() {
            i += 1;
            name = format!("{stem} ({i}){ext}");
        }
        used.insert(name.to_lowercase());
        crate::files::write_download(&dir.join(&name), &bytes)?;
        n += 1;
    }
    Ok(Some((n, remember_saved(dir))))
}

#[tauri::command]
pub async fn list_send_as(st: St<'_>) -> R<Vec<SendAs>> {
    Ok(st.gmail.send_as().await?)
}

#[tauri::command]
pub async fn rsvp(app: AppHandle, st: St<'_>, message_id: String, ics: String, response: String) -> R<()> {
    let partstat = match response.as_str() {
        "yes" => "ACCEPTED",
        "maybe" => "TENTATIVE",
        _ => "DECLINED",
    };
    let me = st.db.my_email();
    let name = st.db.settings().display_name;
    let (reply, organizer, summary) = crate::calendar::build_reply(&ics, &me, &name, partstat)?;
    let raw = crate::calendar::reply_mime(&me, &name, &organizer, &summary, partstat, reply)?;
    let thread = st.db.thread_messages_thread(&message_id);
    st.gmail.send_raw(&raw, thread.as_deref()).await?;
    st.db.kv_set(&format!("rsvp:{message_id}"), &response)?;
    st.wake.notify_one();
    let _ = &app;
    Ok(())
}

#[tauri::command]
pub fn rsvp_status(st: St<'_>, message_ids: Vec<String>) -> std::collections::HashMap<String, String> {
    message_ids
        .into_iter()
        .filter_map(|id| st.db.kv_get(&format!("rsvp:{id}")).map(|v| (id, v)))
        .collect()
}
