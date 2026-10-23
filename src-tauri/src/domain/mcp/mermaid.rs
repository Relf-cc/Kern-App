// @Author Christian Relf
// @Date 2026-10-23

//! Mermaid flowcharts in and out of a whiteboard, on this side of the wall.
//!
//! This is the second implementation of `src/features/whiteboard/mermaid.ts`.
//! The whiteboard parses pasted Mermaid in the front end; an assistant calling
//! `kern_whiteboard_from_mermaid` needs the same conversion here, where the
//! database is, and routing a tool call through the window to borrow the
//! TypeScript one would make a tool depend on an open window for nothing.
//!
//! Two implementations of one parser drift unless something stops them, so
//! both test suites read the same cases from
//! `src/features/whiteboard/mermaid.cases.json`. A case added there must pass
//! in both; a case only one of them satisfies is a bug in the other.
//!
//! Only `flowchart` / `graph` is covered, as in the front end, and nothing
//! here touches the database — these are pure functions over text and
//! whiteboard objects.

use crate::domain::whiteboards::{WbEdge, WbNode};
use crate::util::new_id;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Tb,
    Bt,
    Lr,
    Rl,
}

impl Direction {
    /// Mermaid's two-letter forms. `TD` is `TB` under another name.
    pub fn parse(s: &str) -> Option<Direction> {
        match s.to_ascii_uppercase().as_str() {
            "TB" | "TD" => Some(Direction::Tb),
            "BT" => Some(Direction::Bt),
            "LR" => Some(Direction::Lr),
            "RL" => Some(Direction::Rl),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Direction::Tb => "TB",
            Direction::Bt => "BT",
            Direction::Lr => "LR",
            Direction::Rl => "RL",
        }
    }

    fn vertical(self) -> bool {
        matches!(self, Direction::Tb | Direction::Bt)
    }

