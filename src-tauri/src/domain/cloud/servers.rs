// @Author Christian Relf
// @Date 2026-10-21

//! Which Kern Cloud server this copy of Kern talks to.
//!
//! Kern Cloud is a server, not a service: the same code runs at the public
//! address and on somebody's own machine (the `Kern-Cloud-Self-Host`
//! repository). This module is how the app is pointed at one.
//!
//! ## Why this isn't a setting
//!
//! The session token is sent as a bearer to whatever address this returns,
//! and the request is made here in Rust, where the window's CSP doesn't
//! apply. `settings_set` takes any key from the front end, so an address
//! stored there would be a way for anything running in the webview to hand
//! the token to a host of its choosing. The list therefore lives in a file
//! only the back end writes, and three things guard it:
//!
//! 1. **`KERN_CLOUD_URL` still wins and locks the choice.** Whoever starts
//!    Kern - a managed deployment, a development run - keeps the final say,
//!    and the interface can't override it.
//! 2. **A token belongs to one origin.** The credential-store entry is keyed
//!    by host, so pointing Kern at another server doesn't carry the existing
//!    session there: the new server simply has no token and asks for a
//!    sign-in. This is the part that actually defuses the attack - even a
//!    silent switch yields nothing.
//! 3. **Adding a server asks the person, in a native dialog naming the host.**
//!    The webview can propose a server; it cannot accept one.
//!
//! ## Where a token may be sent at all
//!
//! | Address | Allowed | Why |
//! |---|---|---|
//! | `https://` anything | yes | encrypted, and the host's name is checked |
//! | `http://127.0.0.1`, `::1`, `localhost` | yes | the same machine, or an SSH tunnel to it |
//! | `http://192.168.x`, `10.x`, `.local` | yes, noted | a home or office network |
//! | `http://` a public address | no | the session would cross the internet in the clear |

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use url::{Host, Url};

/// The public Kern Cloud, used when nothing else is chosen.
pub const DEFAULT_API: &str = "https://api.relf.cc/kern/v1";

/// The credential-store entry for the default server. Entries for other
/// servers get the host appended; this one keeps the bare name so an existing
/// install stays signed in across the upgrade that added this module.
pub const DEFAULT_TOKEN_REF: &str = "kern-cloud-session";

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    /// The API base, e.g. `https://kern.example.com/kern/v1`.
    pub url: String,
    /// What to call it in the interface; the instance's own name once known.
    pub name: String,
    /// Taken from the server's `/instance` reply when it was added.
    #[serde(default)]
    pub instance_name: Option<String>,
    #[serde(default)]
    pub added_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct Store {
    #[serde(default)]
    servers: Vec<Server>,
    /// The chosen server's url, or None for the public one.
    #[serde(default)]
    selected: Option<String>,
}

/// Where the choice came from, so the interface can explain itself.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// KERN_CLOUD_URL is set: nothing in the app can change it.
    Environment,
    /// Chosen in Settings, from the list in servers.json.
    Chosen,
    /// Nothing chosen, so the public Kern Cloud.
    Default,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Active {
    pub url: String,
    pub source: Source,
    pub name: String,
}

fn store_path(data_dir: &Path) -> PathBuf {
    data_dir.join("servers.json")
}

fn read(data_dir: &Path) -> Store {
    match fs::read_to_string(store_path(data_dir)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        // A missing file is the ordinary case: nobody has added a server.
        Err(e) if e.kind() == ErrorKind::NotFound => Store::default(),
        Err(_) => Store::default(),
    }
}

fn write(data_dir: &Path, store: &Store) -> AppResult<()> {
    let text = serde_json::to_string_pretty(store).map_err(|e| AppError::Other(e.to_string()))?;
    let path = store_path(data_dir);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| AppError::Other(format!("Couldn't save the server list: {e}")))?;
    fs::rename(&tmp, &path).map_err(|e| AppError::Other(format!("Couldn't save the server list: {e}")))?;
    Ok(())
}

// ------------------------------------------------------------------ the rule

pub struct Verdict {
    /// The normalised API base.
    pub url: String,
    /// Set when the address is allowed but not encrypted.
    pub warning: Option<String>,
}

fn loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
        Host::Domain(name) => {
            let n = name.to_ascii_lowercase();
            n == "localhost" || n.ends_with(".localhost")
        }
    }
}

