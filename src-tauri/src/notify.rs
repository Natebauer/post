use tauri::{AppHandle, Emitter};

use crate::state::state;
use crate::types::{StoredMessage, ThreadSummary};

/// Only the installed app has a Start Menu shortcut carrying our AppUserModelID.
pub fn is_installed() -> bool {
    !cfg!(debug_assertions)
        && std::env::current_exe()
            .map(|p| !p.to_string_lossy().to_lowercase().contains("\\target\\"))
            .unwrap_or(false)
}

#[cfg(windows)]
fn app_id(app: &AppHandle) -> String {
    // Dev builds and exes run straight from target/ borrow PowerShell's so toasts still show.
    if !is_installed() {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>().trim_end())
    }
}

pub fn simple(app: &AppHandle, title: &str, body: &str) {
    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;
        let a = app.clone();
        let res = Toast::new(&app_id(app))
            .title(title)
            .text1(body)
            .on_activated(move |_| {
                crate::platform::show_main(&a);
                Ok(())
            })
            .show();
        if let Err(e) = res {
            log::warn!("toast failed: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, title, body);
    }
}

fn in_quiet_hours(start: i64, end: i64) -> bool {
    use chrono::Timelike;
    let h = chrono::Local::now().hour() as i64;
    if start == end {
        false
    } else if start < end {
        h >= start && h < end
    } else {
        h >= start || h < end
    }
}

/// Newsletters, promotions and automated mail.
fn is_bulk(m: &StoredMessage) -> bool {
    !m.list_unsubscribe.is_empty()
        || m.labels.iter().any(|l| {
            matches!(l.as_str(), "CATEGORY_PROMOTIONS" | "CATEGORY_SOCIAL" | "CATEGORY_UPDATES" | "CATEGORY_FORUMS")
        })
        || m.from.email.contains("noreply")
        || m.from.email.contains("no-reply")
}

pub fn new_mail(app: &AppHandle, msgs: &[&StoredMessage]) {
    let st = state(app);
    let s = st.db.settings();
    if !s.notifications || (s.quiet_hours && in_quiet_hours(s.quiet_start, s.quiet_end)) {
        return;
    }
    // Emails carrying a sign-in or confirmation code always notify (even with "people only"),
    // each on its own, with the code shown on the notification.
    let coded: Vec<(&StoredMessage, String)> = msgs
        .iter()
        .filter_map(|m| crate::codes::find_code(&m.subject, &m.text_body).map(|c| (*m, c)))
        .collect();
    let filtered: Vec<&StoredMessage> = msgs
        .iter()
        .copied()
        .filter(|m| !coded.iter().any(|(c, _)| c.id == m.id))
        .filter(|m| !(s.notify_people_only && is_bulk(m)))
        .collect();
    let msgs = &filtered[..];
    #[cfg(windows)]
    {
        use tauri_winrt_notification::{IconCrop, Toast};
        for (m, code) in &coded {
            code_toast(app, m, code);
        }
        if msgs.is_empty() {
            return;
        }
        if msgs.len() > 4 {
            let senders: Vec<String> = msgs.iter().take(3).map(|m| m.from.display()).collect();
            let threads: Vec<String> = msgs.iter().map(|m| m.thread_id.clone()).collect();
            let a = app.clone();
            let res = Toast::new(&app_id(app))
                .title(&format!("{} new emails", msgs.len()))
                .text1(&format!("From {} and others", senders.join(", ")))
                .add_button("Mark all as read", "markread")
                .on_activated(move |action| {
                    let a = a.clone();
                    if action.as_deref() == Some("markread") {
                        let threads = threads.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = crate::commands::set_read(&a, threads, true).await;
                        });
                    } else {
                        crate::platform::show_main(&a);
                    }
                    Ok(())
                })
                .show();
            if let Err(e) = res {
                log::warn!("toast failed: {e}");
            }
            return;
        }
        for m in msgs {
            let thread = m.thread_id.clone();
            let a = app.clone();
            let mut toast = Toast::new(&app_id(app))
                .title(&truncate(&m.from.display(), 60))
                .text1(&truncate(if m.subject.is_empty() { "(no subject)" } else { &m.subject }, 90))
                .text2(&truncate(&m.snippet, 140))
                .add_button("Reply", "reply")
                .add_button("Mark as read", "markread");
            if let Some(p) = crate::protocols::cached_avatar_path(&st, &m.from.email) {
                toast = toast.icon(&p, IconCrop::Circular, "");
            }
            let res = toast
                .on_activated(move |action| {
                    let a = a.clone();
                    let thread = thread.clone();
                    match action.as_deref() {
                        Some("markread") => {
                            tauri::async_runtime::spawn(async move {
                                let _ = crate::commands::set_read(&a, vec![thread], true).await;
                            });
                        }
                        Some("reply") => {
                            crate::platform::show_main(&a);
                            let _ = a.emit("reply-thread", thread);
                        }
                        _ => {
                            crate::platform::show_main(&a);
                            let _ = a.emit("open-thread", thread);
                        }
                    }
                    Ok(())
                })
                .show();
            if let Err(e) = res {
                log::warn!("toast failed: {e}");
            }
        }
    }
}

