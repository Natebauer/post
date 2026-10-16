use std::time::Duration;

use anyhow::{anyhow, Result};
use base64::Engine;
use mail_builder::headers::address::Address as MbAddress;
use mail_builder::headers::message_id::MessageId;
use mail_builder::MessageBuilder;
use once_cell::sync::Lazy;
use regex::Regex;
use tauri::{AppHandle, Emitter};

use crate::parse::html_to_text;
use crate::state::{emit_changed, state, AppState};
use crate::types::*;

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move { outbox_loop(app).await });
}

async fn outbox_loop(app: AppHandle) {
    let st = state(&app);
    let _ = st.db.outbox_reset_stuck();
    // Scheduled mail that came due while the app was closed.
    let overdue = st.db.outbox_overdue_scheduled(60_000);
    let mut overdue_left = overdue;
    loop {
        if st.auth.signed_in() {
            match st.db.outbox_claim_due() {
                Ok(items) if !items.is_empty() => {
                    for item in items {
                        let res = send_item(&st, &item).await;
                        match res {
                            Ok(()) => {
                                let _ = st.db.outbox_finish(item.id, None);
                                let _ = app.emit("outbox-sent", item.id);
                                if item.kind == "scheduled" && overdue_left > 0 {
                                    overdue_left -= 1;
                                    if overdue_left == 0 {
                                        crate::notify::simple(
                                            &app,
                                            "Scheduled mail sent",
                                            &format!(
                                                "{} scheduled email{} came due while Post was closed and {} been sent now.",
                                                overdue,
                                                if overdue == 1 { "" } else { "s" },
                                                if overdue == 1 { "has" } else { "have" }
                                            ),
                                        );
                                        let _ = app.emit("overdue-sent", overdue);
                                    }
                                }
                            }
                            Err(e) => {
                                log::warn!("send failed: {e:#}");
                                let msg = format!("{e}");
                                let _ = st.db.outbox_finish(item.id, Some(&msg));
                                let _ = app.emit("outbox-failed", serde_json::json!({ "id": item.id, "error": msg }));
                                crate::notify::simple(
                                    &app,
                                    "Couldn't send email",
                                    &format!("\u{201c}{}\u{201d}: {}", item.compose.subject, msg),
                                );
                            }
                        }
                        st.wake.notify_one();
                    }
                    let _ = app.emit("outbox-changed", ());
                    emit_changed(&app);
                }
                _ => {}
            }
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
}

async fn send_item(st: &AppState, item: &OutboxItem) -> Result<()> {
    let raw = build_mime(st, &item.compose).await?;
    st.gmail.send_raw(&raw, item.compose.thread_id.as_deref()).await?;
    if let Some(d) = &item.compose.draft_id {
        let _ = st.gmail.delete_draft(d).await;
    }
    Ok(())
}

static DATA_IMG: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"src=["']data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)["']"#).unwrap());

pub fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "txt" | "log" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "ics" => "text/calendar",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn mb_list(list: &[Address]) -> MbAddress<'static> {
    MbAddress::new_list(
        list.iter()
            .map(|a| {
                MbAddress::new_address(
                    if a.name.trim().is_empty() { None } else { Some(a.name.clone()) },
                    a.email.clone(),
                )
            })
            .collect(),
    )
}

fn msg_ids(s: &str) -> Vec<String> {
    s.split(|c: char| c.is_whitespace() || c == ',')
        .map(|x| x.trim().trim_start_matches('<').trim_end_matches('>').to_string())
        .filter(|x| !x.is_empty())
        .collect()
}

pub async fn build_mime(st: &AppState, c: &ComposeData) -> Result<Vec<u8>> {
    let settings = st.db.settings();
    let me = st.db.my_email();
    if me.is_empty() {
        return Err(anyhow!("Not signed in"));
    }

    let mut files: Vec<(String, String, Vec<u8>)> = Vec::new();
    for a in &c.attachments {
        // Only files the user attached (copied into Post's outgoing folder) can be sent.
        if !crate::files::is_staged(st, &a.path) {
            return Err(anyhow!("{} isn't an attachment you added here. Attach it again.", a.name));
        }
        let bytes = tokio::fs::read(&a.path)
            .await
            .map_err(|e| anyhow!("Couldn't read attachment {}: {e}", a.name))?;
        files.push((mime_for(&a.name), a.name.clone(), bytes));
    }
    for f in &c.forward_attachments {
        let (bytes, mime, _) = crate::protocols::fetch_attachment(st, &f.message_id, &f.part_id).await?;
        let mime = if f.mime_type.is_empty() { mime } else { f.mime_type.clone() };
        files.push((mime, f.filename.clone(), bytes));
    }

    assemble(&me, &settings.display_name, c, files)
}