fn private(host: &Host<&str>) -> bool {
    match host {
        Host::Ipv4(ip) => ip.is_private() || ip.is_link_local(),
        Host::Ipv6(ip) => {
            let s = ip.segments();
            // fc00::/7 (unique local) and fe80::/10 (link local).
            (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
        Host::Domain(name) => {
            let n = name.to_ascii_lowercase();
            n.ends_with(".local") || n.ends_with(".internal") || n.ends_with(".home.arpa")
        }
    }
}

/// Normalises an address and applies the rule in the module docs.
pub fn vet(raw: &str) -> AppResult<Verdict> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("Enter the server's address.".into()));
    }
    let with_scheme = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let mut parsed = Url::parse(&with_scheme).map_err(|_| AppError::Invalid(format!("{trimmed} isn't an address Kern can use.")))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(AppError::Invalid(format!("{other}:// isn't an address Kern can use. Use https://, or http:// for a server on this machine."))),
    }
    parsed.set_query(None);
    parsed.set_fragment(None);

    let host = parsed.host().ok_or_else(|| AppError::Invalid(format!("{trimmed} has no host in it.")))?;
    let secure = parsed.scheme() == "https";
    let local = loopback(&host);
    let lan = private(&host);

    if !secure && !local && !lan {
        return Err(AppError::Invalid(format!(
            "Kern won't sign in to {} over plain HTTP: your session and everything you sync would cross the network unencrypted.\n\nUse https://, or reach the server on this machine (http://127.0.0.1:8787).",
            parsed.host_str().unwrap_or(trimmed)
        )));
    }

    let authority = match parsed.port() {
        Some(port) => format!("{}:{}", parsed.host_str().unwrap_or_default(), port),
        None => parsed.host_str().unwrap_or_default().to_string(),
    };
    let path = parsed.path().trim_end_matches('/').to_string();
    let url = if path.ends_with("/kern/v1") {
        format!("{}://{}{}", parsed.scheme(), authority, path)
    } else if path.is_empty() {
        format!("{}://{}/kern/v1", parsed.scheme(), authority)
    } else {
        format!("{}://{}{}/kern/v1", parsed.scheme(), authority, path)
    };

    let warning = if secure || local {
        None
    } else {
        Some(format!("{authority} is on a private network but not encrypted. Anyone on that network could read what you sync."))
    };
    Ok(Verdict { url, warning })
}

// ------------------------------------------------------------- what is active

fn from_env() -> Option<String> {
    std::env::var("KERN_CLOUD_URL")
        .ok()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
}

/// The server in use: the environment if it is set, otherwise the chosen one,
/// otherwise the public Kern Cloud.
pub fn active(data_dir: &Path) -> Active {
    if let Some(url) = from_env() {
        return Active { name: label(&url), url, source: Source::Environment };
    }
    let store = read(data_dir);
    match store.selected.as_deref() {
        Some(url) => {
            let name = store
                .servers
                .iter()
                .find(|s| s.url == url)
                .map(|s| s.instance_name.clone().unwrap_or_else(|| s.name.clone()))
                .unwrap_or_else(|| label(url));
            Active { url: url.to_string(), source: Source::Chosen, name }
        }
        None => Active { url: DEFAULT_API.to_string(), source: Source::Default, name: "Kern Cloud".into() },
    }
}

/// The host, for naming a server nobody has given a name to.
fn label(url: &str) -> String {
    Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_else(|| url.to_string())
}

/// The credential-store entry holding the session for one server.
///
/// Keyed by host, which is what keeps a session from following the app to a
/// different server. The public address keeps the original bare name so
/// upgrading Kern doesn't sign anybody out.
pub fn token_ref(url: &str) -> String {
    if url == DEFAULT_API {
        return DEFAULT_TOKEN_REF.to_string();
    }
    match Url::parse(url) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("unknown");
            match u.port() {
                Some(port) => format!("{DEFAULT_TOKEN_REF}@{host}:{port}"),
                None => format!("{DEFAULT_TOKEN_REF}@{host}"),
            }
        }
        Err(_) => format!("{DEFAULT_TOKEN_REF}@invalid"),
    }
}

// -------------------------------------------------------------------- the list

pub fn list(data_dir: &Path) -> Vec<Server> {
    read(data_dir).servers
}

/// Adds a server to the list. The caller confirms with the person first.
pub fn add(data_dir: &Path, url: &str, name: &str, instance_name: Option<String>) -> AppResult<Server> {
    let verdict = vet(url)?;
    let mut store = read(data_dir);
    if let Some(found) = store.servers.iter().find(|s| s.url == verdict.url) {
        return Ok(found.clone());
    }
    let server = Server {
        name: if name.trim().is_empty() { label(&verdict.url) } else { name.trim().chars().take(60).collect() },
        url: verdict.url,
        instance_name,
        added_at: crate::util::now_ms().into(),
    };
    store.servers.push(server.clone());
    write(data_dir, &store)?;
    Ok(server)
}

/// Chooses a server. `None` means the public Kern Cloud.
pub fn select(data_dir: &Path, url: Option<&str>) -> AppResult<Active> {
    let mut store = read(data_dir);
    if let Some(url) = url {
        if !store.servers.iter().any(|s| s.url == url) {
            return Err(AppError::NotFound("That server".into()));
        }
        store.selected = Some(url.to_string());
    } else {
        store.selected = None;
    }
    write(data_dir, &store)?;
    Ok(active(data_dir))
}

