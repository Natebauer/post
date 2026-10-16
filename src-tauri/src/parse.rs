use anyhow::{anyhow, Result};
use base64::Engine;
use serde_json::Value;

use crate::types::*;

pub fn b64url_decode(s: &str) -> Vec<u8> {
    let s = s.trim_end_matches('=');
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(s)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(s))
        .unwrap_or_default()
}

pub fn b64url_encode(b: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b)
}

fn header<'a>(headers: &'a [Value], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|h| h["name"].as_str().map(|n| n.eq_ignore_ascii_case(name)).unwrap_or(false))
        .and_then(|h| h["value"].as_str())
}

fn charset_of(headers: &[Value]) -> Option<String> {
    let ct = header(headers, "Content-Type")?.to_lowercase();
    let i = ct.find("charset=")?;
    let rest = &ct[i + 8..];
    let cs: String = rest
        .trim_start_matches('"')
        .chars()
        .take_while(|c| !matches!(c, '"' | ';' | ' '))
        .collect();
    Some(cs)
}

fn decode_text(bytes: &[u8], charset: Option<&str>) -> String {
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    let enc = charset
        .and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes()))
        .unwrap_or(encoding_rs::WINDOWS_1252);
    enc.decode(bytes).0.into_owned()
}

pub fn unescape_html(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        // Entities are short; look for ';' within the next 10 chars (char-safe).
        let window = rest.char_indices().nth(10).map(|(i, _)| i).unwrap_or(rest.len());
        if let Some(j) = rest[..window].find(';') {
            let ent = &rest[1..j];
            let rep = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                e if e.starts_with("#x") || e.starts_with("#X") => {
                    u32::from_str_radix(&e[2..], 16).ok().and_then(char::from_u32)
                }
                e if e.starts_with('#') => e[1..].parse::<u32>().ok().and_then(char::from_u32),
                _ => None,
            };
            if let Some(c) = rep {
                out.push(c);
                rest = &rest[j + 1..];
                continue;
            }
        }
        out.push('&');
        rest = &rest[1..];
    }
    out.push_str(rest);
    out
}

