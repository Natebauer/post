//! Writing: drafts, the outbox and compose windows.

use super::*;

// ---------------- compose / outbox / drafts ----------------

#[tauri::command]
pub fn queue_send(app: AppHandle, st: St<'_>, compose: ComposeData, send_at: Option<i64>) -> R<Value> {
    if compose.to.is_empty() && compose.cc.is_empty() && compose.bcc.is_empty() {
        return err("Add at least one recipient.");
    }
    let (at, kind) = match send_at {
        Some(t) if t > now_ms() + 5_000 => (t, "scheduled"),
        _ => (now_ms() + st.db.settings().undo_seconds.clamp(0, 30) * 1000, "undo"),
    };
    let id = st.db.outbox_add(&compose, at, kind)?;
    let _ = tauri::Emitter::emit(&app, "outbox-changed", ());
    Ok(json!({ "id": id, "sendAt": at, "kind": kind }))
}

#[tauri::command]
pub fn cancel_send(app: AppHandle, st: St<'_>, id: i64) -> R<Option<ComposeData>> {
    let r = st.db.outbox_take(id)?;
    let _ = tauri::Emitter::emit(&app, "outbox-changed", ());
    Ok(r)
}

#[tauri::command]
pub fn list_outbox(st: St<'_>) -> R<Vec<OutboxItem>> {
    Ok(st.db.outbox_list()?)
}

#[tauri::command]
pub async fn save_draft(st: St<'_>, compose: ComposeData) -> R<Value> {
    let raw = crate::outbox::build_mime(&st, &compose).await?;
    let (draft_id, message_id) = st
        .gmail
        .save_draft(compose.draft_id.as_deref(), &raw, compose.thread_id.as_deref())
        .await?;
    st.wake.notify_one();
    Ok(json!({ "draftId": draft_id, "messageId": message_id }))
}

#[tauri::command]
pub async fn delete_draft(st: St<'_>, draft_id: String) -> R<()> {
    st.gmail.delete_draft(&draft_id).await?;
    st.wake.notify_one();
    Ok(())
}

#[tauri::command]
pub async fn load_draft(st: St<'_>, message_id: String) -> R<ComposeData> {
    let draft_id = st.gmail.find_draft(&message_id).await?;
    let v = st.gmail.get_message(&message_id).await?;
    let m = parse_message(&v)?;
    let html = m.html_body.clone().unwrap_or_else(|| {
        m.text_body
            .lines()
            .map(|l| format!("<p>{}</p>", l.replace('&', "&amp;").replace('<', "&lt;")))
            .collect()
    });
    let is_reply = !m.in_reply_to.is_empty();
    Ok(ComposeData {
        to: m.to.clone(),
        cc: m.cc.clone(),
        bcc: m.bcc.clone(),
        subject: m.subject.clone(),
        html,
        attachments: vec![],
        forward_attachments: m
            .attachments
            .iter()
            .filter(|a| !a.inline)
            .map(|a| ForwardAttachment {
                message_id: m.id.clone(),
                part_id: a.part_id.clone(),
                filename: a.filename.clone(),
                mime_type: a.mime_type.clone(),
                size: a.size,
            })
            .collect(),
        in_reply_to: if is_reply { Some(m.in_reply_to.clone()) } else { None },
        references: if m.references.is_empty() { None } else { Some(m.references.clone()) },
        thread_id: if is_reply { Some(m.thread_id.clone()) } else { None },
        draft_id,
        from: if m.from.email.is_empty() { None } else { Some(m.from.clone()) },
    })
}

#[tauri::command]
pub fn suggest_contacts(st: St<'_>, query: String) -> R<Vec<ContactSuggestion>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    Ok(st.db.suggest_contacts(query.trim(), 8)?)
}

