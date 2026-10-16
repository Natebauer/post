//! Claude: settings, categories, Ask your inbox and the tone check.

use super::*;

// ---------------- AI ----------------

#[tauri::command]
pub fn ai_status(st: St<'_>) -> crate::ai::AiStatus {
    crate::ai::status(&st)
}

#[tauri::command]
pub fn set_ai_key(st: St<'_>, key: String) -> R<crate::ai::AiStatus> {
    let k = key.trim();
    if !k.starts_with("sk-ant-") || k.len() < 20 {
        return err("That doesn't look like an Anthropic API key. Keys start with \"sk-ant-\".");
    }
    crate::ai::set_api_key(k)?;
    Ok(crate::ai::status(&st))
}

#[tauri::command]
pub fn clear_ai_key(st: St<'_>) -> crate::ai::AiStatus {
    crate::ai::clear_api_key();
    crate::ai::status(&st)
}

#[tauri::command]
pub async fn test_ai(st: St<'_>) -> R<String> {
    Ok(crate::ai::test(&st).await?)
}

// ---------------- sidebar sections / AI categories ----------------

#[tauri::command]
pub async fn ai_describe_category(st: St<'_>, thread_ids: Vec<String>) -> R<crate::ai::CategoryIdea> {
    Ok(crate::ai::describe_category(&st, &thread_ids).await?)
}

/// Put conversations in (or take them out of) a category yourself; Claude learns from these.
#[tauri::command]
pub fn category_mark(app: AppHandle, st: St<'_>, section_id: String, thread_ids: Vec<String>, member: bool) -> R<()> {
    let items: Vec<(String, bool)> = thread_ids.into_iter().map(|t| (t, member)).collect();
    st.db.cat_set(&section_id, &items, true)?;
    crate::state::emit_changed(&app);
    Ok(())
}

/// Sort recent mail into a category in the background (after creating it or editing its
/// description). `reset` forgets Claude's earlier verdicts but keeps your own examples.
#[tauri::command]
pub fn category_classify(app: AppHandle, st: St<'_>, section_id: String, reset: bool) -> R<()> {
    if reset {
        st.db.cat_reset_auto(&section_id)?;
    }
    tauri::async_runtime::spawn(async move {
        let st = state(&app);
        let Some(section) = st.db.settings().sender_views.into_iter().find(|v| v.key() == section_id) else { return };
        let mut total = 0;
        // Up to 300 recent conversations, reporting progress as it goes.
        while total < 300 {
            match crate::ai::classify_category(&st, &section, 45).await {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    crate::state::emit_changed(&app);
                }
                Err(e) => {
                    log::warn!("sorting into '{}' stopped: {e}", section.name);
                    break;
                }
            }
        }
        log::info!("sorted {total} conversations for category '{}'", section.name);
    });
    Ok(())
}

// ---------------- ask your inbox / tone check ----------------

/// Summarize one conversation (empty history) or answer a follow-up about it.
#[tauri::command]
pub async fn ask_thread(st: St<'_>, thread_id: String, history: Vec<crate::ai::AskTurn>) -> R<String> {
    Ok(crate::ai::ask_thread(&st, &thread_id, &history).await?)
}

/// A question or an instruction typed into the assistant (see `ai::command`).
#[tauri::command]
pub async fn ai_command(st: St<'_>, request: String) -> R<crate::ai::CommandResult> {
    Ok(crate::ai::command(&st, request.trim()).await?)
}

#[tauri::command]
pub async fn ask_inbox(st: St<'_>, question: String) -> R<crate::ai::AskAnswer> {
    Ok(crate::ai::ask(&st, question.trim()).await?)
}

/// Do something with one email: draft a reply, answer its invitations, or answer a question.
#[tauri::command]
pub async fn ai_assist(st: St<'_>, thread_id: String, instruction: String, invites: String) -> R<crate::ai::AssistPlan> {
    Ok(crate::ai::assist(&st, &thread_id, &instruction, &invites).await?)
}

#[tauri::command]
pub async fn tone_check(st: St<'_>, text: String) -> R<crate::ai::ToneNote> {
    Ok(crate::ai::tone_check(&st, &text).await?)
}
