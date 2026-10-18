// @Author Christian Relf
// @Date 2026-10-18

//! Spell checking for the note editor.
//!
//! WebView2 draws the red underline but its context menu offers no
//! corrections, so on Windows Kern asks the operating system's own spell
//! checker (the Spell Checking API, the same dictionaries Word and Edge use)
//! for the misspelled runs and for suggestions. "Add to dictionary" writes to
//! the user's own dictionary. Nothing leaves the computer.
//!
//! The macOS and Linux webviews do offer corrections in their native context
//! menu, so `spell_supported` is false there and the editor leaves spelling
//! to the webview.
//!
//! Offsets are UTF-16 code units - what both the Windows API and JavaScript
//! string indexes count - so the front end can use them as they are.

use crate::error::{invalid, AppResult};
use serde::Serialize;

/// One misspelled run inside a block of text.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SpellRange {
    /// Offset from the start of the text, in UTF-16 code units.
    pub start: u32,
    pub len: u32,
    /// The one right answer, when the checker is certain ("teh" -> "the").
    /// An empty string means the run should simply go (a repeated word).
    pub replacement: Option<String>,
}

/// Longest text one check accepts. The editor sends a paragraph at a time, so
/// this only exists to stop a pathological call stalling the worker.
const MAX_LEN: usize = 20_000;

/// Most runs reported for one block, and most suggestions for one word.
const MAX_RANGES: usize = 500;
const MAX_SUGGESTIONS: usize = 8;

/// Longest word we will look up or remember.
const MAX_WORD: usize = 200;

// ------------------------------------------------------------------ commands

/// Whether Kern checks spelling itself on this platform. When false the
/// editor leaves it to the webview, which offers its own corrections there.
#[tauri::command]
pub fn spell_supported() -> bool {
    imp::supported()
}

/// Misspelled runs for each block of text, in the same order.
#[tauri::command]
pub async fn spell_check(texts: Vec<String>) -> AppResult<Vec<Vec<SpellRange>>> {
    if texts.iter().any(|t| t.len() > MAX_LEN) {
        return invalid("that block of text is too long to check");
    }
    Ok(texts.iter().map(|t| imp::check(t)).collect())
}

/// Corrections for one word, best first.
#[tauri::command]
pub async fn spell_suggest(word: String) -> AppResult<Vec<String>> {
    if word.trim().is_empty() || word.len() > MAX_WORD {
        return Ok(Vec::new());
    }
    Ok(imp::suggest(&word))
}

/// Adds a word to the user's own dictionary, for good.
#[tauri::command]
pub async fn spell_add(word: String) -> AppResult<()> {
    let w = word.trim();
    if w.is_empty() || w.len() > MAX_WORD {
        return invalid("that isn't a word to remember");
    }
    imp::add(w);
    Ok(())
}

/// Ignores a word until the app restarts.
#[tauri::command]
pub async fn spell_ignore(word: String) -> AppResult<()> {
    let w = word.trim();
    if w.is_empty() || w.len() > MAX_WORD {
        return invalid("that isn't a word to ignore");
    }
    imp::ignore(w);
    Ok(())
}

// ----------------------------------------------------------------- Windows