/// Build the RFC 5322 message. Pure, so it can be tested without a backend.
pub fn assemble(me: &str, display_name: &str, c: &ComposeData, files: Vec<(String, String, Vec<u8>)>) -> Result<Vec<u8>> {
    // Pull pasted images out of the HTML into cid: inline parts.
    let mut inlines: Vec<(String, String, Vec<u8>)> = Vec::new();
    let html = DATA_IMG
        .replace_all(&c.html, |caps: &regex::Captures| {
            let mime = caps[1].to_string();
            let data: String = caps[2].chars().filter(|c| !c.is_whitespace()).collect();
            match base64::engine::general_purpose::STANDARD.decode(data) {
                Ok(bytes) => {
                    let cid = format!("img{}.{}@post", inlines.len() + 1, crate::db::now_ms());
                    inlines.push((mime, cid.clone(), bytes));
                    format!("src=\"cid:{cid}\"")
                }
                Err(_) => caps[0].to_string(),
            }
        })
        .into_owned();
    let html = format!(
        "<div style=\"font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.5;\">{html}</div>"
    );
    let text = html_to_text(&html);

    let from = match &c.from {
        Some(f) if !f.email.is_empty() => MbAddress::new_address(
            if f.name.trim().is_empty() { None } else { Some(f.name.clone()) },
            f.email.clone(),
        ),
        _ => MbAddress::new_address(
            if display_name.trim().is_empty() { None } else { Some(display_name.to_string()) },
            me.to_string(),
        ),
    };
    let mut mb = MessageBuilder::new().from(from).subject(c.subject.clone());
    if !c.to.is_empty() {
        mb = mb.to(mb_list(&c.to));
    }
    if !c.cc.is_empty() {
        mb = mb.cc(mb_list(&c.cc));
    }
    if !c.bcc.is_empty() {
        mb = mb.bcc(mb_list(&c.bcc));
    }
    if let Some(irt) = &c.in_reply_to {
        let ids = msg_ids(irt);
        if !ids.is_empty() {
            mb = mb.in_reply_to(MessageId::new_list(ids.into_iter()));
        }
    }
    if let Some(r) = &c.references {
        let ids = msg_ids(r);
        if !ids.is_empty() {
            mb = mb.references(MessageId::new_list(ids.into_iter()));
        }
    }
    mb = mb.html_body(html).text_body(text);
    for (mime, cid, bytes) in inlines {
        mb = mb.inline(mime, cid, bytes);
    }
    for (mime, name, bytes) in files {
        mb = mb.attachment(mime, name, bytes);
    }
    Ok(mb.write_to_vec()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_reply_with_inline_image_and_attachment() {
        let c = ComposeData {
            to: vec![Address { name: "Jane Doe".into(), email: "jane@x.com".into() }],
            cc: vec![Address { name: String::new(), email: "bob@y.com".into() }],
            subject: "Re: Plans".into(),
            html: "<p>Sounds good</p><p><img src=\"data:image/png;base64,iVBORw0KGgo=\"></p>".into(),
            in_reply_to: Some("<abc@x.com>".into()),
            references: Some("<root@x.com> <abc@x.com>".into()),
            ..Default::default()
        };
        let raw = assemble("me@gmail.com", "Alex", &c, vec![("application/pdf".into(), "a.pdf".into(), b"%PDF".to_vec())]).unwrap();
        let s = String::from_utf8_lossy(&raw);
        assert!(s.contains("From: \"Alex\" <me@gmail.com>") || s.contains("From: Alex <me@gmail.com>"), "{s}");
        assert!(s.contains("Jane Doe") && s.contains("<jane@x.com>"));
        assert!(s.contains("Cc: <bob@y.com>") || s.contains("Cc: bob@y.com"), "{s}");
        assert!(s.contains("In-Reply-To: <abc@x.com>"), "{s}");
        assert!(s.contains("References: <root@x.com>"), "{s}");
        assert!(s.contains("cid:img1."), "data: image replaced by cid");
        assert!(!s.contains("data:image/png"));
        assert!(s.contains("Content-ID: <img1."));
        assert!(s.contains("a.pdf"));
        assert!(s.contains("text/plain") && s.contains("text/html"));
    }
}
