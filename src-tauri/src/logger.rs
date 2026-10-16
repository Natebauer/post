//! Minimal file logger: %APPDATA%\app.post.mail\post.log (rotated at 2 MB).

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

struct FileLogger {
    path: PathBuf,
    lock: Mutex<()>,
}

impl log::Log for FileLogger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info && m.target().starts_with("post")
    }

    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let _g = self.lock.lock();
        if std::fs::metadata(&self.path).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(false) {
            let _ = std::fs::rename(&self.path, self.path.with_extension("old.log"));
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.path) {
            let _ = writeln!(
                f,
                "{} {:<5} {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                r.level(),
                r.args()
            );
        }
    }

    fn flush(&self) {}
}

pub fn init(dir: PathBuf) {
    let logger = Box::new(FileLogger { path: dir.join("post.log"), lock: Mutex::new(()) });
    if log::set_boxed_logger(logger).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
    std::panic::set_hook(Box::new(|info| {
        log::error!("panic: {info}");
    }));
}