// The spell checker is a COM object, so it lives on a thread of its own that
// initialises COM once and answers requests over a channel. Nothing COM ever
// crosses a thread boundary; only plain strings do.
#[cfg(windows)]
mod imp {
    use super::{SpellRange, MAX_RANGES, MAX_SUGGESTIONS};
    use std::sync::mpsc::{channel, sync_channel, Receiver, Sender, SyncSender};
    use std::sync::OnceLock;
    use std::time::Duration;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Globalization::{
        GetUserDefaultLocaleName, IEnumSpellingError, ISpellChecker, ISpellCheckerFactory,
        ISpellingError, SpellCheckerFactory, CORRECTIVE_ACTION_DELETE, CORRECTIVE_ACTION_REPLACE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// Nothing waits longer than this for the worker, so a wedged checker
    /// costs you corrections rather than a frozen editor.
    const TIMEOUT: Duration = Duration::from_secs(4);

    enum Job {
        Check(Vec<u16>, SyncSender<Vec<SpellRange>>),
        Suggest(Vec<u16>, SyncSender<Vec<String>>),
        /// `true` remembers the word for good, `false` only for this session.
        Remember(Vec<u16>, bool),
    }

    /// `None` once we know this computer has no usable dictionary.
    static WORKER: OnceLock<Option<SyncSender<Job>>> = OnceLock::new();

    fn worker() -> Option<&'static SyncSender<Job>> {
        WORKER
            .get_or_init(|| {
                let (tx, rx) = sync_channel::<Job>(8);
                let (ready, started) = channel::<bool>();
                std::thread::Builder::new()
                    .name("kern-spell".into())
                    .spawn(move || run(rx, ready))
                    .ok()?;
                match started.recv_timeout(TIMEOUT) {
                    Ok(true) => Some(tx),
                    _ => None,
                }
            })
            .as_ref()
    }

