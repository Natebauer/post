//! Signing in, the account and app-level settings.

use super::*;

// ---------------- app / auth ----------------

#[tauri::command]
pub fn get_app_state(st: St<'_>) -> Value {
    json!({
        "configured": st.auth.client().is_some(),
        "signedIn": st.auth.signed_in(),
        "email": st.db.my_email(),
        "settings": st.db.settings(),
        "status": *st.status.lock().unwrap(),
        "unread": st.db.inbox_unread(),
        "counts": st.db.folder_counts(),
    })
}

#[tauri::command]
pub fn set_client(st: St<'_>, client_id: String, client_secret: String) -> R<()> {
    if !client_id.ends_with(".apps.googleusercontent.com") {
        return err("That doesn't look like a Google OAuth client ID (it should end in .apps.googleusercontent.com).");
    }
    st.auth.set_client(&client_id, &client_secret)?;
    Ok(())
}

#[tauri::command]
pub async fn sign_in(app: AppHandle, st: St<'_>) -> R<String> {
    let a = app.clone();
    st.auth
        .sign_in(move |url| {
            use tauri_plugin_opener::OpenerExt;
            let _ = a.opener().open_url(url, None::<&str>);
        })
        .await?;
    let (email, _, _) = st.gmail.profile().await?;
    let email = email.to_lowercase();
    let prev = st.db.my_email();
    if !prev.is_empty() && prev != email {
        st.db.wipe()?;
    }
    st.db.kv_set("email", &email)?;
    crate::platform::show_main(&app);
    st.wake.notify_one();
    Ok(email)
}

#[tauri::command]
pub async fn sign_out(app: AppHandle, st: St<'_>) -> R<()> {
    st.auth.sign_out().await;
    st.db.wipe()?;
    st.db.kv_del("email")?;
    emit_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn save_settings(app: AppHandle, st: St<'_>, settings: Settings) -> R<()> {
    let old = st.db.settings();
    st.db.kv_set("settings", &serde_json::to_string(&settings).map_err(|e| CmdError(e.to_string()))?)?;
    if old.launch_at_startup != settings.launch_at_startup {
        crate::platform::apply_autostart(&app, settings.launch_at_startup);
    }
    let _ = tauri::Emitter::emit(&app, "settings-changed", &settings);
    Ok(())
}

#[tauri::command]
pub fn sync_now(st: St<'_>) {
    st.wake.notify_one();
}

#[tauri::command]
pub fn get_status(st: St<'_>) -> SyncStatus {
    st.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}
