// @Author Christian Relf
// @Date 2026-10-12

//! Whiteboards: metadata plus objects (nodes) and connections (edges).
//! The client saves the full scene (debounced); the backend diffs it
//! against stored rows in one transaction, touching only changed objects.

use crate::domain::{activity, passkeys, recent};
use crate::error::{invalid, AppError, AppResult};
use crate::state::AppState;
use crate::util::{new_id, now_ms, some};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use tauri::State;

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Whiteboard {
    pub id: String,
    pub project_id: Option<String>,
    pub name: String,
    pub pinned: bool,
    pub sort_order: f64,
    pub viewport: Option<Value>,
    pub node_count: i64,
    pub deleted_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WbNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    #[serde(default)]
    pub z: i64,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub locked: bool,
    #[serde(default)]
    pub data: Value,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WbEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub source_handle: Option<String>,
    pub target_handle: Option<String>,
    #[serde(default)]
    pub data: Value,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WhiteboardScene {
    pub whiteboard: Whiteboard,
    pub nodes: Vec<WbNode>,
    pub edges: Vec<WbEdge>,
}

const SELECT: &str = "SELECT w.id, w.project_id, w.name, w.pinned, w.sort_order, w.viewport, w.deleted_at, w.created_at,
  w.updated_at, (SELECT count(*) FROM wb_nodes n WHERE n.whiteboard_id = w.id) FROM whiteboards w";

fn map(r: &rusqlite::Row) -> rusqlite::Result<Whiteboard> {
    let vp: Option<String> = r.get(5)?;
    Ok(Whiteboard {
        id: r.get(0)?,
        project_id: r.get(1)?,
        name: r.get(2)?,
        pinned: r.get::<_, i64>(3)? != 0,
        sort_order: r.get(4)?,
        viewport: vp.and_then(|s| serde_json::from_str(&s).ok()),
        deleted_at: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        node_count: r.get(9)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Whiteboard> {
    let wb = conn
        .query_row(&format!("{SELECT} WHERE w.id = ?1"), [id], map)
        .optional()?
        .ok_or_else(|| AppError::NotFound("Whiteboard".into()))?;
    passkeys::ensure_readable_opt(conn, wb.project_id.as_deref())?;
    Ok(wb)
}

pub fn nodes(conn: &Connection, id: &str) -> AppResult<Vec<WbNode>> {
    let mut stmt = conn.prepare(
        "SELECT id, type, x, y, width, height, z, parent_id, locked, data FROM wb_nodes WHERE whiteboard_id = ?1 ORDER BY z, rowid",
    )?;
    let rows = stmt.query_map([id], |r| {
        let d: String = r.get(9)?;
        Ok(WbNode {
            id: r.get(0)?,
            kind: r.get(1)?,
            x: r.get(2)?,
            y: r.get(3)?,
            width: r.get(4)?,
            height: r.get(5)?,
            z: r.get(6)?,
            parent_id: r.get(7)?,
            locked: r.get::<_, i64>(8)? != 0,
            data: serde_json::from_str(&d).unwrap_or(Value::Object(Default::default())),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn edges(conn: &Connection, id: &str) -> AppResult<Vec<WbEdge>> {
    let mut stmt =
        conn.prepare("SELECT id, source, target, source_handle, target_handle, data FROM wb_edges WHERE whiteboard_id = ?1")?;
    let rows = stmt.query_map([id], |r| {
        let d: String = r.get(5)?;
        Ok(WbEdge {
            id: r.get(0)?,
            source: r.get(1)?,
            target: r.get(2)?,
            source_handle: r.get(3)?,
            target_handle: r.get(4)?,
            data: serde_json::from_str(&d).unwrap_or(Value::Object(Default::default())),
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// The whiteboards in a project, or all of them. Locked projects are left out
/// by `readable_sql`, the same gate the rest of the app uses.
pub fn list(conn: &Connection, project_id: Option<&str>) -> AppResult<Vec<Whiteboard>> {
    let mut stmt = conn.prepare(&format!(
        "{SELECT} LEFT JOIN projects p ON p.id = w.project_id
         WHERE w.deleted_at IS NULL AND (w.project_id IS NULL OR p.deleted_at IS NULL) AND (?1 IS NULL OR w.project_id = ?1)
           AND {}
         ORDER BY w.pinned DESC, w.sort_order, w.created_at",
        passkeys::readable_sql(conn, "w.project_id")
    ))?;
    let rows = stmt.query_map([project_id], map)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub fn create(conn: &Connection, project_id: Option<&str>, name: &str) -> AppResult<Whiteboard> {
    let name = name.trim();
    if name.is_empty() {
        return invalid("Whiteboard name can't be empty.");
    }
    let id = new_id();
    let now = now_ms();
    let sort: f64 = conn.query_row(
        "SELECT coalesce(max(sort_order), 0) + 1 FROM whiteboards WHERE project_id IS ?1",
        [project_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO whiteboards(id, project_id, name, sort_order, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, project_id, name, sort, now],
    )?;
    get(conn, &id)
}

/// Replaces the stored scene with the given nodes and edges, writing only
/// rows that actually changed.
pub fn save_scene(conn: &Connection, id: &str, nodes_in: &[WbNode], edges_in: &[WbEdge]) -> AppResult<()> {
    let now = now_ms();
    let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM whiteboards WHERE id = ?1)", [id], |r| r.get(0))?;
    if !exists {
        return Err(AppError::NotFound("Whiteboard".into()));
    }
    let keep: HashSet<&str> = nodes_in.iter().map(|n| n.id.as_str()).collect();
    let mut stmt = conn.prepare("SELECT id FROM wb_nodes WHERE whiteboard_id = ?1")?;
    let existing: Vec<String> = stmt.query_map([id], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for e in existing.iter().filter(|e| !keep.contains(e.as_str())) {
        conn.execute("DELETE FROM wb_nodes WHERE id = ?1", [e])?;
    }
    let mut upsert = conn.prepare(
        "INSERT INTO wb_nodes(id, whiteboard_id, type, x, y, width, height, z, parent_id, locked, data, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, x = excluded.x, y = excluded.y, width = excluded.width,
           height = excluded.height, z = excluded.z, parent_id = excluded.parent_id, locked = excluded.locked,
           data = excluded.data, updated_at = excluded.updated_at
         WHERE wb_nodes.whiteboard_id = excluded.whiteboard_id AND (wb_nodes.type IS NOT excluded.type OR wb_nodes.x IS NOT excluded.x
           OR wb_nodes.y IS NOT excluded.y OR wb_nodes.width IS NOT excluded.width OR wb_nodes.height IS NOT excluded.height
           OR wb_nodes.z IS NOT excluded.z OR wb_nodes.parent_id IS NOT excluded.parent_id OR wb_nodes.locked IS NOT excluded.locked
           OR wb_nodes.data IS NOT excluded.data)",
    )?;
    for n in nodes_in {
        if !n.x.is_finite() || !n.y.is_finite() {
            return invalid("Whiteboard object has an invalid position.");
        }
        upsert.execute(params![
            n.id,
            id,
            n.kind,
            n.x,
            n.y,
            n.width.filter(|w| w.is_finite()),
            n.height.filter(|h| h.is_finite()),
            n.z,
            n.parent_id,
            n.locked as i64,
            serde_json::to_string(&n.data)?,
            now
        ])?;
    }
    conn.execute("DELETE FROM wb_edges WHERE whiteboard_id = ?1", [id])?;
    let mut ins = conn.prepare(
        "INSERT INTO wb_edges(id, whiteboard_id, source, target, source_handle, target_handle, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for e in edges_in {
        // Drop dangling connections rather than storing broken references.
        if !keep.contains(e.source.as_str()) || !keep.contains(e.target.as_str()) {
            continue;
        }
        ins.execute(params![e.id, id, e.source, e.target, e.source_handle, e.target_handle, serde_json::to_string(&e.data)?])?;
    }
    conn.execute("UPDATE whiteboards SET updated_at = ?1 WHERE id = ?2", params![now, id])?;
    Ok(())
}

/// Changes to part of a scene: objects and connections to insert or update,
/// and ids to remove. Collaborators editing the same whiteboard each send
/// only what they changed, so nobody's edits overwrite anyone else's.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ScenePatch {
    pub nodes: Vec<WbNode>,
    pub removed_nodes: Vec<String>,
    pub edges: Vec<WbEdge>,
    pub removed_edges: Vec<String>,
}

pub fn patch_scene(conn: &Connection, id: &str, p: &ScenePatch) -> AppResult<()> {
    let exists: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM whiteboards WHERE id = ?1)", [id], |r| r.get(0))?;
    if !exists {
        return Err(AppError::NotFound("Whiteboard".into()));
    }
    let now = now_ms();
    for n in &p.removed_nodes {
        conn.execute("DELETE FROM wb_edges WHERE whiteboard_id = ?1 AND (source = ?2 OR target = ?2)", params![id, n])?;
        conn.execute("DELETE FROM wb_nodes WHERE id = ?1 AND whiteboard_id = ?2", params![n, id])?;
    }
    let mut upsert = conn.prepare(
        "INSERT INTO wb_nodes(id, whiteboard_id, type, x, y, width, height, z, parent_id, locked, data, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, x = excluded.x, y = excluded.y, width = excluded.width,
           height = excluded.height, z = excluded.z, parent_id = excluded.parent_id, locked = excluded.locked,
           data = excluded.data, updated_at = excluded.updated_at
         WHERE wb_nodes.whiteboard_id = excluded.whiteboard_id AND (wb_nodes.type IS NOT excluded.type OR wb_nodes.x IS NOT excluded.x
           OR wb_nodes.y IS NOT excluded.y OR wb_nodes.width IS NOT excluded.width OR wb_nodes.height IS NOT excluded.height
           OR wb_nodes.z IS NOT excluded.z OR wb_nodes.parent_id IS NOT excluded.parent_id OR wb_nodes.locked IS NOT excluded.locked
           OR wb_nodes.data IS NOT excluded.data)",
    )?;
    for n in &p.nodes {
        if !n.x.is_finite() || !n.y.is_finite() {
            return invalid("Whiteboard object has an invalid position.");
        }
        upsert.execute(params![
            n.id,
            id,
            n.kind,
            n.x,
            n.y,
            n.width.filter(|w| w.is_finite()),
            n.height.filter(|h| h.is_finite()),
            n.z,
            n.parent_id,
            n.locked as i64,
            serde_json::to_string(&n.data)?,
            now
        ])?;
    }
    for e in &p.removed_edges {
        conn.execute("DELETE FROM wb_edges WHERE id = ?1 AND whiteboard_id = ?2", params![e, id])?;
    }
    let mut edge = conn.prepare(
        "INSERT INTO wb_edges(id, whiteboard_id, source, target, source_handle, target_handle, data)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE EXISTS (SELECT 1 FROM wb_nodes WHERE id = ?3 AND whiteboard_id = ?2) AND EXISTS (SELECT 1 FROM wb_nodes WHERE id = ?4 AND whiteboard_id = ?2)
         ON CONFLICT(id) DO UPDATE SET source = excluded.source, target = excluded.target, source_handle = excluded.source_handle,
           target_handle = excluded.target_handle, data = excluded.data
         WHERE wb_edges.whiteboard_id = excluded.whiteboard_id AND (wb_edges.source IS NOT excluded.source OR wb_edges.target IS NOT excluded.target
           OR wb_edges.source_handle IS NOT excluded.source_handle OR wb_edges.target_handle IS NOT excluded.target_handle OR wb_edges.data IS NOT excluded.data)",
    )?;
    for e in &p.edges {
        edge.execute(params![e.id, id, e.source, e.target, e.source_handle, e.target_handle, serde_json::to_string(&e.data)?])?;
    }
    if !(p.nodes.is_empty() && p.removed_nodes.is_empty() && p.edges.is_empty() && p.removed_edges.is_empty()) {
        conn.execute("UPDATE whiteboards SET updated_at = ?1 WHERE id = ?2", params![now, id])?;
    }
    Ok(())
}

/// Copies a whiteboard (with fresh ids) into `project_id`.
pub fn duplicate(conn: &Connection, id: &str, project_id: Option<&str>, rename: bool) -> AppResult<Whiteboard> {
    let src = get(conn, id)?;
    let name = if rename { format!("{} (copy)", src.name) } else { src.name.clone() };
    let target_project = project_id.map(String::from).or(src.project_id.clone());
    let wb = create(conn, target_project.as_deref(), &name)?;
    let mut map: HashMap<String, String> = HashMap::new();
    let ns = nodes(conn, id)?;
    for n in &ns {
        map.insert(n.id.clone(), new_id());
    }
    let new_nodes: Vec<WbNode> = ns
        .into_iter()
        .map(|mut n| {
            n.id = map[&n.id].clone();
            n.parent_id = n.parent_id.and_then(|p| map.get(&p).cloned());
            n
        })
        .collect();
    let new_edges: Vec<WbEdge> = edges(conn, id)?
        .into_iter()
        .filter_map(|mut e| {
            e.id = new_id();
            e.source = map.get(&e.source)?.clone();
            e.target = map.get(&e.target)?.clone();
            Some(e)
        })
        .collect();
    save_scene(conn, &wb.id, &new_nodes, &new_edges)?;
    if let Some(vp) = &src.viewport {
        conn.execute("UPDATE whiteboards SET viewport = ?1 WHERE id = ?2", params![serde_json::to_string(vp)?, wb.id])?;
    }
    get(conn, &wb.id)
}

#[tauri::command]
pub fn whiteboards_list(state: State<AppState>, project_id: Option<String>) -> AppResult<Vec<Whiteboard>> {
    state.with(|c| list(c, project_id.as_deref()))
}

#[tauri::command]
pub fn whiteboard_get(state: State<AppState>, id: String) -> AppResult<WhiteboardScene> {
    state.with(|c| {
        let whiteboard = get(c, &id)?;
        recent::touch(c, "whiteboard", &id)?;
        Ok(WhiteboardScene { whiteboard, nodes: nodes(c, &id)?, edges: edges(c, &id)? })
    })
}

/// Lightweight scene for previews (no recent-item side effect).
#[tauri::command]
pub fn whiteboard_preview(state: State<AppState>, id: String) -> AppResult<WhiteboardScene> {
    state.with(|c| Ok(WhiteboardScene { whiteboard: get(c, &id)?, nodes: nodes(c, &id)?, edges: edges(c, &id)? }))
}

#[tauri::command]
pub fn whiteboard_create(state: State<AppState>, project_id: Option<String>, name: String) -> AppResult<Whiteboard> {
    state.with(|c| {
        let w = create(c, project_id.as_deref(), &name)?;
        activity::log(c, project_id.as_deref(), "whiteboard", &w.id, "created", &w.name)?;
        Ok(w)
    })
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WhiteboardPatch {
    pub name: Option<String>,
    pub pinned: Option<bool>,
    pub viewport: Option<Value>,
    #[serde(deserialize_with = "some")]
    pub project_id: Option<Option<String>>,
    pub sort_order: Option<f64>,
}

#[tauri::command]
pub fn whiteboard_update(state: State<AppState>, id: String, patch: WhiteboardPatch) -> AppResult<Whiteboard> {
    state.with(|c| {
        if let Some(n) = &patch.name {
            if n.trim().is_empty() {
                return invalid("Whiteboard name can't be empty.");
            }
            c.execute("UPDATE whiteboards SET name = ?1, updated_at = ?2 WHERE id = ?3", params![n.trim(), now_ms(), id])?;
        }
        if let Some(p) = patch.pinned {
            c.execute("UPDATE whiteboards SET pinned = ?1 WHERE id = ?2", params![p as i64, id])?;
        }
        if let Some(v) = &patch.viewport {
            c.execute("UPDATE whiteboards SET viewport = ?1 WHERE id = ?2", params![serde_json::to_string(v)?, id])?;
        }
        if let Some(p) = &patch.project_id {
            c.execute("UPDATE whiteboards SET project_id = ?1 WHERE id = ?2", params![p, id])?;
        }
        if let Some(s) = patch.sort_order {
            c.execute("UPDATE whiteboards SET sort_order = ?1 WHERE id = ?2", params![s, id])?;
        }
        get(c, &id)
    })
}

#[tauri::command]
pub fn whiteboard_save(
    state: State<AppState>,
    id: String,
    nodes: Vec<WbNode>,
    edges: Vec<WbEdge>,
    viewport: Option<Value>,
) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        save_scene(&tx, &id, &nodes, &edges)?;
        if let Some(v) = viewport {
            tx.execute("UPDATE whiteboards SET viewport = ?1 WHERE id = ?2", params![serde_json::to_string(&v)?, id])?;
        }
        tx.commit()?;
        Ok(())
    })
}

/// Saves the changed part of a scene (see [`ScenePatch`]).
#[tauri::command]
pub fn whiteboard_patch(state: State<AppState>, id: String, patch: ScenePatch, viewport: Option<Value>) -> AppResult<()> {
    state.with(|c| {
        let tx = c.transaction()?;
        patch_scene(&tx, &id, &patch)?;
        if let Some(v) = viewport {
            tx.execute("UPDATE whiteboards SET viewport = ?1 WHERE id = ?2", params![serde_json::to_string(&v)?, id])?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[tauri::command]
pub fn whiteboard_duplicate(state: State<AppState>, id: String) -> AppResult<Whiteboard> {
    state.with(|c| {
        let tx = c.transaction()?;
        let w = duplicate(&tx, &id, None, true)?;
        tx.commit()?;
        Ok(w)
    })
}

/// Creates a whiteboard from an exported JSON document.
#[tauri::command]
pub fn whiteboard_import(state: State<AppState>, project_id: Option<String>, document: Value) -> AppResult<Whiteboard> {
    let name = document["whiteboard"]["name"].as_str().unwrap_or("Imported whiteboard").to_string();
    let nodes_in: Vec<WbNode> = serde_json::from_value(document["nodes"].clone())
        .map_err(|_| AppError::Invalid("This file isn't a whiteboard export.".into()))?;
    let edges_in: Vec<WbEdge> = serde_json::from_value(document["edges"].clone()).unwrap_or_default();
    state.with(|c| {
        let tx = c.transaction()?;
        let wb = create(&tx, project_id.as_deref(), &name)?;
        let mut map: HashMap<String, String> = HashMap::new();
        for n in &nodes_in {
            map.insert(n.id.clone(), new_id());
        }
        let ns: Vec<WbNode> = nodes_in
            .into_iter()
            .map(|mut n| {
                n.id = map[&n.id].clone();
                n.parent_id = n.parent_id.and_then(|p| map.get(&p).cloned());
                n
            })
            .collect();
        let es: Vec<WbEdge> = edges_in
            .into_iter()
            .filter_map(|mut e| {
                e.id = new_id();
                e.source = map.get(&e.source)?.clone();
                e.target = map.get(&e.target)?.clone();
                Some(e)
            })
            .collect();
        save_scene(&tx, &wb.id, &ns, &es)?;
        let out = get(&tx, &wb.id)?;
        tx.commit()?;
        Ok(out)
    })
}

#[tauri::command]
pub fn whiteboard_delete(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("UPDATE whiteboards SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL", params![now_ms(), id])?;
        Ok(())
    })
}

#[tauri::command]
pub fn whiteboard_restore(state: State<AppState>, id: String) -> AppResult<()> {
    state.with(|c| {
        c.execute("UPDATE whiteboards SET deleted_at = NULL WHERE id = ?1", [&id])?;
        c.execute(
            "UPDATE whiteboards SET project_id = NULL WHERE id = ?1 AND project_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = whiteboards.project_id AND p.deleted_at IS NULL)",
            [&id],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use serde_json::json;

    fn node(id: &str, x: f64, text: &str) -> WbNode {
        WbNode {
            id: id.into(),
            kind: "text".into(),
            x,
            y: 0.0,
            width: Some(200.0),
            height: Some(100.0),
            z: 0,
            parent_id: None,
            locked: false,
            data: json!({ "text": text }),
        }
    }

    #[test]
    fn save_diff_and_dangling_edges() {
        let c = open_memory();
        let w = create(&c, None, "Plan").unwrap();
        let e = WbEdge { id: "e1".into(), source: "a".into(), target: "b".into(), source_handle: None, target_handle: None, data: json!({}) };
        save_scene(&c, &w.id, &[node("a", 0.0, "alpha"), node("b", 10.0, "beta")], &[e.clone()]).unwrap();
        assert_eq!(edges(&c, &w.id).unwrap().len(), 1);
        // Remove b: the edge to it is dropped.
        save_scene(&c, &w.id, &[node("a", 5.0, "alpha")], &[e]).unwrap();
        assert_eq!(nodes(&c, &w.id).unwrap().len(), 1);
        assert_eq!(nodes(&c, &w.id).unwrap()[0].x, 5.0);
        assert!(edges(&c, &w.id).unwrap().is_empty());
        // Text is searchable.
        let n: i64 = c.query_row("SELECT count(*) FROM search_fts WHERE search_fts MATCH 'alpha'", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn patches_touch_only_what_changed() {
        let c = open_memory();
        let w = create(&c, None, "Plan").unwrap();
        save_scene(&c, &w.id, &[node("a", 0.0, "alpha"), node("b", 10.0, "beta")], &[]).unwrap();
        // Someone else adds "c" while this patch moves "a" and links a → b.
        save_scene(&c, &w.id, &[node("a", 0.0, "alpha"), node("b", 10.0, "beta"), node("c", 20.0, "gamma")], &[]).unwrap();
        let e = WbEdge { id: "e1".into(), source: "a".into(), target: "b".into(), source_handle: None, target_handle: None, data: json!({}) };
        let dangling = WbEdge { id: "e2".into(), source: "a".into(), target: "zz".into(), source_handle: None, target_handle: None, data: json!({}) };
        patch_scene(&c, &w.id, &ScenePatch { nodes: vec![node("a", 99.0, "alpha")], edges: vec![e, dangling], ..Default::default() }).unwrap();
        let ns = nodes(&c, &w.id).unwrap();
        assert_eq!(ns.len(), 3, "the other editor's object survives");
        assert_eq!(ns.iter().find(|n| n.id == "a").unwrap().x, 99.0);
        assert_eq!(edges(&c, &w.id).unwrap().len(), 1, "connections to missing objects are dropped");
        // Removing an object removes its connections.
        patch_scene(&c, &w.id, &ScenePatch { removed_nodes: vec!["b".into()], ..Default::default() }).unwrap();
        assert_eq!(nodes(&c, &w.id).unwrap().len(), 2);
        assert!(edges(&c, &w.id).unwrap().is_empty());
    }

    #[test]
    fn duplicate_remaps_ids() {
        let c = open_memory();
        let w = create(&c, None, "Plan").unwrap();
        let mut child = node("child", 1.0, "c");
        child.parent_id = Some("area".into());
        let e = WbEdge { id: "e".into(), source: "area".into(), target: "child".into(), source_handle: None, target_handle: None, data: json!({}) };
        save_scene(&c, &w.id, &[node("area", 0.0, "a"), child], &[e]).unwrap();
        let d = duplicate(&c, &w.id, None, true).unwrap();
        let ns = nodes(&c, &d.id).unwrap();
        assert_eq!(ns.len(), 2);
        assert!(ns.iter().all(|n| n.id != "area" && n.id != "child"));
        let child = ns.iter().find(|n| n.parent_id.is_some()).unwrap();
        assert!(ns.iter().any(|n| Some(&n.id) == child.parent_id.as_ref()));
        assert_eq!(edges(&c, &d.id).unwrap().len(), 1);
    }
}