/// Removes a server from the list, and the selection if it was the one.
/// The caller forgets its session token.
pub fn remove(data_dir: &Path, url: &str) -> AppResult<()> {
    let mut store = read(data_dir);
    let before = store.servers.len();
    store.servers.retain(|s| s.url != url);
    if store.servers.len() == before {
        return Err(AppError::NotFound("That server".into()));
    }
    if store.selected.as_deref() == Some(url) {
        store.selected = None;
    }
    write(data_dir, &store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn https_and_loopback_are_fine() {
        assert_eq!(vet("https://kern.example.com").unwrap().url, "https://kern.example.com/kern/v1");
        assert_eq!(vet("kern.example.com").unwrap().url, "https://kern.example.com/kern/v1");
        assert_eq!(vet("http://127.0.0.1:8787").unwrap().url, "http://127.0.0.1:8787/kern/v1");
        assert_eq!(vet("http://localhost:8787/kern/v1").unwrap().url, "http://localhost:8787/kern/v1");
        assert!(vet("https://kern.example.com").unwrap().warning.is_none());
        assert!(vet("http://127.0.0.1:8787").unwrap().warning.is_none());
    }

    #[test]
    fn a_private_network_is_allowed_but_noted() {
        assert!(vet("http://192.168.1.10:8787").unwrap().warning.is_some());
        assert!(vet("http://10.0.0.5:8787").unwrap().warning.is_some());
        assert!(vet("http://nas.local:8787").unwrap().warning.is_some());
    }

    #[test]
    fn a_session_never_crosses_the_internet_in_the_clear() {
        assert!(vet("http://kern.example.com").is_err());
        assert!(vet("http://93.184.216.34:8787").is_err());
        assert!(vet("ftp://kern.example.com").is_err());
        assert!(vet("").is_err());
    }

    #[test]
    fn a_token_belongs_to_one_server() {
        // The whole point: switching servers cannot carry a session along,
        // because the entry it would be read from has a different name.
        assert_eq!(token_ref(DEFAULT_API), DEFAULT_TOKEN_REF);
        assert_eq!(token_ref("https://kern.example.com/kern/v1"), "kern-cloud-session@kern.example.com");
        assert_eq!(token_ref("http://127.0.0.1:8787/kern/v1"), "kern-cloud-session@127.0.0.1:8787");
        assert_ne!(token_ref("https://a.example/kern/v1"), token_ref("https://b.example/kern/v1"));
    }

    #[test]
    fn the_environment_cannot_be_overridden_from_the_list() {
        let dir = tempdir().unwrap();
        // Nothing added: the public server.
        let a = active(dir.path());
        assert_eq!(a.url, DEFAULT_API);
        assert_eq!(a.source, Source::Default);

        add(dir.path(), "https://kern.example.com", "Work", None).unwrap();
        let chosen = select(dir.path(), Some("https://kern.example.com/kern/v1")).unwrap();
        assert_eq!(chosen.url, "https://kern.example.com/kern/v1");
        assert_eq!(chosen.source, Source::Chosen);

        // With KERN_CLOUD_URL set, the stored choice is ignored entirely.
        // (`active` reads the variable each time, so this is the real path.)
        std::env::set_var("KERN_CLOUD_URL", "http://localhost:8787/kern/v1");
        let forced = active(dir.path());
        assert_eq!(forced.url, "http://localhost:8787/kern/v1");
        assert_eq!(forced.source, Source::Environment);
        std::env::remove_var("KERN_CLOUD_URL");
    }

    #[test]
    fn the_list_survives_a_round_trip() {
        let dir = tempdir().unwrap();
        add(dir.path(), "https://one.example", "One", Some("One Ltd".into())).unwrap();
        add(dir.path(), "https://two.example", "", None).unwrap();
        let added = list(dir.path());
        assert_eq!(added.len(), 2);
        assert_eq!(added[0].instance_name.as_deref(), Some("One Ltd"));
        // An unnamed server is named after its host.
        assert_eq!(added[1].name, "two.example");

        // Adding the same address twice is not an error, and not a duplicate.
        add(dir.path(), "https://one.example/kern/v1", "Again", None).unwrap();
        assert_eq!(list(dir.path()).len(), 2);

        select(dir.path(), Some("https://two.example/kern/v1")).unwrap();
        remove(dir.path(), "https://two.example/kern/v1").unwrap();
        assert_eq!(list(dir.path()).len(), 1);
        // Removing the selected server falls back to the public one.
        assert_eq!(active(dir.path()).source, Source::Default);
        assert!(remove(dir.path(), "https://gone.example/kern/v1").is_err());
    }
}
