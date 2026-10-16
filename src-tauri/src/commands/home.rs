//! Home and the Google Calendar.

use super::*;

// ---------------- home ----------------

#[tauri::command]
pub fn home_summary(st: St<'_>) -> R<crate::home::Home> {
    Ok(st.db.home()?)
}

#[tauri::command]
pub fn pin_thread(app: AppHandle, st: St<'_>, thread_id: String, pinned: bool) -> R<()> {
    st.db.set_pinned(&thread_id, pinned)?;
    let _ = tauri::Emitter::emit(&app, "home-changed", ());
    Ok(())
}

#[tauri::command]
pub fn is_pinned(st: St<'_>, thread_id: String) -> bool {
    st.db.is_pinned(&thread_id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalEvent {
    id: String,
    title: String,
    start: String,
    end: String,
    all_day: bool,
    location: String,
    link: String,
    calendar: String,
    color: String,
    /// A video meeting link (Zoom, Meet, Teams…), so clicking the event can join it.
    meeting: String,
}

/// The event's video meeting link: Google's conference data, a Meet link, or a meeting URL in the
/// location or description.
fn meeting_link(e: &Value) -> String {
    static URL: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r#"https?://[^\s<>"')]+"#).unwrap());
    const HOSTS: &[&str] = &["zoom.us", "meet.google.com", "teams.microsoft.com", "teams.live.com", "webex.com", "whereby.com", "gotomeeting.com", "around.co"];
    if let Some(uri) = e["conferenceData"]["entryPoints"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["entryPointType"].as_str() == Some("video"))
        .and_then(|p| p["uri"].as_str())
    {
        return uri.to_string();
    }
    if let Some(h) = e["hangoutLink"].as_str() {
        return h.to_string();
    }
    for field in ["location", "description"] {
        let text = e[field].as_str().unwrap_or("");
        if let Some(m) = URL.find_iter(text).find(|m| HOSTS.iter().any(|h| m.as_str().contains(h))) {
            return m.as_str().trim_end_matches(['.', ',']).to_string();
        }
    }
    String::new()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calendar {
    /// "ok" | "needs_permission" | "api_disabled" | "error"
    status: String,
    message: String,
    enable_url: Option<String>,
    events: Vec<CalEvent>,
}

fn calendar_error(e: &anyhow::Error) -> Calendar {
    let body = e.downcast_ref::<crate::gmail::ApiError>().map(|a| a.body.clone()).unwrap_or_default();
    let status = crate::gmail::api_status(e);
    if body.contains("SERVICE_DISABLED") || body.contains("accessNotConfigured") || body.contains("has not been used") {
        let url = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|v| {
                v["error"]["details"]
                    .as_array()
                    .and_then(|d| d.iter().find_map(|x| x["metadata"]["activationUrl"].as_str().map(String::from)))
            })
            .or_else(|| Some("https://console.cloud.google.com/apis/library/calendar-json.googleapis.com".into()));
        Calendar {
            status: "api_disabled".into(),
            message: "The Google Calendar API isn't enabled in your Cloud project yet.".into(),
            enable_url: url,
            events: vec![],
        }
    } else if status == Some(403) || status == Some(401) {
        Calendar {
            status: "needs_permission".into(),
            message: "Post needs permission to read your calendar.".into(),
            enable_url: None,
            events: vec![],
        }
    } else {
        Calendar { status: "error".into(), message: format!("{e}"), enable_url: None, events: vec![] }
    }
}

/// Events across every calendar shown in Google Calendar, shared ones included: by default
/// yesterday through the next five days; `from` (YYYY-MM-DD) and `days` for other ranges (a month).
#[tauri::command]
pub async fn calendar_upcoming(st: St<'_>, from: Option<String>, days: Option<i64>) -> R<Calendar> {
    let start = from
        .and_then(|f| chrono::NaiveDate::parse_from_str(&f, "%Y-%m-%d").ok())
        .unwrap_or_else(|| chrono::Local::now().date_naive() - chrono::Duration::days(1));
    let days = days.unwrap_or(7).clamp(1, 62);
    let calendars = match st.gmail.calendar_list().await {
        Ok(c) => c,
        Err(e) => return Ok(calendar_error(&e)),
    };
    let results = futures::future::join_all(
        calendars.iter().map(|(id, _, _)| st.gmail.calendar_events(id, start, days)),
    )
    .await;
    let mut events = Vec::new();
    let mut seen = HashSet::new();
    let mut first_err = None;
    for ((_, name, color), r) in calendars.iter().zip(results) {
        let v = match r {
            Ok(v) => v,
            Err(e) => {
                log::warn!("calendar {name} failed: {e}");
                first_err.get_or_insert(e);
                continue;
            }
        };
        for e in v["items"].as_array().into_iter().flatten() {
            if e["status"].as_str() == Some("cancelled") {
                continue;
            }
            let pick = |k: &str| e[k]["dateTime"].as_str().or_else(|| e[k]["date"].as_str()).unwrap_or("").to_string();
            // The same meeting can appear on several calendars; show it once.
            let uid = e["iCalUID"].as_str().unwrap_or(e["id"].as_str().unwrap_or("")).to_string();
            if !seen.insert(format!("{uid}|{}", pick("start"))) {
                continue;
            }
            events.push(CalEvent {
                id: e["id"].as_str().unwrap_or("").to_string(),
                title: e["summary"].as_str().unwrap_or("(No title)").to_string(),
                start: pick("start"),
                end: pick("end"),
                all_day: e["start"]["date"].is_string(),
                location: e["location"].as_str().unwrap_or("").to_string(),
                link: e["htmlLink"].as_str().unwrap_or("").to_string(),
                calendar: name.clone(),
                color: e["backgroundColor"].as_str().unwrap_or(color).to_string(),
                meeting: meeting_link(e),
            });
        }
    }
    if events.is_empty() {
        if let Some(e) = first_err {
            return Ok(calendar_error(&e));
        }
    }
    events.sort_by(|a, b| a.start.cmp(&b.start));
    Ok(Calendar { status: "ok".into(), message: String::new(), enable_url: None, events })
}
#[tauri::command]
pub async fn attachment_thumbnail(st: St<'_>, message_id: String, part_id: String) -> R<Option<String>> {
    Ok(crate::thumbs::thumbnail(&st, &message_id, &part_id).await?)
}

/// Front-end errors and diagnostics go to Post's log file.
#[tauri::command]
pub fn log_frontend(window: tauri::Window, message: String) {
    log::warn!("[ui:{}] {}", window.label(), message);
}