/// A sign-in / confirmation code email: the code is the headline, with Copy and Mark as read.
#[cfg(windows)]
fn code_toast(app: &AppHandle, m: &StoredMessage, code: &str) {
    use tauri_winrt_notification::{IconCrop, Toast};
    let st = state(app);
    let a = app.clone();
    let thread = m.thread_id.clone();
    let copy = code.to_string();
    let mut toast = Toast::new(&app_id(app))
        .title(&format!("Code {code}"))
        .text1(&truncate(&m.from.display(), 60))
        .text2(&truncate(if m.subject.is_empty() { "(no subject)" } else { &m.subject }, 90))
        .add_button("Copy code", "copy")
        .add_button("Mark as read", "markread");
    if let Some(p) = crate::protocols::cached_avatar_path(&st, &m.from.email) {
        toast = toast.icon(&p, IconCrop::Circular, "");
    }
    let res = toast
        .on_activated(move |action| {
            let a = a.clone();
            let thread = thread.clone();
            match action.as_deref() {
                Some("copy") => match arboard::Clipboard::new().and_then(|mut c| c.set_text(copy.clone())) {
                    Ok(()) => log::info!("copied a code from a notification"),
                    Err(e) => log::warn!("couldn't copy the code: {e}"),
                },
                Some("markread") => {
                    tauri::async_runtime::spawn(async move {
                        let _ = crate::commands::set_read(&a, vec![thread], true).await;
                    });
                }
                _ => {
                    crate::platform::show_main(&a);
                    let _ = a.emit("open-thread", thread);
                }
            }
            Ok(())
        })
        .show();
    if let Err(e) = res {
        log::warn!("toast failed: {e}");
    }
}

pub fn snooze_back(app: &AppHandle, threads: &[ThreadSummary]) {
    if !state(app).db.settings().notifications {
        return;
    }
    for t in threads.iter().take(3) {
        #[cfg(windows)]
        {
            use tauri_winrt_notification::Toast;
            let a = app.clone();
            let id = t.thread_id.clone();
            let _ = Toast::new(&app_id(app))
                .title("Back from snooze")
                .text1(&truncate(if t.subject.is_empty() { "(no subject)" } else { &t.subject }, 90))
                .on_activated(move |_| {
                    crate::platform::show_main(&a);
                    let _ = a.emit("open-thread", id.clone());
                    Ok(())
                })
                .show();
        }
    }
}

pub fn no_reply(app: &AppHandle, it: &crate::home::HomeItem) {
    if !state(app).db.settings().notifications {
        return;
    }
    #[cfg(windows)]
    {
        use tauri_winrt_notification::Toast;
        let a = app.clone();
        let thread = it.thread_id.clone();
        let who = if it.name.is_empty() { it.email.clone() } else { it.name.clone() };
        let _ = Toast::new(&app_id(app))
            .title(&format!("No reply yet from {}", truncate(&who, 40)))
            .text1(&truncate(if it.subject.is_empty() { "(no subject)" } else { &it.subject }, 90))
            .text2("Sent 3 days ago. Follow up?")
            .on_activated(move |_| {
                crate::platform::show_main(&a);
                let _ = a.emit("open-thread", thread.clone());
                Ok(())
            })
            .show();
    }
}