#[tauri::command]
// Must be async: creating a window from a synchronous command deadlocks Tauri's main thread on
// Windows (the new window stays blank and the app's own window controls stop responding).
pub async fn open_compose_window(app: AppHandle, st: St<'_>, init: Value) -> R<()> {
    let label = format!("compose-{}", now_ms());
    st.compose_inits.lock().unwrap().insert(label.clone(), init);
    // Plain index.html: a "#fragment" in an App path is treated as part of the file name.
    // The frontend tells compose windows apart by their "compose-" label instead.
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("New message")
        .inner_size(720.0, 640.0)
        .min_inner_size(480.0, 360.0)
        .decorations(false)
        .shadow(true)
        .visible(false)
        // A solid background (no Mica), like the main window, so it doesn't shift with focus.
        .build()
        .map_err(|e| CmdError(e.to_string()))?;
    place_on_main_screen(&app, &win);
    let _ = win.show();
    let _ = win.set_focus();
    log::info!("compose window {label} created");

    // Safety net: if the window's page never starts (it collects its draft on startup),
    // close it and reopen the draft in the main window instead of leaving a dead window.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        let st = state(&app2);
        let pending = st.compose_inits.lock().unwrap().remove(&label);
        if let Some(init) = pending {
            log::error!("compose window {label} never started; reopening the draft in the main window");
            if let Some(w) = app2.get_webview_window(&label) {
                let _ = w.destroy();
            }
            crate::platform::show_main(&app2);
            let _ = tauri::Emitter::emit(&app2, "compose-fallback", init);
        }
    });
    Ok(())
}

/// Center a new window over Post's main window, on whichever screen that is. If the main window
/// is hidden or minimized (e.g. compose from the tray), use the screen the mouse is on.
fn place_on_main_screen(app: &AppHandle, win: &tauri::WebviewWindow) {
    use tauri::{PhysicalPosition, PhysicalRect, PhysicalSize};
    let main = app.get_webview_window("main");
    let anchor: Option<PhysicalRect<i32, u32>> = main.as_ref().and_then(|m| {
        let shown = m.is_visible().unwrap_or(false) && !m.is_minimized().unwrap_or(false);
        if !shown {
            return None;
        }
        Some(PhysicalRect { position: m.outer_position().ok()?, size: m.outer_size().ok()? })
    });
    let monitor = match &anchor {
        Some(r) => app
            .monitor_from_point(
                (r.position.x + r.size.width as i32 / 2) as f64,
                (r.position.y + r.size.height as i32 / 2) as f64,
            )
            .ok()
            .flatten(),
        None => app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()),
    };
    let Some(monitor) = monitor else { return };
    let work = *monitor.work_area();
    // Move onto the target screen first: crossing screens with different scaling makes Windows
    // rescale the window, so the size is only set once it's there.
    let _ = win.set_position(PhysicalPosition::new(work.position.x + 40, work.position.y + 40));
    let scale = monitor.scale_factor();
    let w = ((720.0 * scale) as u32).min(work.size.width);
    let h = ((640.0 * scale) as u32).min(work.size.height);
    let _ = win.set_size(PhysicalSize::new(w, h));
    let (w, h) = win.outer_size().map(|s| (s.width, s.height)).unwrap_or((w, h));
    let center = anchor.unwrap_or(work);
    let x = center.position.x + (center.size.width as i32 - w as i32) / 2;
    let y = center.position.y + (center.size.height as i32 - h as i32) / 2;
    // Keep it fully on that screen.
    let x = x.clamp(work.position.x, work.position.x + work.size.width as i32 - w as i32);
    let y = y.clamp(work.position.y, work.position.y + work.size.height as i32 - h as i32);
    let _ = win.set_position(PhysicalPosition::new(x, y));
    log::info!("compose window placed at {x},{y} size {w}x{h} (screen scale {scale})");
}

#[tauri::command]
pub fn take_compose_init(st: St<'_>, label: String) -> Option<Value> {
    log::info!("compose window {label} started");
    st.compose_inits.lock().unwrap().remove(&label)
}
