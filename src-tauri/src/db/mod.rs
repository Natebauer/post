//! Post's local mailbox: a SQLite database (with a full-text index), split by area.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use crate::types::*;

mod mailbox;
mod outbox;
mod people;
mod rows;
mod schema;
mod search;
#[cfg(test)]
mod tests;

pub(crate) use rows::*;
pub(crate) use schema::*;
pub(crate) use search::*;

pub struct Db {
    pub w: Mutex<Connection>,
    /// A few read-only connections, so a slow read (search, a big thread) doesn't hold up others.
    pub r: ReadPool,
}

/// Read connections handed out to whoever asks: a free one if there is one, otherwise wait.
pub struct ReadPool {
    conns: Vec<Mutex<Connection>>,
    next: std::sync::atomic::AtomicUsize,
}

impl ReadPool {
    pub fn lock(&self) -> std::sync::LockResult<std::sync::MutexGuard<'_, Connection>> {
        let n = self.conns.len();
        let start = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        for i in 0..n {
            if let Ok(g) = self.conns[(start + i) % n].try_lock() {
                return Ok(g);
            }
        }
        self.conns[start % n].lock()
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn compress(s: &str) -> Vec<u8> {
    zstd::bulk::compress(s.as_bytes(), 6).unwrap_or_default()
}

pub fn decompress(b: &[u8]) -> String {
    zstd::stream::decode_all(b)
        .map(|v| String::from_utf8_lossy(&v).into_owned())
        .unwrap_or_default()
}

fn labels_str(labels: &[String]) -> String {
    format!(",{},", labels.join(","))
}

pub fn labels_vec(s: &str) -> Vec<String> {
    s.split(',').filter(|x| !x.is_empty()).map(String::from).collect()
}

fn has_label(labels: &str, l: &str) -> bool {
    labels.contains(&format!(",{},", l))
}

fn addrs_json(a: &[Address]) -> String {
    serde_json::to_string(a).unwrap_or_else(|_| "[]".into())
}

pub fn addrs_from(s: &str) -> Vec<Address> {
    serde_json::from_str(s).unwrap_or_default()
}
