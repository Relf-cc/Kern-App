// @Author Christian Relf
// @Date 2026-10-22

//! `kern-mcp` — the bridge between an AI assistant and a running Kern.
//!
//! Assistants start a local MCP server as a child process and talk to it over
//! stdin and stdout. Kern is already running and owns its database, so this
//! program is what gets started instead: it opens Kern's local pipe, says who
//! is asking, and from then on copies bytes in both directions. The protocol,
//! the rules about what may be read or changed, and the data all stay inside
//! Kern.
//!
//! It holds no state, parses no messages and has no dependencies. If Kern
//! isn't running, or hasn't approved this assistant, it says so on stderr and
//! exits — stdout stays clean, because anything written there would be read
//! as a protocol message.
//!
//! Usage: kern-mcp [--name <assistant name>] [--endpoint <pipe or socket>]

use std::io::{BufRead, BufReader, Read, Write};
use std::process::ExitCode;

/// Matches `domain::mcp::endpoint` in the app.
fn default_endpoint() -> String {
    let suffix = match std::env::var("KERN_DATA_DIR") {
        Ok(d) if !d.is_empty() => {
            let h = d.bytes().fold(1469598103934665603u64, |h, b| (h ^ b as u64).wrapping_mul(1099511628211));
            format!("-{h:x}")
        }
        _ => String::new(),
    };
    if cfg!(windows) {
        format!(r"\\.\pipe\kern-mcp{suffix}")
    } else {
        std::env::temp_dir().join(format!("kern-mcp{suffix}.sock")).to_string_lossy().into_owned()
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("kern-mcp: {message}");
    ExitCode::FAILURE
}

/// JSON-escapes a name for the greeting, so a quote in it can't break the line.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' | '\r' | '\t' => out.push(' '),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(windows)]
fn connect(endpoint: &str) -> std::io::Result<std::fs::File> {
    use std::fs::OpenOptions;
    // The server hands out one instance at a time, so a pipe that is busy
    // just means another assistant got there a moment earlier.
    for attempt in 0..50 {
        match OpenOptions::new().read(true).write(true).open(endpoint) {
            Ok(f) => return Ok(f),
            Err(e) if e.raw_os_error() == Some(231) && attempt < 49 => {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("Kern's assistant pipe stayed busy."))
}

#[cfg(not(windows))]
fn connect(endpoint: &str) -> std::io::Result<std::os::unix::net::UnixStream> {
    std::os::unix::net::UnixStream::connect(endpoint)
}

#[cfg(windows)]
fn split(s: std::fs::File) -> std::io::Result<(std::fs::File, std::fs::File)> {
    let other = s.try_clone()?;
    Ok((s, other))
}

#[cfg(not(windows))]
fn split(s: std::os::unix::net::UnixStream) -> std::io::Result<(std::os::unix::net::UnixStream, std::os::unix::net::UnixStream)> {
    let other = s.try_clone()?;
    Ok((s, other))
}

/// Copies until the source ends, flushing every chunk: a buffered copy would
/// sit on a reply until the buffer filled.
fn pump(mut from: impl Read, mut to: impl Write) -> std::io::Result<()> {
    let mut buf = [0u8; 16 * 1024];
    loop {
        let n = from.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        to.write_all(&buf[..n])?;
        to.flush()?;
    }
}

fn main() -> ExitCode {
    let mut name = String::from("Assistant");
    let mut endpoint = default_endpoint();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--name" | "-n" if i + 1 < args.len() => {
                name = args[i + 1].clone();
                i += 2;
            }
            "--endpoint" | "-e" if i + 1 < args.len() => {
                endpoint = args[i + 1].clone();
                i += 2;
            }
            "--help" | "-h" => {
                eprintln!("Usage: kern-mcp [--name <assistant name>] [--endpoint <pipe or socket>]");
                return ExitCode::SUCCESS;
            }
            other => {
                return fail(&format!("unknown argument '{other}'"));
            }
        }
    }

    let stream = match connect(&endpoint) {
        Ok(s) => s,
        Err(e) => {
            return fail(&format!(
                "couldn't reach Kern at {endpoint} ({e}). Is Kern running, with the assistant connection switched on in Settings → API → Assistants?"
            ));
        }
    };
    let (to_kern, from_kern) = match split(stream) {
        Ok(pair) => pair,
        Err(e) => return fail(&format!("couldn't open the connection to Kern ({e})")),
    };
    let mut to_kern = to_kern;

    // Say who is asking, then wait for Kern to accept or refuse.
    if let Err(e) = writeln!(to_kern, "{{\"name\":\"{}\"}}", escape(&name)).and_then(|()| to_kern.flush()) {
        return fail(&format!("couldn't greet Kern ({e})"));
    }
    let mut reply = String::new();
    let mut reader = BufReader::new(from_kern);
    if let Err(e) = reader.read_line(&mut reply) {
        return fail(&format!("Kern didn't answer ({e})"));
    }
    if !reply.contains("\"ok\":true") {
        let message = reply
            .split_once("\"message\":\"")
            .and_then(|(_, rest)| rest.split_once('"'))
            .map(|(m, _)| m.to_string())
            .unwrap_or_else(|| "Kern refused the connection.".into());
        return fail(&message);
    }

    // From here it is one stream each way. Either end closing ends the run:
    // an assistant closes stdin when it is finished with the server.
    let mut out_half = match to_kern.try_clone() {
        Ok(h) => h,
        Err(e) => return fail(&format!("couldn't split the connection ({e})")),
    };
    std::thread::spawn(move || {
        let _ = pump(reader, std::io::stdout());
        std::process::exit(0);
    });
    let _ = pump(std::io::stdin(), &mut out_half);
    ExitCode::SUCCESS
}