    fn run(rx: Receiver<Job>, ready: Sender<bool>) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let checker =
                CoCreateInstance::<_, ISpellCheckerFactory>(&SpellCheckerFactory, None, CLSCTX_ALL)
                    .ok()
                    .and_then(|f| for_this_computer(&f));
            let Some(checker) = checker else {
                let _ = ready.send(false);
                return;
            };
            let _ = ready.send(true);
            while let Ok(job) = rx.recv() {
                match job {
                    Job::Check(text, reply) => {
                        let _ = reply.send(check_wide(&checker, &text));
                    }
                    Job::Suggest(word, reply) => {
                        let _ = reply.send(suggest_wide(&checker, &word));
                    }
                    Job::Remember(word, forever) => {
                        let w = PCWSTR(word.as_ptr());
                        let _ = if forever {
                            checker.Add(w)
                        } else {
                            checker.Ignore(w)
                        };
                    }
                }
            }
        }
    }

    /// The checker for this computer's language, falling back to en-US.
    unsafe fn for_this_computer(factory: &ISpellCheckerFactory) -> Option<ISpellChecker> {
        unsafe {
            let mut buf = [0u16; 85];
            let n = GetUserDefaultLocaleName(&mut buf);
            let mut tags: Vec<Vec<u16>> = Vec::new();
            // The count includes the terminator, which PCWSTR needs anyway.
            if n > 1 {
                tags.push(buf[..n as usize].to_vec());
            }
            tags.push(wide("en-US"));
            for tag in tags {
                let t = PCWSTR(tag.as_ptr());
                if !factory.IsSupported(t).map(|b| b.as_bool()).unwrap_or(false) {
                    continue;
                }
                if let Ok(c) = factory.CreateSpellChecker(t) {
                    return Some(c);
                }
            }
            None
        }
    }

    unsafe fn check_wide(checker: &ISpellChecker, text: &[u16]) -> Vec<SpellRange> {
        unsafe {
            let mut out = Vec::new();
            let Ok(errors) = checker.Check(PCWSTR(text.as_ptr())) else {
                return out;
            };
            while out.len() < MAX_RANGES {
                let Some(e) = next_error(&errors) else { break };
                let (Ok(start), Ok(len)) = (e.StartIndex(), e.Length()) else {
                    break;
                };
                if len == 0 {
                    continue;
                }
                let action = e.CorrectiveAction().unwrap_or_default();
                let replacement = if action == CORRECTIVE_ACTION_REPLACE {
                    e.Replacement().ok().and_then(|p| owned(p))
                } else if action == CORRECTIVE_ACTION_DELETE {
                    Some(String::new())
                } else {
                    None
                };
                out.push(SpellRange {
                    start,
                    len,
                    replacement,
                });
            }
            out
        }
    }

    /// `Next` reports the end of the list as success with nothing written.
    unsafe fn next_error(errors: &IEnumSpellingError) -> Option<ISpellingError> {
        unsafe {
            let mut e = None;
            if errors.Next(&mut e).is_err() {
                return None;
            }
            e
        }
    }

    unsafe fn suggest_wide(checker: &ISpellChecker, word: &[u16]) -> Vec<String> {
        unsafe {
            let mut out = Vec::new();
            let Ok(list) = checker.Suggest(PCWSTR(word.as_ptr())) else {
                return out;
            };
            while out.len() < MAX_SUGGESTIONS {
                let mut slot = [PWSTR::null(); 1];
                let mut got = 0u32;
                if list.Next(&mut slot, Some(&mut got)).is_err() || got == 0 {
                    break;
                }
                match owned(slot[0]) {
                    Some(s) if !s.is_empty() => out.push(s),
                    _ => break,
                }
            }
            out
        }
    }

    /// Copies a string the API allocated for us, then frees it.
    unsafe fn owned(p: PWSTR) -> Option<String> {
        unsafe {
            if p.is_null() {
                return None;
            }
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn supported() -> bool {
        worker().is_some()
    }

    pub fn check(text: &str) -> Vec<SpellRange> {
        ask(|reply| Job::Check(wide(text), reply)).unwrap_or_default()
    }

    pub fn suggest(word: &str) -> Vec<String> {
        ask(|reply| Job::Suggest(wide(word), reply)).unwrap_or_default()
    }

    pub fn add(word: &str) {
        tell(Job::Remember(wide(word), true));
    }

    pub fn ignore(word: &str) {
        tell(Job::Remember(wide(word), false));
    }

    fn ask<T>(job: impl FnOnce(SyncSender<T>) -> Job) -> Option<T> {
        let tx = worker()?;
        let (reply, answer) = sync_channel::<T>(1);
        tx.send(job(reply)).ok()?;
        answer.recv_timeout(TIMEOUT).ok()
    }

    fn tell(job: Job) {
        if let Some(tx) = worker() {
            let _ = tx.send(job);
        }
    }
}

// ------------------------------------------------------------ everywhere else

#[cfg(not(windows))]
mod imp {
    use super::SpellRange;

    pub fn supported() -> bool {
        false
    }

    pub fn check(_text: &str) -> Vec<SpellRange> {
        Vec::new()
    }

    pub fn suggest(_word: &str) -> Vec<String> {
        Vec::new()
    }

    pub fn add(_word: &str) {}

    pub fn ignore(_word: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_an_oversized_block() {
        let long = "a".repeat(MAX_LEN + 1);
        assert!(tauri::async_runtime::block_on(spell_check(vec![long])).is_err());
    }

    #[test]
    fn ignores_an_empty_word() {
        let r = tauri::async_runtime::block_on(spell_suggest("   ".into())).unwrap();
        assert!(r.is_empty());
        assert!(tauri::async_runtime::block_on(spell_add(String::new())).is_err());
    }

    /// On a computer with a dictionary installed, a misspelling is found and
    /// can be corrected. Elsewhere there is nothing to check.
    #[test]
    fn finds_a_misspelling_when_the_os_can() {
        if !spell_supported() {
            return;
        }
        let text = "I have a hllo spelling mistake";
        let r = tauri::async_runtime::block_on(spell_check(vec![text.into()])).unwrap();
        assert_eq!(r[0].len(), 1, "{:?}", r[0]);
        assert_eq!((r[0][0].start, r[0][0].len), (9, 4));
        let s = tauri::async_runtime::block_on(spell_suggest("hllo".into())).unwrap();
        assert!(s.iter().any(|x| x == "hello"), "{s:?}");
    }

    /// One answer per block, in the order they were sent, whether or not this
    /// computer has a dictionary.
    #[test]
    fn answers_every_block() {
        let r = tauri::async_runtime::block_on(spell_check(vec![
            "hello".into(),
            String::new(),
            "world".into(),
        ]))
        .unwrap();
        assert_eq!(r.len(), 3);
    }
}