    fn flip(self) -> bool {
        matches!(self, Direction::Bt | Direction::Rl)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Line {
    Solid,
    Dashed,
    Thick,
}

impl Line {
    pub fn as_str(self) -> &'static str {
        match self {
            Line::Solid => "solid",
            Line::Dashed => "dashed",
            Line::Thick => "thick",
        }
    }
}

/// A node as Mermaid describes it, before it has a position.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MermaidNode {
    pub key: String,
    pub label: String,
    pub shape: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MermaidEdge {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub line: Line,
    pub arrow: bool,
    /// `<-->`: an arrowhead at each end.
    pub both: bool,
}

#[derive(Debug, Clone)]
pub struct MermaidChart {
    pub direction: Direction,
    pub nodes: Vec<MermaidNode>,
    pub edges: Vec<MermaidEdge>,
}

// ------------------------------------------------------------------ parsing

/// Mermaid's node brackets, longest first so `[[x]]` is never read as `[x]`.
/// Each entry is an opening bracket, its closing bracket and the shape it
/// means on a Kern board.
const BRACKETS: &[(&str, &str, &str)] = &[
    ("([", "])", "stadium"),
    ("[(", ")]", "cylinder"),
    ("[[", "]]", "rect"),
    ("((", "))", "circle"),
    ("{{", "}}", "hexagon"),
    ("[/", "/]", "parallelogram"),
    ("[\\", "\\]", "parallelogram"),
    ("[", "]", "rect"),
    ("(", ")", "rounded"),
    ("{", "}", "diamond"),
    (">", "]", "document"),
];

/// Arrow forms, longest first so `-.->` is not read as `-.-`.
const ARROWS: &[(&str, Line, bool)] = &[
    ("-.->", Line::Dashed, true),
    ("==>", Line::Thick, true),
    ("-->", Line::Solid, true),
    ("-.-", Line::Dashed, false),
    ("===", Line::Thick, false),
    ("---", Line::Solid, false),
    ("--", Line::Solid, false),
];

/// The arrows that can close an inline `-- label -->`. A bare `--` is not one
/// of them, so `A -- B --` is two boxes and a connector, not a label.
const INLINE_CLOSERS: &[&str] = &["-.->", "-->", "==>", "---", "-.-", "==="];

/// Lines that are Mermaid's own scaffolding rather than part of the diagram.
const SKIP: &[&str] = &["subgraph", "end", "click", "style", "classDef", "class", "linkStyle", "direction"];

fn arrow_form(text: &str) -> (Line, bool) {
    ARROWS.iter().find(|(t, _, _)| *t == text).map(|(_, l, a)| (*l, *a)).unwrap_or((Line::Solid, true))
}

/// How many characters the `<br…>` at `i` takes up, if there is one. The one
/// scrap of HTML Mermaid labels use, and it means a line break.
fn br_at(cs: &[char], i: usize) -> Option<usize> {
    let is = |j: usize, c: char| cs.get(j).is_some_and(|x| x.eq_ignore_ascii_case(&c));
    if !(is(i, '<') && is(i + 1, 'b') && is(i + 2, 'r')) {
        return None;
    }
    let mut j = i + 3;
    while cs.get(j).is_some_and(|c| c.is_whitespace()) {
        j += 1;
    }
    if is(j, '/') {
        j += 1;
    }
    is(j, '>').then_some(j + 1 - i)
}

fn breaks_to_newlines(s: &str) -> String {
    if !s.contains('<') {
        return s.to_string();
    }
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < cs.len() {
        match br_at(&cs, i) {
            Some(n) => {
                out.push('\n');
                i += n;
            }
            None => {
                out.push(cs[i]);
                i += 1;
            }
        }
    }
    out
}

/// A label as written: trimmed, unwrapped from its quotes, line breaks real.
fn unquote(s: &str) -> String {
    let t = s.trim();
    let inner = match (t.strip_prefix('"'), t.strip_suffix('"')) {
        (Some(_), Some(_)) if t.len() >= 2 => &t[1..t.len() - 1],
        _ => t,
    };
    breaks_to_newlines(inner).trim().to_string()
}

/// `/^word\b/`: the line begins with this word, and not a longer one.
fn starts_with_word(line: &str, word: &str) -> bool {
    line.strip_prefix(word).is_some_and(|r| !r.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
}

/// Strips comments, reads the opening declaration, and keeps the rest.
fn useful_lines(text: &str) -> Result<(Direction, Vec<String>), String> {
    let raw: Vec<String> = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|l| match l.find("%%") {
            Some(i) => &l[..i],
            None => l,
        })
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if raw.is_empty() {
        return Err("There is nothing to import.".into());
    }
    let head = &raw[0];
    let words: Vec<&str> = head.split_whitespace().collect();
    let declared = matches!(words.first(), Some(&"flowchart") | Some(&"graph"))
        && match words.len() {
            1 => true,
            2 => words[1].len() == 2 && words[1].chars().all(|c| c.is_ascii_alphabetic()),
            _ => false,
        };
    if !declared {
        let kind: String = head.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        return Err(if !kind.is_empty() && kind != "flowchart" && kind != "graph" {
            format!("Kern imports Mermaid flowcharts; this is a {kind} diagram.")
        } else {
            "This doesn't start with “flowchart” or “graph”.".into()
        });
    }
    let direction = words.get(1).and_then(|d| Direction::parse(d)).unwrap_or(Direction::Tb);
    Ok((direction, raw[1..].to_vec()))
}

/// Reads one `KEY[Label]` term, returning the node and what came after it.
fn read_term(s: &str) -> Option<(MermaidNode, &str)> {
    let s = s.trim_start();
    // Every character a key may use is ASCII, so the count is the byte length.
    let len = s.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')).count();
    if len == 0 {
        return None;
    }
    let (key, after) = s.split_at(len);
    for (open, close, shape) in BRACKETS {
        if !after.starts_with(open) {
            continue;
        }
        let Some(end) = after[open.len()..].find(close).map(|i| i + open.len()) else { continue };
        let label = unquote(&after[open.len()..end]);
        let node = MermaidNode {
            key: key.to_string(),
            label: if label.is_empty() { key.to_string() } else { label },
            shape: (*shape).to_string(),
        };
        return Some((node, &after[end + close.len()..]));
    }
    Some((MermaidNode { key: key.to_string(), label: key.to_string(), shape: "rect".into() }, after))
}

/// One arrow, without the boxes at either end.
struct ArrowSpec {
    label: Option<String>,
    line: Line,
    arrow: bool,
    both: bool,
}

/// `-- label -->` and `-. label .->`: the text sits inside the arrow.
fn read_inline_arrow(t: &str) -> Option<(ArrowSpec, &str)> {
    for prefix in ["--", "-.", "=="] {
        let Some(after) = t.strip_prefix(prefix) else { continue };
        let mid = after.trim_start();
        // The shortest run of label characters that a closing arrow follows,
        // because the pattern in the front end is non-greedy too.
        let mut taken = 0;
        for c in mid.chars() {
            if matches!(c, '-' | '>' | '|') {
                break;
            }
            taken += c.len_utf8();
            let tail = mid[taken..].trim_start();
            for closer in INLINE_CLOSERS {
                let Some(rest) = tail.strip_prefix(closer) else { continue };
                let (form_line, arrow) = arrow_form(closer);
                let label = unquote(&mid[..taken]);
                let spec = ArrowSpec {
                    label: (!label.is_empty()).then_some(label),
                    line: match prefix {
                        "-." => Line::Dashed,
                        "==" => Line::Thick,
                        _ => form_line,
                    },
                    arrow,
                    both: false,
                };
                return Some((spec, rest));
            }
        }
    }
    None
}

/// Reads one arrow, with either `|label|` or an inline `-- label -->` form.
fn read_arrow(s: &str) -> Option<(ArrowSpec, &str)> {
    let t = s.trim_start();
    if let Some(found) = read_inline_arrow(t) {
        return Some(found);
    }
    // `<-->` is the same arrow with a head at each end.
    let both = t.starts_with('<');
    let body = if both { &t[1..] } else { t };
    for (text, line, arrow) in ARROWS {
        let Some(after) = body.strip_prefix(text) else { continue };
        let mut rest = after;
        let mut label = None;
        if let Some(piped) = after.trim_start().strip_prefix('|') {
            if let Some(end) = piped.find('|') {
                let l = unquote(&piped[..end]);
                label = (!l.is_empty()).then_some(l);
                rest = &piped[end + 1..];
            }
        }
        return Some((ArrowSpec { label, line: *line, arrow: *arrow || both, both }, rest));
    }
    None
}

/// A later, richer mention of a key wins: `A` then `A[Start]` keeps the label.
fn note(order: &mut Vec<String>, nodes: &mut HashMap<String, MermaidNode>, n: MermaidNode) {
    let Some(seen) = nodes.get(&n.key) else {
        order.push(n.key.clone());
        nodes.insert(n.key.clone(), n);
        return;
    };
    if seen.label == seen.key && n.label != n.key {
        nodes.insert(n.key.clone(), n);
    } else if seen.shape == "rect" && n.shape != "rect" {
        let merged = MermaidNode { shape: n.shape, ..seen.clone() };
        nodes.insert(n.key, merged);
    }
}

/// Parses Mermaid flowchart text. Returns the chart, or a sentence explaining
/// what stopped it — never panics, because this runs on whatever arrived.
pub fn parse_mermaid(text: &str) -> Result<MermaidChart, String> {
    let (direction, lines) = useful_lines(text)?;
    let mut order: Vec<String> = vec![];
    let mut nodes: HashMap<String, MermaidNode> = HashMap::new();
    let mut edges: Vec<MermaidEdge> = vec![];

    for line in &lines {
        if SKIP.iter().any(|w| starts_with_word(line, w)) {
            continue;
        }
        let Some((first, after)) = read_term(line) else { continue };
        note(&mut order, &mut nodes, first.clone());
        let mut left = first;
        let mut rest = after;
        // `A --> B --> C` and `A --> B & C` both chain from the term just read.
        loop {
            let Some((arrow, after_arrow)) = read_arrow(rest) else { break };
            rest = after_arrow;
            let mut targets: Vec<MermaidNode> = vec![];
            loop {
                let Some((right, after_right)) = read_term(rest) else { break };
                note(&mut order, &mut nodes, right.clone());
                targets.push(right);
                rest = after_right;
                match rest.trim_start().strip_prefix('&') {
                    Some(r) => rest = r,
                    None => break,
                }
            }
            let Some(last) = targets.last().cloned() else { break };
            for t in &targets {
                edges.push(MermaidEdge {
                    from: left.key.clone(),
                    to: t.key.clone(),
                    label: arrow.label.clone(),
                    line: arrow.line,
                    arrow: arrow.arrow,
                    both: arrow.both,
                });
            }
            left = last;
        }
    }

    if nodes.is_empty() {
        return Err("No boxes or arrows were found.".into());
    }
    Ok(MermaidChart { direction, nodes: order.iter().map(|k| nodes[k].clone()).collect(), edges })
}

// ------------------------------------------------------------------- layout

/// Box size and spacing used when a chart is laid out from scratch.
const BOX_W: f64 = 190.0;
const BOX_H: f64 = 84.0;
const GAP_ALONG: f64 = 74.0;
const GAP_ACROSS: f64 = 46.0;

#[derive(Debug, Clone, Copy)]
pub struct Placed {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Ranks nodes by how far they are from a root, then spreads each rank across
/// the other axis. Cheap, stable and good enough that the first thing you see
/// is a readable diagram you can then nudge.
pub fn layout_chart(chart: &MermaidChart) -> HashMap<String, Placed> {
    let keys: Vec<&str> = chart.nodes.iter().map(|n| n.key.as_str()).collect();
    let index: HashMap<&str, usize> = keys.iter().enumerate().map(|(i, k)| (*k, i)).collect();
    let mut out: Vec<Vec<usize>> = vec![vec![]; keys.len()];
    let mut incoming: Vec<usize> = vec![0; keys.len()];
    for e in &chart.edges {
        let (Some(&from), Some(&to)) = (index.get(e.from.as_str()), index.get(e.to.as_str())) else { continue };
        if from == to {
            continue;
        }
        out[from].push(to);
        incoming[to] += 1;
    }

    // Breadth-first from every root (and then anything a cycle left behind).
    let mut rank: Vec<Option<i64>> = vec![None; keys.len()];
    let mut queue: Vec<usize> = (0..keys.len()).filter(|i| incoming[*i] == 0).collect();
    for &k in &queue {
        rank[k] = Some(0);
    }
    // The cap stops a cycle from re-ranking forever; a dense cycle just ends
    // up on fewer ranks, which still draws.
    let mut i = 0;
    while i < queue.len() && i < 20_000 {
        let k = queue[i];
        let next = rank[k].unwrap_or(0) + 1;
        for t in out[k].clone() {
            if rank[t].is_some_and(|r| r >= next) {
                continue;
            }
            rank[t] = Some(next);
            queue.push(t);
        }
        i += 1;
    }

    // Order within a rank follows the order the chart mentioned them.
    let mut rows: BTreeMap<i64, Vec<usize>> = BTreeMap::new();
    for (k, r) in rank.iter().enumerate() {
        rows.entry(r.unwrap_or(0)).or_default().push(k);
    }

    let vertical = chart.direction.vertical();
    let flip = chart.direction.flip();
    let ranks: Vec<i64> = rows.keys().copied().collect();
    let widest = rows.values().map(|r| r.len()).max().unwrap_or(0) as f64;

    let mut pos = HashMap::new();
    for r in &ranks {
        let row = &rows[r];
        let step = if vertical { BOX_W + GAP_ACROSS } else { BOX_H + GAP_ACROSS };
        let span = row.len() as f64 * step - GAP_ACROSS;
        let full = widest * step - GAP_ACROSS;
        let start = (full - span) / 2.0;
        let along = if vertical { BOX_H + GAP_ALONG } else { BOX_W + GAP_ALONG };
        let depth = (if flip { ranks.len() as i64 - 1 - r } else { *r }) as f64 * along;
        for (i, &k) in row.iter().enumerate() {
            let across = start + i as f64 * step;
            let placed = if vertical {
                Placed { x: across, y: depth, w: BOX_W, h: BOX_H }
            } else {
                Placed { x: depth, y: across, w: BOX_W, h: BOX_H }
            };
            pos.insert(keys[k].to_string(), placed);
        }
    }
    pos
}

// --------------------------------------------------------------- to objects

/// Turns a parsed chart into whiteboard objects, laid out around `origin`.
pub fn chart_to_scene(chart: &MermaidChart, origin: (f64, f64)) -> (Vec<WbNode>, Vec<WbEdge>) {
    let pos = layout_chart(chart);
    let fallback = Placed { x: 0.0, y: 0.0, w: BOX_W, h: BOX_H };
    let mut ids: HashMap<&str, String> = HashMap::new();
    let mut nodes = vec![];
    for n in &chart.nodes {
        let id = new_id();
        ids.insert(n.key.as_str(), id.clone());
        let p = pos.get(&n.key).copied().unwrap_or(fallback);
        nodes.push(WbNode {
            id,
            kind: "shape".into(),
            x: origin.0 + p.x,
            y: origin.1 + p.y,
            width: Some(p.w),
            height: Some(p.h),
            z: 0,
            parent_id: None,
            locked: false,
            data: json!({ "shape": n.shape, "label": n.label, "fill": true }),
        });
    }
    let mut edges = vec![];
    for e in &chart.edges {
        let (Some(source), Some(target)) = (ids.get(e.from.as_str()), ids.get(e.to.as_str())) else { continue };
        if source == target {
            continue;
        }
        let mut data = json!({
            "auto": true,
            "directed": e.arrow,
            "line": if e.line == Line::Dashed { "dashed" } else { "solid" },
        });
        if e.both {
            data["both"] = json!(true);
        }
        if let Some(l) = &e.label {
            data["label"] = json!(l);
        }
        edges.push(WbEdge {
            id: new_id(),
            source: source.clone(),
            target: target.clone(),
            source_handle: None,
            target_handle: None,
            data,
        });
    }
    (nodes, edges)
}

// ----------------------------------------------------------------- to text

/// Mermaid's brackets for each shape we draw. `document`, and the standalone
/// lines and arrows that never reach here, fall back to a plain box.
fn shape_brackets(shape: &str) -> (&'static str, &'static str) {
    match shape {
        "rounded" => ("(", ")"),
        "circle" => ("((", "))"),
        "stadium" => ("([", "])"),
        "diamond" => ("{", "}"),
        "parallelogram" => ("[/", "/]"),
        "hexagon" => ("{{", "}}"),
        "cylinder" => ("[(", ")]"),
        _ => ("[", "]"),
    }
}

/// Mermaid keys are bare words, so A, B, … C1, C2 … keep it readable.
fn mermaid_key(i: usize) -> String {
    let letter = (b'A' + (i % 26) as u8) as char;
    if i < 26 {
        letter.to_string()
    } else {
        format!("{letter}{}", i / 26)
    }
}

fn escape_label(s: &str) -> String {
    format!("\"{}\"", s.replace('\n', "<br/>").replace('"', "&quot;"))
}

fn shape_of(n: &WbNode) -> Option<&str> {
    (n.kind == "shape").then(|| n.data.get("shape").and_then(Value::as_str)).flatten()
}

/// Shapes, sticky notes, text and task cards can be a flowchart box; drawings,
/// images and loose lines cannot.
fn is_box(n: &WbNode) -> bool {
    match n.kind.as_str() {
        "shape" => !matches!(shape_of(n), Some("line") | Some("arrow")),
        "sticky" | "text" | "task" => true,
        _ => false,
    }
}

fn label_of(n: &WbNode) -> String {
    let pick = |k: &str| n.data.get(k).and_then(Value::as_str);
    let text = pick("label").or_else(|| pick("title")).or_else(|| pick("text")).unwrap_or("").trim();
    if text.is_empty() { "Untitled".into() } else { text.to_string() }
}

pub struct MermaidText {
    pub text: String,
    pub included: usize,
    pub skipped: usize,
}

/// The board as Mermaid. Only objects that can be a flowchart box come along,
/// plus the connectors between them; what has no Mermaid equivalent is
/// reported as left behind so nobody thinks it was exported.
pub fn to_mermaid(nodes: &[WbNode], edges: &[WbEdge], direction: Direction) -> MermaidText {
    let mut ordered: Vec<&WbNode> = nodes.iter().filter(|n| is_box(n)).collect();
    // Reading order: down the board, then across.
    ordered.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    let keys: HashMap<&str, String> =
        ordered.iter().enumerate().map(|(i, n)| (n.id.as_str(), mermaid_key(i))).collect();

    let mut lines = vec![format!("flowchart {}", direction.as_str())];
    for n in &ordered {
        let (open, close) = shape_brackets(shape_of(n).unwrap_or("rect"));
        lines.push(format!("  {}{open}{}{close}", keys[n.id.as_str()], escape_label(&label_of(n))));
    }
    for e in edges {
        let (Some(a), Some(b)) = (keys.get(e.source.as_str()), keys.get(e.target.as_str())) else { continue };
        let dashed = matches!(e.data.get("line").and_then(Value::as_str), Some("dashed") | Some("dotted"));
        let head = e.data.get("directed").and_then(Value::as_bool) != Some(false);
        let both = e.data.get("both").and_then(Value::as_bool) == Some(true);
        let shaft = match (head, dashed) {
            (true, true) => "-.->",
            (true, false) => "-->",
            (false, true) => "-.-",
            (false, false) => "---",
        };
        let label = e
            .data
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(|l| format!("|{}|", escape_label(l)))
            .unwrap_or_default();
        lines.push(format!("  {a} {}{shaft}{label} {b}", if both { "<" } else { "" }));
    }
    MermaidText {
        text: format!("{}\n", lines.join("\n")),
        included: ordered.len(),
        skipped: nodes.len() - ordered.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// The cases the whiteboard's own parser is held to. Read at compile time
    /// so a case added on that side fails here until this side agrees.
    const CASES: &str = include_str!("../../../../src/features/whiteboard/mermaid.cases.json");

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Cases {
        parse: Vec<ParseCase>,
        errors: Vec<ErrorCase>,
        to_mermaid: Vec<ExportCase>,
        round_trip: Vec<RoundTripCase>,
    }

    #[derive(Deserialize)]
    struct ParseCase {
        name: String,
        text: String,
        direction: String,
        nodes: Vec<NodeCase>,
        edges: Vec<EdgeCase>,
    }

    #[derive(Deserialize)]
    struct NodeCase {
        key: String,
        label: String,
        shape: String,
    }

    #[derive(Deserialize)]
    struct EdgeCase {
        from: String,
        to: String,
        label: Option<String>,
        line: String,
        arrow: bool,
        both: bool,
    }

    #[derive(Deserialize)]
    struct ErrorCase {
        name: String,
        text: String,
        error: String,
    }

    #[derive(Deserialize)]
    struct ExportCase {
        name: String,
        direction: Option<String>,
        nodes: Vec<SceneNode>,
        edges: Vec<SceneEdge>,
        text: String,
        included: usize,
        skipped: usize,
    }

    #[derive(Deserialize)]
    struct SceneNode {
        id: String,
        #[serde(rename = "type")]
        kind: String,
        y: f64,
        data: Value,
    }

    #[derive(Deserialize)]
    struct SceneEdge {
        id: String,
        source: String,
        target: String,
        data: Value,
    }

    #[derive(Deserialize)]
    struct RoundTripCase {
        name: String,
        text: String,
        nodes: Vec<RoundTripNode>,
        edges: Vec<RoundTripEdge>,
    }

    #[derive(Deserialize)]
    struct RoundTripNode {
        label: String,
        shape: String,
    }

    #[derive(Deserialize)]
    struct RoundTripEdge {
        label: Option<String>,
    }

    fn cases() -> Cases {
        serde_json::from_str(CASES).expect("mermaid.cases.json")
    }

    fn direction_or_default(d: &Option<String>) -> Direction {
        d.as_deref().and_then(Direction::parse).unwrap_or(Direction::Tb)
    }

    fn scene(nodes: &[SceneNode], edges: &[SceneEdge]) -> (Vec<WbNode>, Vec<WbEdge>) {
        let ns = nodes
            .iter()
            .map(|n| WbNode {
                id: n.id.clone(),
                kind: n.kind.clone(),
                x: 0.0,
                y: n.y,
                width: Some(BOX_W),
                height: Some(BOX_H),
                z: 0,
                parent_id: None,
                locked: false,
                data: n.data.clone(),
            })
            .collect();
        let es = edges
            .iter()
            .map(|e| WbEdge {
                id: e.id.clone(),
                source: e.source.clone(),
                target: e.target.clone(),
                source_handle: None,
                target_handle: None,
                data: e.data.clone(),
            })
            .collect();
        (ns, es)
    }

    #[test]
    fn the_shared_parse_cases_read_the_same_here_as_in_the_whiteboard() {
        for c in cases().parse {
            let chart = parse_mermaid(&c.text).unwrap_or_else(|e| panic!("{}: {e}", c.name));
            assert_eq!(chart.direction.as_str(), c.direction, "{}: direction", c.name);
            let got: Vec<(&str, &str, &str)> =
                chart.nodes.iter().map(|n| (n.key.as_str(), n.label.as_str(), n.shape.as_str())).collect();
            let want: Vec<(&str, &str, &str)> =
                c.nodes.iter().map(|n| (n.key.as_str(), n.label.as_str(), n.shape.as_str())).collect();
            assert_eq!(got, want, "{}: nodes", c.name);
            let got: Vec<(&str, &str, Option<&str>, &str, bool, bool)> = chart
                .edges
                .iter()
                .map(|e| (e.from.as_str(), e.to.as_str(), e.label.as_deref(), e.line.as_str(), e.arrow, e.both))
                .collect();
            let want: Vec<(&str, &str, Option<&str>, &str, bool, bool)> = c
                .edges
                .iter()
                .map(|e| (e.from.as_str(), e.to.as_str(), e.label.as_deref(), e.line.as_str(), e.arrow, e.both))
                .collect();
            assert_eq!(got, want, "{}: edges", c.name);
        }
    }

    #[test]
    fn the_shared_error_cases_explain_themselves_rather_than_panicking() {
        for c in cases().errors {
            assert_eq!(parse_mermaid(&c.text).err().as_deref(), Some(c.error.as_str()), "{}", c.name);
        }
    }

    #[test]
    fn the_shared_export_cases_write_the_same_text() {
        for c in cases().to_mermaid {
            let (nodes, edges) = scene(&c.nodes, &c.edges);
            let out = to_mermaid(&nodes, &edges, direction_or_default(&c.direction));
            assert_eq!(out.text, c.text, "{}", c.name);
            assert_eq!((out.included, out.skipped), (c.included, c.skipped), "{}: counts", c.name);
        }
    }

    #[test]
    fn the_shared_charts_survive_text_to_objects_and_back() {
        for c in cases().round_trip {
            let first = parse_mermaid(&c.text).unwrap_or_else(|e| panic!("{}: {e}", c.name));
            let (nodes, edges) = chart_to_scene(&first, (0.0, 0.0));
            let text = to_mermaid(&nodes, &edges, Direction::Tb).text;
            let again = parse_mermaid(&text).unwrap_or_else(|e| panic!("{}: {e}\n{text}", c.name));
            let got: Vec<(&str, &str)> = again.nodes.iter().map(|n| (n.label.as_str(), n.shape.as_str())).collect();
            let want: Vec<(&str, &str)> = c.nodes.iter().map(|n| (n.label.as_str(), n.shape.as_str())).collect();
            assert_eq!(got, want, "{}: nodes", c.name);
            let got: Vec<Option<&str>> = again.edges.iter().map(|e| e.label.as_deref()).collect();
            let want: Vec<Option<&str>> = c.edges.iter().map(|e| e.label.as_deref()).collect();
            assert_eq!(got, want, "{}: edge labels", c.name);
        }
    }

    /// The layout is relational rather than a set of numbers, so it is checked
    /// here the same way the Vitest suite checks it rather than from the
    /// shared cases.
    #[test]
    fn a_chain_ranks_down_the_board_with_each_rank_centred() {
        let chart = parse_mermaid("flowchart TD\n A --> B\n A --> C").unwrap();
        let pos = layout_chart(&chart);
        let (a, b, c) = (pos["A"], pos["B"], pos["C"]);
        assert!(b.y > a.y);
        assert_eq!(c.y, b.y);
        assert!(b.x < c.x);
        // A sits halfway between its two children.
        assert!((a.x + a.w / 2.0 - (b.x + b.w / 2.0 + c.x + c.w / 2.0) / 2.0).abs() < 0.001);
    }

    #[test]
    fn direction_decides_which_way_a_chart_runs() {
        let across = layout_chart(&parse_mermaid("flowchart LR\n A --> B").unwrap());
        assert!(across["B"].x > across["A"].x);
        assert_eq!(across["B"].y, across["A"].y);
        let up = layout_chart(&parse_mermaid("flowchart BT\n A --> B").unwrap());
        assert!(up["A"].y > up["B"].y, "a bottom-to-top chart starts at the bottom");
    }

    #[test]
    fn every_node_of_a_cycle_is_placed_exactly_once() {
        let pos = layout_chart(&parse_mermaid("flowchart TD\n A --> B --> C --> A").unwrap());
        let mut keys: Vec<&String> = pos.keys().collect();
        keys.sort();
        assert_eq!(keys, ["A", "B", "C"]);
    }

    #[test]
    fn a_connector_that_would_point_at_itself_is_dropped() {
        let chart = parse_mermaid("flowchart TD\n A --> A\n A --> B").unwrap();
        let (nodes, edges) = chart_to_scene(&chart, (100.0, 50.0));
        assert_eq!(edges.len(), 1);
        assert!(nodes.iter().all(|n| n.x >= 100.0 && n.y >= 50.0), "laid out around the origin");
        assert_eq!(nodes[0].data["shape"], "rect");
        assert_eq!(nodes[0].data["fill"], true);
    }
}