/// Parse an RFC 5322 address list ("A <a@x>, \"B, C\" <b@x>, c@x").
pub fn parse_addresses(s: &str) -> Vec<Address> {
    let mut out = Vec::new();
    let mut parts = Vec::new();
    let mut cur = String::new();
    let (mut inq, mut ina) = (false, false);
    for ch in s.chars() {
        match ch {
            '"' => {
                inq = !inq;
                cur.push(ch)
            }
            '<' if !inq => {
                ina = true;
                cur.push(ch)
            }
            '>' if !inq => {
                ina = false;
                cur.push(ch)
            }
            ',' | ';' if !inq && !ina => parts.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    parts.push(cur);
    for p in parts {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        if let (Some(a), Some(b)) = (p.rfind('<'), p.rfind('>')) {
            if a < b {
                let email = p[a + 1..b].trim().to_string();
                let name = p[..a].trim().trim_matches('"').trim().replace("\\\"", "\"");
                out.push(Address { name, email });
                continue;
            }
        }
        if p.contains('@') {
            out.push(Address { name: String::new(), email: p.trim_matches('"').to_string() });
        }
    }
    out
}

#[derive(Default)]
struct Walk {
    text: Option<String>,
    html: Option<String>,
    calendar: Option<String>,
    attachments: Vec<AttachmentMeta>,
}

fn walk(part: &Value, out: &mut Walk) {
    let mime = part["mimeType"].as_str().unwrap_or("").to_lowercase();
    let filename = part["filename"].as_str().unwrap_or("").to_string();
    let headers = part["headers"].as_array().cloned().unwrap_or_default();
    let body = &part["body"];
    let att_id = body["attachmentId"].as_str();

    if let Some(children) = part["parts"].as_array() {
        for c in children {
            walk(c, out);
        }
        return;
    }

    let disposition = header(&headers, "Content-Disposition").unwrap_or("").to_lowercase();

    // Inline calendar invites (text/calendar alternative part).
    if mime == "text/calendar" && out.calendar.is_none() {
        if let Some(d) = body["data"].as_str() {
            out.calendar = Some(decode_text(&b64url_decode(d), charset_of(&headers).as_deref()));
            if filename.is_empty() {
                return;
            }
        }
    }
    let is_text_body = (mime == "text/plain" || mime == "text/html")
        && filename.is_empty()
        && !disposition.starts_with("attachment");

    if is_text_body {
        let data = match body["data"].as_str() {
            Some(d) => decode_text(&b64url_decode(d), charset_of(&headers).as_deref()),
            None => return,
        };
        let slot = if mime == "text/plain" { &mut out.text } else { &mut out.html };
        match slot {
            Some(existing) => {
                existing.push_str("\n");
                existing.push_str(&data);
            }
            None => *slot = Some(data),
        }
        return;
    }

    if let Some(att) = att_id {
        let content_id = header(&headers, "Content-ID")
            .map(|c| c.trim().trim_start_matches('<').trim_end_matches('>').to_string());
        let inline = content_id.is_some() && !disposition.starts_with("attachment");
        let filename = if filename.is_empty() {
            match &content_id {
                Some(c) => c.clone(),
                None => "attachment".into(),
            }
        } else {
            filename
        };
        out.attachments.push(AttachmentMeta {
            filename,
            mime_type: mime,
            size: body["size"].as_i64().unwrap_or(0),
            attachment_id: att.to_string(),
            part_id: part["partId"].as_str().unwrap_or("").to_string(),
            content_id,
            inline,
        });
    }
}

pub fn html_to_text(html: &str) -> String {
    // html2text can be slow on giant newsletters; cap input.
    let src = if html.len() > 400_000 { &html[..floor_char(html, 400_000)] } else { html };
    // html2text has panicked on pathological markup; never let one email stop sync.
    std::panic::catch_unwind(|| html2text::from_read(src.as_bytes(), 100)).unwrap_or_else(|_| {
        let re = regex::Regex::new(r"(?s)<style.*?</style>|<script.*?</script>|<[^>]+>").unwrap();
        unescape_html(&re.replace_all(src, " "))
    })
}

fn floor_char(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Convert a Gmail API message resource (format=full) into a StoredMessage.
pub fn parse_message(v: &Value) -> Result<StoredMessage> {
    let id = v["id"].as_str().ok_or_else(|| anyhow!("message without id"))?.to_string();
    let payload = &v["payload"];
    let headers = payload["headers"].as_array().cloned().unwrap_or_default();
    let mut w = Walk::default();
    walk(payload, &mut w);

    let text_body = match (&w.text, &w.html) {
        (Some(t), _) if !t.trim().is_empty() => t.clone(),
        (_, Some(h)) => html_to_text(h),
        _ => String::new(),
    };
    // Plain-text-only mail: we still render nicely from text; no html stored.
    let h = |n: &str| header(&headers, n).unwrap_or("").to_string();
    let list_unsub = h("List-Unsubscribe");
    let list_unsub_post = h("List-Unsubscribe-Post").to_lowercase().contains("one-click");

    Ok(StoredMessage {
        id,
        thread_id: v["threadId"].as_str().unwrap_or("").to_string(),
        internal_date: v["internalDate"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        from: parse_addresses(&h("From")).into_iter().next().unwrap_or_default(),
        to: parse_addresses(&h("To")),
        cc: parse_addresses(&h("Cc")),
        bcc: parse_addresses(&h("Bcc")),
        reply_to: parse_addresses(&h("Reply-To")),
        subject: h("Subject"),
        snippet: unescape_html(v["snippet"].as_str().unwrap_or("")),
        labels: v["labelIds"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        attachments: w.attachments,
        text_body,
        html_body: w.html,
        message_id_header: h("Message-ID")
            .trim()
            .trim_start_matches('<')
            .trim_end_matches('>')
            .to_string(),
        in_reply_to: h("In-Reply-To"),
        references: h("References"),
        list_unsubscribe: list_unsub,
        list_unsubscribe_post: list_unsub_post,
        calendar: w.calendar,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        let a = parse_addresses("\"Doe, Jane\" <jane@x.com>, bob@y.org, Al <al@z.io>");
        assert_eq!(a.len(), 3);
        assert_eq!(a[0].name, "Doe, Jane");
        assert_eq!(a[0].email, "jane@x.com");
        assert_eq!(a[1].email, "bob@y.org");
        assert_eq!(a[2].name, "Al");
    }

    #[test]
    fn entities() {
        assert_eq!(unescape_html("Tom&#39;s &amp; &quot;x&quot; &lt;3"), "Tom's & \"x\" <3");
        assert_eq!(unescape_html("a & b"), "a & b");
        // Multi-byte characters right after '&' must not split a char boundary.
        assert_eq!(unescape_html("R&D — “quoted” ✨ done"), "R&D — “quoted” ✨ done");
        assert_eq!(unescape_html("&a—————"), "&a—————");
    }

    #[test]
    fn gmail_payload() {
        let text = b64url_encode("Hi there\nSee attached".as_bytes());
        let html = b64url_encode("<p>Hi there</p><img src=\"cid:logo1\">".as_bytes());
        let v = serde_json::json!({
            "id": "abc", "threadId": "th", "labelIds": ["INBOX", "UNREAD"],
            "snippet": "Hi there &amp; welcome", "internalDate": "1700000000000",
            "payload": {
                "mimeType": "multipart/mixed",
                "headers": [
                    {"name": "From", "value": "\"Doe, Jane\" <jane@x.com>"},
                    {"name": "To", "value": "me@y.com, Bob <bob@z.com>"},
                    {"name": "Subject", "value": "Hello"},
                    {"name": "Message-ID", "value": "<id123@x.com>"},
                    {"name": "List-Unsubscribe", "value": "<https://x.com/u>, <mailto:u@x.com>"},
                    {"name": "List-Unsubscribe-Post", "value": "List-Unsubscribe=One-Click"}
                ],
                "parts": [
                    {"partId": "0", "mimeType": "multipart/alternative", "filename": "", "parts": [
                        {"partId": "0.0", "mimeType": "text/plain", "filename": "", "headers": [], "body": {"data": text}},
                        {"partId": "0.1", "mimeType": "text/html", "filename": "", "headers": [], "body": {"data": html}}
                    ]},
                    {"partId": "1", "mimeType": "image/png", "filename": "logo.png",
                     "headers": [{"name": "Content-ID", "value": "<logo1>"}, {"name": "Content-Disposition", "value": "inline"}],
                     "body": {"attachmentId": "att1", "size": 1200}},
                    {"partId": "2", "mimeType": "application/pdf", "filename": "report.pdf",
                     "headers": [{"name": "Content-Disposition", "value": "attachment; filename=report.pdf"}],
                     "body": {"attachmentId": "att2", "size": 50000}}
                ]
            }
        });
        let m = parse_message(&v).unwrap();
        assert_eq!(m.from.email, "jane@x.com");
        assert_eq!(m.from.name, "Doe, Jane");
        assert_eq!(m.to.len(), 2);
        assert_eq!(m.snippet, "Hi there & welcome");
        assert_eq!(m.text_body, "Hi there\nSee attached");
        assert!(m.html_body.unwrap().contains("cid:logo1"));
        assert_eq!(m.attachments.len(), 2);
        assert!(m.attachments[0].inline);
        assert_eq!(m.attachments[0].content_id.as_deref(), Some("logo1"));
        assert!(!m.attachments[1].inline);
        assert_eq!(m.message_id_header, "id123@x.com");
        assert!(m.list_unsubscribe_post);
        assert_eq!(m.internal_date, 1_700_000_000_000);
    }

    #[test]
    fn query() {
        let q = crate::db::parse_query("from:alice@x.com has:attachment budget report");
        assert!(q.has_attachment);
        assert!(q.fts.contains("sender : \"alice@x.com\""));
        assert!(q.fts.contains("\"budget\"*"));
    }
}
