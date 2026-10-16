//! Calendar invite replies (iTIP METHOD:REPLY), understood by Google Calendar and Outlook.

use anyhow::{anyhow, Result};
use mail_builder::headers::address::Address as MbAddress;
use mail_builder::mime::MimePart;
use mail_builder::MessageBuilder;

/// Unfold RFC 5545 content lines (continuations start with a space or tab).
pub fn unfold(ics: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in ics.lines() {
        if (line.starts_with(' ') || line.starts_with('\t')) && !out.is_empty() {
            out.last_mut().unwrap().push_str(&line[1..]);
        } else {
            out.push(line.trim_end_matches('\r').to_string());
        }
    }
    out
}

/// Lines of the first VEVENT.
fn event_lines(lines: &[String]) -> Vec<&String> {
    let mut inside = false;
    let mut out = Vec::new();
    for l in lines {
        if l.eq_ignore_ascii_case("BEGIN:VEVENT") {
            inside = true;
            continue;
        }
        if l.eq_ignore_ascii_case("END:VEVENT") {
            break;
        }
        if inside {
            out.push(l);
        }
    }
    out
}

fn prop<'a>(ev: &[&'a String], name: &str) -> Option<&'a String> {
    ev.iter()
        .find(|l| {
            let key = l.split([':', ';']).next().unwrap_or("");
            key.eq_ignore_ascii_case(name)
        })
        .copied()
}

fn value(line: &str) -> &str {
    // Value is after the first ':' that isn't inside a quoted parameter.
    let mut inq = false;
    for (i, ch) in line.char_indices() {
        match ch {
            '"' => inq = !inq,
            ':' if !inq => return &line[i + 1..],
            _ => {}
        }
    }
    ""
}

pub fn build_reply(ics: &str, me: &str, my_name: &str, partstat: &str) -> Result<(String, String, String)> {
    let lines = unfold(ics);
    let ev = event_lines(&lines);
    let uid = prop(&ev, "UID").ok_or_else(|| anyhow!("Invite has no UID"))?;
    let organizer = prop(&ev, "ORGANIZER").ok_or_else(|| anyhow!("Invite has no organizer"))?;
    let organizer_email = value(organizer).trim_start_matches("mailto:").trim_start_matches("MAILTO:").to_string();
    let summary = prop(&ev, "SUMMARY").map(|l| value(l).to_string()).unwrap_or_default();
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let cn = if my_name.is_empty() { String::new() } else { format!(";CN=\"{}\"", my_name.replace('"', "")) };

    let mut out = vec![
        "BEGIN:VCALENDAR".to_string(),
        "PRODID:-//Post//Mail//EN".into(),
        "VERSION:2.0".into(),
        "METHOD:REPLY".into(),
        "BEGIN:VEVENT".into(),
        uid.clone(),
        format!("DTSTAMP:{stamp}"),
    ];
    for key in ["DTSTART", "DTEND", "DURATION", "SEQUENCE", "RECURRENCE-ID", "SUMMARY"] {
        if let Some(l) = prop(&ev, key) {
            out.push(l.clone());
        }
    }
    out.push(organizer.clone());
    out.push(format!("ATTENDEE;PARTSTAT={partstat}{cn}:mailto:{me}"));
    out.push("END:VEVENT".into());
    out.push("END:VCALENDAR".into());
    Ok((out.join("\r\n") + "\r\n", organizer_email, summary))
}

pub fn reply_mime(me: &str, my_name: &str, organizer: &str, summary: &str, partstat: &str, reply_ics: String) -> Result<Vec<u8>> {
    let verb = match partstat {
        "ACCEPTED" => "Accepted",
        "TENTATIVE" => "Tentatively accepted",
        _ => "Declined",
    };
    let who = if my_name.is_empty() { me.to_string() } else { my_name.to_string() };
    let text = format!("{who} has {} this invitation.", verb.to_lowercase());
    let from = MbAddress::new_address(if my_name.is_empty() { None } else { Some(my_name.to_string()) }, me.to_string());
    let body = MimePart::new(
        "multipart/alternative",
        vec![
            MimePart::new("text/plain", text),
            MimePart::new(
                mail_builder::headers::content_type::ContentType::new("text/calendar")
                    .attribute("method", "REPLY")
                    .attribute("charset", "utf-8"),
                reply_ics,
            ),
        ],
    );
    let mb = MessageBuilder::new()
        .from(from)
        .to(MbAddress::new_address(None::<String>, organizer.to_string()))
        .subject(format!("{verb}: {summary}"))
        .body(body);
    Ok(mb.write_to_vec()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_reply() {
        let ics = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:abc123@google.com\r\nDTSTART;TZID=America/New_York:20261020T150000\r\nDTEND;TZID=America/New_York:20261020T160000\r\nSUMMARY:Design re\r\n view\r\nORGANIZER;CN=\"Maya: Chen\":mailto:maya@x.com\r\nSEQUENCE:0\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let (reply, org, summary) = build_reply(ics, "me@y.com", "Alex", "ACCEPTED").unwrap();
        assert_eq!(org, "maya@x.com");
        assert_eq!(summary, "Design review");
        assert!(reply.contains("METHOD:REPLY"));
        assert!(reply.contains("UID:abc123@google.com"));
        assert!(reply.contains("ATTENDEE;PARTSTAT=ACCEPTED;CN=\"Alex\":mailto:me@y.com"));
        assert!(reply.contains("DTSTART;TZID=America/New_York:20261020T150000"));
        let raw = reply_mime("me@y.com", "Alex", &org, &summary, "ACCEPTED", reply).unwrap();
        let s = String::from_utf8_lossy(&raw);
        assert!(s.contains("text/calendar") && s.contains("method=") && s.contains("Accepted: Design review"), "{s}");
    }
}
