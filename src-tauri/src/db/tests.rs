use super::*;

fn msg(id: &str, thread: &str, date: i64, from: &str, labels: &[&str], subject: &str, body: &str) -> StoredMessage {
    StoredMessage {
        id: id.into(),
        thread_id: thread.into(),
        internal_date: date,
        from: Address { name: from.split('@').next().unwrap().into(), email: from.into() },
        to: vec![Address { name: String::new(), email: "me@example.com".into() }],
        subject: subject.into(),
        snippet: body.chars().take(40).collect(),
        labels: labels.iter().map(|s| s.to_string()).collect(),
        text_body: body.into(),
        html_body: Some(format!("<p>{body}</p>")),
        ..Default::default()
    }
}

fn open() -> Db {
    static N: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("post-test-{}-{}-{n}", std::process::id(), now_ms()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::open(&dir.join("t.db")).unwrap();
    db.kv_set("email", "me@example.com").unwrap();
    db
}

#[test]
fn store_list_search_and_labels() {
    let db = open();
    let now = now_ms();
    db.store_messages(
        &[
            msg("m1", "t1", now - 3000, "alice@acme.com", &["INBOX", "UNREAD"], "Budget report", "Quarterly numbers attached"),
            msg("m2", "t1", now - 2000, "me@example.com", &["SENT"], "Re: Budget report", "Thanks, looks good"),
            msg("m3", "t2", now - 1000, "news@shop.com", &["INBOX"], "Big sale", "Everything is half off"),
            msg("m4", "t3", now - 500, "spammer@bad.biz", &["SPAM", "UNREAD"], "You won", "Claim prize"),
        ],
        true,
    )
    .unwrap();

    let (inbox, total) = db.list_threads("INBOX", 0, 50).unwrap();
    assert_eq!(total, 2);
    assert_eq!(inbox[0].thread_id, "t2", "newest first");
    let t1 = inbox.iter().find(|t| t.thread_id == "t1").unwrap();
    assert!(t1.unread);
    assert_eq!(t1.count, 2);
    assert_eq!(t1.avatar_email, "alice@acme.com");
    assert_eq!(db.inbox_unread(), 1);
    assert_eq!(db.list_threads("SENT", 0, 50).unwrap().1, 1);
    assert_eq!(db.list_threads("SPAM", 0, 50).unwrap().1, 1);

    // Search: free text, operators, and spam exclusion
    let r = db.search_local(&parse_query("budget"), 50).unwrap();
    assert_eq!(r, vec!["t1".to_string()]);
    let r = db.search_local(&parse_query("from:alice@acme.com"), 50).unwrap();
    assert_eq!(r, vec!["t1".to_string()]);
    assert!(db.search_local(&parse_query("prize"), 50).unwrap().is_empty());
    assert_eq!(db.search_local(&parse_query("prize in:spam"), 50).unwrap().len(), 1);
    assert_eq!(db.search_local(&parse_query("is:unread"), 50).unwrap(), vec!["t1".to_string()]);

    // Mark read, then trash
    db.modify_thread_labels(&["t1".into()], &[], &["UNREAD"]).unwrap();
    assert_eq!(db.inbox_unread(), 0);
    db.modify_thread_labels(&["t2".into()], &["TRASH"], &["INBOX"]).unwrap();
    assert_eq!(db.list_threads("INBOX", 0, 50).unwrap().1, 1);
    assert_eq!(db.list_threads("TRASH", 0, 50).unwrap().1, 1);

    // Re-storing a message keeps FTS consistent (contentless delete)
    db.store_messages(&[msg("m3", "t2", now - 1000, "news@shop.com", &["INBOX"], "Big sale", "Everything is half off")], true)
        .unwrap();
    assert_eq!(db.search_local(&parse_query("half"), 50).unwrap().len(), 1);

    // History label replacement + deletion
    db.set_labels(&[("m3".into(), vec!["INBOX".into(), "UNREAD".into()])]).unwrap();
    assert_eq!(db.inbox_unread(), 1);
    db.delete_messages(&["m3".into()]).unwrap();
    assert_eq!(db.list_threads("INBOX", 0, 50).unwrap().1, 1);
    assert!(db.search_local(&parse_query("half"), 50).unwrap().is_empty());

    // Thread detail decompresses bodies
    let msgs = db.thread_messages("t1", "INBOX").unwrap();
    assert_eq!(msgs.len(), 2);
    assert!(msgs[0].0.text.contains("Quarterly"));
    assert!(msgs[0].0.html.as_deref().unwrap().contains("<p>"));

    // Autocomplete learns from sent mail
    let s = db.suggest_contacts("me", 5).unwrap();
    assert!(s.iter().all(|c| c.email != "me@example.com"));
}

#[test]
fn imports_redirected_copy_once() {
    let root = std::env::temp_dir().join(format!("post-import-{}-{}", std::process::id(), now_ms()));
    let id = "app.post.mail.test";
    let pkg = root.join("Local").join("Packages").join("Claude_x").join("LocalCache").join("Roaming").join(id);
    let real = root.join("Roaming").join(id);
    std::fs::create_dir_all(&pkg).unwrap();
    std::fs::create_dir_all(&real).unwrap();
    {
        let src = Db::open(&pkg.join("mail.db")).unwrap();
        src.kv_set("client_id", "abc.apps.googleusercontent.com").unwrap();
        src.kv_set("email", "me@example.com").unwrap();
    }
    // A fresh, unconfigured database in the real folder (what a normal launch creates).
    drop(Db::open(&real.join("mail.db")).unwrap());
    std::env::set_var("LOCALAPPDATA", root.join("Local"));
    let from = import_redirected_copy(&real, id).unwrap();
    assert!(from.is_some(), "should import");
    let db = Db::open(&real.join("mail.db")).unwrap();
    assert_eq!(db.kv_get("email").as_deref(), Some("me@example.com"));
    drop(db);
    // Already configured: no second import.
    assert!(import_redirected_copy(&real, id).unwrap().is_none());
}

#[test]
fn snooze_and_outbox() {
    let db = open();
    let now = now_ms();
    db.store_messages(&[msg("m1", "t1", now, "bob@x.com", &["INBOX"], "Hi", "Hello")], false).unwrap();
    db.snooze("t1", now + 3_600_000).unwrap();
    assert_eq!(db.list_threads("INBOX", 0, 10).unwrap().1, 0);
    assert_eq!(db.list_threads("SNOOZED", 0, 10).unwrap().1, 1);
    db.unsnooze("t1", true).unwrap();
    assert_eq!(db.list_threads("INBOX", 0, 10).unwrap().1, 1);

    let c = ComposeData { subject: "Later".into(), ..Default::default() };
    let id = db.outbox_add(&c, now - 1, "scheduled").unwrap();
    let due = db.outbox_claim_due().unwrap();
    assert_eq!(due.len(), 1);
    assert!(db.outbox_claim_due().unwrap().is_empty(), "claimed items aren't re-sent");
    db.outbox_finish(id, Some("boom")).unwrap();
    assert_eq!(db.outbox_list().unwrap()[0].status, "failed");
    assert!(db.outbox_take(id).unwrap().is_some());
    assert!(db.outbox_list().unwrap().is_empty());
}

#[test]
fn prune_keeps_recent_html() {
    let db = open();
    let now = now_ms();
    let msgs: Vec<_> = (0..5)
        .map(|i| msg(&format!("m{i}"), &format!("t{i}"), now - i * 1000, "a@b.com", &["INBOX"], "s", &"x".repeat(5000)))
        .collect();
    db.store_messages(&msgs, true).unwrap();
    db.prune_html(2, 0).unwrap();
    let with_html: i64 = db
        .r
        .lock()
        .unwrap()
        .query_row("SELECT COUNT(*) FROM messages WHERE html_z IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(with_html, 2);
}
