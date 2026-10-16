//! Everything the window can ask the Rust side to do (Tauri commands), grouped by area.
//! Each area is its own file; they share the error type and helpers below.

mod app;
mod mail;
mod compose;
mod attachments;
mod platform;
mod ai;
mod home;

pub use app::*;
pub use mail::*;
pub use compose::*;
pub use attachments::*;
pub use platform::*;
pub use ai::*;
pub use home::*;

use std::collections::HashSet;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::db::{now_ms, parse_query};
use crate::parse::parse_message;
use crate::state::{emit_changed, state, AppState};
use crate::sync::fetch_many;
use crate::types::*;

type St<'a> = State<'a, std::sync::Arc<AppState>>;

#[derive(Debug)]
pub struct CmdError(String);
impl Serialize for CmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}
impl From<anyhow::Error> for CmdError {
    fn from(e: anyhow::Error) -> Self {
        CmdError(format!("{e}"))
    }
}
type R<T> = Result<T, CmdError>;

fn err<T>(m: impl Into<String>) -> R<T> {
    Err(CmdError(m.into()))
}
