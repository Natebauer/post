mod ai;
mod auth;
mod calendar;
mod codes;
mod commands;
mod db;
mod files;
mod gmail;
mod home;
mod logger;
mod notify;
mod outbox;
mod parse;
mod platform;
mod protocols;
mod sections;
mod state;
mod sync;
mod thumbs;
mod types;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// Changes whenever the icon files do (see build.rs), so this crate, and the window and tray icon
/// `generate_context!` compiles into it, is rebuilt with the current icon.
#[allow(dead_code)]
const ICON_FINGERPRINT: &str = env!("POST_ICON_FINGERPRINT");

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, WindowEvent};

use state::AppState;

pub fn run() {
    let launch_args: Vec<String> = std::env::args().collect();
    let start_minimized = launch_args.iter().any(|a| a == "--minimized");

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            platform::show_main(app);
            platform::handle_args(app, &args);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            // Remember the main window's size and position (visibility is ours to manage).
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .with_filter(|label| label == "main")
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        platform::show_main(app);
                        let _ = app.emit("compose-new", ());
                    }
                })
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("postatt", |ctx, req, responder| {
            let st = ctx.app_handle().state::<Arc<AppState>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(protocols::handle_attachment(&st, req).await);
            });
        })
        .register_asynchronous_uri_scheme_protocol("avatar", |ctx, req, responder| {
            let st = ctx.app_handle().state::<Arc<AppState>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                responder.respond(protocols::handle_avatar(&st, req).await);
            });
        })
        .setup(move |app| {
            let data_dir = app.path().app_data_dir()?;
            let cache_dir = app.path().app_cache_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(&cache_dir)?;
            logger::init(data_dir.clone());
            log::info!("Post {} starting (data: {})", env!("CARGO_PKG_VERSION"), data_dir.display());
            match db::import_redirected_copy(&data_dir, &app.config().identifier) {
                Ok(Some(from)) => log::info!("Imported account and mail from redirected copy at {}", from.display()),
                Ok(None) => {}
                Err(e) => log::warn!("Couldn't import redirected data copy: {e:#}"),
            }
            let db = Arc::new(db::Db::open(&data_dir.join("mail.db"))?);
            db.migrate_accent_default();
            let http = reqwest::Client::builder()
                .user_agent("Post/0.1 (desktop mail client)")
                .build()?;
            let auth = Arc::new(auth::Auth::new(db.clone(), http.clone()));
            let gmail = Arc::new(gmail::Gmail::new(http.clone(), auth.clone()));
            let st = Arc::new(AppState {
                db: db.clone(),
                auth,
                gmail,
                http,
                wake: Arc::new(tokio::sync::Notify::new()),
                status: Mutex::new(Default::default()),
                cache_dir,
                data_dir: data_dir.clone(),
                compose_inits: Mutex::new(HashMap::new()),
                avatar_locks: Mutex::new(HashMap::new()),
                att_locks: Mutex::new(HashMap::new()),
            });
            app.manage(st.clone());
            // Old opened-attachment copies, staged attachments and caches get tidied in the background.
            {
                let st = st.clone();
                std::thread::spawn(move || files::clean_up(&st));
            }

            // Start with Windows (on unless turned off): checked on every launch, so the entry
            // always points at this post.exe, not one from an older install that's since moved.
            if !cfg!(debug_assertions) {
                platform::apply_autostart(app.handle(), db.settings().launch_at_startup);
                let _ = db.kv_set("first_run_done", "1");
            }
            if let Err(e) = platform::register_mailto() {
                log::warn!("mailto registration failed: {e}");
            }

            // Installed builds share the Start Menu shortcut's AppUserModelID (taskbar, jump list, toasts).
            if notify::is_installed() {
                platform::set_app_id(&app.config().identifier);
            }
            if let Err(e) = platform::setup_jump_list() {
                log::warn!("jump list setup failed: {e}");
            }
            if db.settings().global_shortcut {
                use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
                let sc = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM);
                if let Err(e) = app.global_shortcut().register(sc) {
                    log::warn!("global shortcut Ctrl+Alt+M unavailable: {e}");
                }
            }

            // A mailto: (or --compose) passed at first launch is picked up by the UI once it loads.
            if launch_args.iter().any(|a| a == platform::COMPOSE_ARG) {
                st.compose_inits.lock().unwrap().insert(
                    "__launch_mailto".into(),
                    serde_json::to_value(types::ComposeData::default()).unwrap(),
                );
            }
            if let Some(m) = launch_args.iter().find(|a| a.to_lowercase().starts_with("mailto:")) {
                if let Some(c) = platform::parse_mailto(m) {
                    st.compose_inits
                        .lock()
                        .unwrap()
                        .insert("__launch_mailto".into(), serde_json::to_value(c).unwrap());
                }
            }

            // Tray
            let open = MenuItem::with_id(app, "open", "Open Post", true, None::<&str>)?;
            let compose = MenuItem::with_id(app, "compose", "New message", true, None::<&str>)?;
            let check = MenuItem::with_id(app, "check", "Check for mail", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Post", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &compose, &check, &sep, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Post")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, e| match e.id().as_ref() {
                    "open" => platform::show_main(app),
                    "compose" => {
                        platform::show_main(app);
                        let _ = app.emit("compose-new", ());
                    }
                    "check" => state::state(app).wake.notify_one(),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                        platform::show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if let Some(w) = app.get_webview_window("main") {
                if !start_minimized {
                    let _ = w.show();
                }
            }

            sync::start(app.handle().clone());
            outbox::start(app.handle().clone());
            state::emit_changed(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                let st = state::state(window.app_handle());
                let staged = files::stage(&st, paths);
                if !staged.is_empty() {
                    let _ = window.emit_to(window.label(), "files-staged", staged);
                }
            }
            // Closing the main window keeps Post running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::set_client,
            commands::sign_in,
            commands::sign_out,
            commands::save_settings,
            commands::sync_now,
            commands::get_status,
            commands::quit_app,
            commands::list_threads,
            commands::get_thread,
            commands::mark_read,
            commands::trash_threads,
            commands::untrash_threads,
            commands::spam_threads,
            commands::label_threads,
            commands::pick_attachments,
            commands::ask_thread,
            commands::ai_assist,
            commands::ai_command,
            commands::mute_thread,
            commands::is_muted,
            commands::snooze_thread,
            commands::unsnooze_thread,
            commands::search_local,
            commands::search_remote,
            commands::unsubscribe,
            commands::queue_send,
            commands::cancel_send,
            commands::list_outbox,
            commands::save_draft,
            commands::delete_draft,
            commands::load_draft,
            commands::suggest_contacts,
            commands::open_compose_window,
            commands::take_compose_init,
            commands::open_attachment,
            commands::save_attachment,
            commands::set_badge,
            commands::make_default_mail_app,
            commands::take_launch_mailto,
            commands::show_main_window,
            commands::mark_all_read,
            commands::get_raw,
            commands::save_raw,
            commands::save_all_attachments,
            commands::list_send_as,
            commands::rsvp,
            commands::rsvp_status,
            commands::ai_status,
            commands::set_ai_key,
            commands::clear_ai_key,
            commands::test_ai,
            commands::ai_describe_category,
            commands::ask_inbox,
            commands::tone_check,
            commands::category_mark,
            commands::category_classify,
            commands::home_summary,
            commands::pin_thread,
            commands::is_pinned,
            commands::calendar_upcoming,
            commands::attachment_thumbnail,
            commands::log_frontend,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Post");
}
