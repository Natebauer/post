use tauri::{AppHandle, Emitter, Manager};

use crate::types::{Address, ComposeData};

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn update_tray_tooltip(app: &AppHandle, unread: i64) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = match unread {
            0 => "Post".to_string(),
            1 => "Post: 1 unread".to_string(),
            n => format!("Post: {n} unread"),
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

pub fn set_overlay(app: &AppHandle, png: Option<Vec<u8>>) -> anyhow::Result<()> {
    if let Some(w) = app.get_webview_window("main") {
        match png {
            Some(bytes) => {
                let img = tauri::image::Image::from_bytes(&bytes)?;
                w.set_overlay_icon(Some(img))?;
            }
            None => w.set_overlay_icon(None)?,
        }
    }
    Ok(())
}

/// Parse a mailto: URL into compose fields.
pub fn parse_mailto(url: &str) -> Option<ComposeData> {
    let rest = url.strip_prefix("mailto:").or_else(|| url.strip_prefix("MAILTO:"))?;
    let (addr, query) = rest.split_once('?').unwrap_or((rest, ""));
    let dec = |s: &str| urlencoding::decode(&s.replace('+', "%20")).map(|c| c.into_owned()).unwrap_or_default();
    let addrs = |s: &str| -> Vec<Address> {
        crate::parse::parse_addresses(&dec(s))
    };
    let mut c = ComposeData { to: addrs(addr), ..Default::default() };
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        match k.to_lowercase().as_str() {
            "to" => c.to.extend(addrs(v)),
            "cc" => c.cc = addrs(v),
            "bcc" => c.bcc = addrs(v),
            "subject" => c.subject = dec(v),
            "body" => {
                let body = dec(v);
                c.html = body
                    .split('\n')
                    .map(|l| {
                        let esc = l.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
                        format!("<p>{}</p>", if esc.trim().is_empty() { "<br>".to_string() } else { esc })
                    })
                    .collect::<String>();
            }
            _ => {}
        }
    }
    Some(c)
}

pub fn handle_args(app: &AppHandle, args: &[String]) {
    if args.iter().any(|a| a == COMPOSE_ARG) {
        show_main(app);
        let _ = app.emit("compose-new", ());
        return;
    }
    if let Some(m) = args.iter().find(|a| a.to_lowercase().starts_with("mailto:")) {
        if let Some(c) = parse_mailto(m) {
            show_main(app);
            let _ = app.emit("mailto", c);
        }
    }
}

/// Register Post as a mailto: handler in HKCU so it shows up in Windows "Default apps".
#[cfg(windows)]
pub fn register_mailto() -> anyhow::Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let exe = std::env::current_exe()?.to_string_lossy().to_string();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (cls, _) = hkcu.create_subkey(r"Software\Classes\Post.Url.mailto")?;
    cls.set_value("", &"URL:MailTo Protocol")?;
    cls.set_value("URL Protocol", &"")?;
    let (icon, _) = cls.create_subkey("DefaultIcon")?;
    icon.set_value("", &format!("\"{exe}\",0"))?;
    let (cmd, _) = cls.create_subkey(r"shell\open\command")?;
    cmd.set_value("", &format!("\"{exe}\" \"%1\""))?;

    let (cap, _) = hkcu.create_subkey(r"Software\Post\Capabilities")?;
    cap.set_value("ApplicationName", &"Post")?;
    cap.set_value("ApplicationDescription", &"A calm, local Gmail client")?;
    let (urls, _) = cap.create_subkey("URLAssociations")?;
    urls.set_value("mailto", &"Post.Url.mailto")?;
    let (reg, _) = hkcu.create_subkey(r"Software\RegisteredApplications")?;
    reg.set_value("Post", &r"Software\Post\Capabilities")?;
    Ok(())
}

#[cfg(not(windows))]
pub fn register_mailto() -> anyhow::Result<()> {
    Ok(())
}

pub fn apply_autostart(app: &AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enabled {
        // Always (re)write it: an entry left from an older install can point at a post.exe that's
        // gone, and "is enabled" would still say yes, so Windows would quietly start nothing.
        let _ = m.enable();
    } else if m.is_enabled().unwrap_or(false) {
        let _ = m.disable();
    }
}

pub const COMPOSE_ARG: &str = "--compose";

/// Taskbar jump list with a "New message" task (right-click Post on the taskbar).
#[cfg(windows)]
pub fn setup_jump_list() -> anyhow::Result<()> {
    use windows::core::{Interface, HSTRING, PWSTR};
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
        let mut slots = 0u32;
        let _removed: IObjectArray = list.BeginList(&mut slots)?;
        let tasks: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;

        let exe = std::env::current_exe()?;
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.SetPath(&HSTRING::from(exe.as_os_str()))?;
        link.SetArguments(&HSTRING::from(COMPOSE_ARG))?;
        link.SetIconLocation(&HSTRING::from(exe.as_os_str()), 0)?;
        link.SetDescription(&HSTRING::from("Write a new email"))?;

        // Title is a property, set as a VT_LPWSTR PROPVARIANT owned by COM memory.
        let title: Vec<u16> = "New message".encode_utf16().chain(std::iter::once(0)).collect();
        let mem = CoTaskMemAlloc(title.len() * 2) as *mut u16;
        std::ptr::copy_nonoverlapping(title.as_ptr(), mem, title.len());
        let mut pv = PROPVARIANT::default();
        (*pv.Anonymous.Anonymous).vt = VT_LPWSTR;
        (*pv.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(mem);
        let store: IPropertyStore = link.cast()?;
        store.SetValue(&PKEY_Title, &pv)?;
        store.Commit()?;
        let _ = PropVariantClear(&mut pv);

        tasks.AddObject(&link)?;
        let arr: IObjectArray = tasks.cast()?;
        list.AddUserTasks(&arr)?;
        list.CommitList()?;
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn setup_jump_list() -> anyhow::Result<()> {
    Ok(())
}

/// Match the installer's Start Menu AppUserModelID so the taskbar, jump list and toasts agree.
#[cfg(windows)]
pub fn set_app_id(id: &str) {
    use windows::core::HSTRING;
    unsafe {
        let _ = windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(id));
    }
}

#[cfg(not(windows))]
pub fn set_app_id(_id: &str) {}
