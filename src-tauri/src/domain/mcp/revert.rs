// @Author Christian Relf
// @Date 2026-10-23

//! **Revert this batch**: putting one assistant's tool call back.
//!
//! One tool call is one batch. Twenty tasks from a single
//! `kern_project_setup` arrive together, so they go back together, and the
//! audit row for the call is the batch — there is no second id to keep.
//!
//! Each write records beside that row the least that would undo it: the ids
//! it created, and the fields it overwrote as they were. `apply` replays
//! those steps in one transaction, so a revert either happens or doesn't.
//!
//! This is deliberately not the front end's undo store. That is a stack of
//! closures living in a window, and an assistant writes while nobody is
//! looking; this is a record in the database that survives a restart and
//! belongs to the call rather than to the session.
//!
//! Two things it does not pretend to do. It restores the call's own changes
//! and only those, so anything edited afterwards — by hand, by sync, by a
//! later call — is overwritten by the older state; that is what "put it
//! back" has to mean, and the dialog says so before it runs. And where a
//! change had consequences of its own, those stay: the next occurrence of a
//! recurring task the assistant completed is a task in its own right by
//! then, not part of the batch.
//!
//! Created items go to Trash rather than being destroyed, the same as every
//! other delete in Kern — reverting an assistant's work is no more
//! destructive than the work was.

use crate::domain::{milestones, projects, tasks, whiteboards};
use crate::error::AppResult;
use crate::util::{now_ms, some};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// One task's fields as they were. An absent field is one the call didn't
/// touch; `Some(None)` is a field that was empty.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TaskFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub project_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub column_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub due_date: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub due_time: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub start_date: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub estimate_minutes: Option<Option<i64>>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub milestone_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub resolution: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_ids: Option<Vec<String>>,
}

impl TaskFields {
    /// The fields of `t` that `touched` names — the before-picture of a
    /// patch, so a revert writes back exactly what the call overwrote.
    pub fn of(t: &tasks::Task, touched: &Touched) -> TaskFields {
        TaskFields {
            title: touched.title.then(|| t.title.clone()),
            description: touched.description.then(|| t.description.clone()),
            status: touched.status.then(|| t.status.clone()),
            priority: touched.priority.then_some(t.priority),
            project_id: touched.project_id.then(|| t.project_id.clone()),
            column_id: touched.column_id.then(|| t.column_id.clone()),
            due_date: touched.due_date.then(|| t.due_date.clone()),
            due_time: touched.due_time.then(|| t.due_time.clone()),
            start_date: touched.start_date.then(|| t.start_date.clone()),
            estimate_minutes: touched.estimate_minutes.then_some(t.estimate_minutes),
            milestone_id: touched.milestone_id.then(|| t.milestone_id.clone()),
            resolution: touched.resolution.then(|| t.resolution.clone()),
            label_ids: touched.labels.then(|| t.label_ids.clone()),
        }
    }

    fn patch(&self) -> tasks::TaskPatch {
        tasks::TaskPatch {
            title: self.title.clone(),
            description: self.description.clone(),
            status: self.status.clone(),
            priority: self.priority,
            project_id: self.project_id.clone(),
            column_id: self.column_id.clone(),
            due_date: self.due_date.clone(),
            due_time: self.due_time.clone(),
            start_date: self.start_date.clone(),
            estimate_minutes: self.estimate_minutes,
            milestone_id: self.milestone_id.clone(),
            resolution: self.resolution.clone(),
            label_ids: self.label_ids.clone(),
            ..Default::default()
        }
    }
}

/// Which fields a call is about to change. Built from the tool's own
/// arguments, so the record holds nothing the call didn't write.
#[derive(Debug, Clone, Default)]
pub struct Touched {
    pub title: bool,
    pub description: bool,
    pub status: bool,
    pub priority: bool,
    pub project_id: bool,
    pub column_id: bool,
    pub due_date: bool,
    pub due_time: bool,
    pub start_date: bool,
    pub estimate_minutes: bool,
    pub milestone_id: bool,
    pub resolution: bool,
    pub labels: bool,
}

/// One project's fields as they were.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "some")]
    pub target_date: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
}

impl ProjectFields {
    fn patch(&self) -> projects::ProjectPatch {
        projects::ProjectPatch {
            name: self.name.clone(),
            description: self.description.clone(),
            target_date: self.target_date.clone(),
            archived: self.archived,
            ..Default::default()
        }
    }
}

/// How much of a whiteboard is worth keeping a copy of. A board bigger than
/// this is left out of the record instead: the call stays listed, it just
/// can't be reverted, which is better than a megabyte of scene per row.
const MAX_SCENE_OBJECTS: usize = 400;

/// One undo step. Serialised as JSON in `mcp_audit.undo`, so a variant is
/// part of that stored shape: add variants, don't repurpose them.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "step", rename_all = "camelCase")]
pub enum Step {
    /// Tasks the call created: to Trash, where they can be fetched back.
    TrashTasks { ids: Vec<String> },
    /// Tasks the call trashed: back out of it.
    RestoreTasks { ids: Vec<String> },
    /// One task's fields, as they were before the call.
    TaskWas { id: String, fields: TaskFields },
    /// Notes the call wrote.
    TrashNotes { ids: Vec<String> },
    /// A note's title and body, as they were.
    NoteWas { id: String, title: String, content: String },
    /// Whiteboards the call made.
    TrashWhiteboards { ids: Vec<String> },
    /// What the call added to a board that was already there.
    RemoveObjects { id: String, nodes: Vec<String>, edges: Vec<String> },
    /// A board's whole scene, as it was, for a call that replaced it.
    SceneWas { id: String, nodes: Vec<whiteboards::WbNode>, edges: Vec<whiteboards::WbEdge> },
    /// Projects the call set up: to Trash with everything in them.
    TrashProjects { ids: Vec<String> },
    /// One project's fields, as they were.
    ProjectWas { id: String, fields: ProjectFields },
    /// Boards the call created. A board isn't a trashable thing, here or
    /// anywhere else in Kern.
    DeleteBoards { ids: Vec<String> },
    DeleteMilestones { ids: Vec<String> },
    /// Labels the call created, and that nothing used before it.
    DeleteLabels { ids: Vec<String> },
}

/// The scene of a board about to be replaced, if it is small enough to keep.
pub fn scene_was(conn: &Connection, id: &str) -> AppResult<Option<Step>> {
    let nodes = whiteboards::nodes(conn, id)?;
    let edges = whiteboards::edges(conn, id)?;
    if nodes.len() + edges.len() > MAX_SCENE_OBJECTS {
        return Ok(None);
    }
    Ok(Some(Step::SceneWas { id: id.to_string(), nodes, edges }))
}

/// The labels in `ids` that no task carries and that nothing else points at:
/// the ones a call can be said to have introduced.
pub fn unused_labels(conn: &Connection, ids: &[String]) -> Vec<String> {
    ids.iter()
        .filter(|id| {
            conn.query_row::<i64, _, _>("SELECT count(*) FROM task_labels WHERE label_id = ?1", [id], |r| r.get(0))
                .map(|n| n == 0)
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

impl Step {
    /// What this step did, for the sentence the toast shows.
    fn phrase(&self) -> Option<String> {
        match self {
            Step::TrashTasks { ids } => Some(format!("moved {} to Trash", plural(ids.len(), "task", "tasks"))),
            Step::RestoreTasks { ids } => Some(format!("brought {} back", plural(ids.len(), "task", "tasks"))),
            Step::TaskWas { .. } => Some("put a task back as it was".into()),
            Step::TrashNotes { ids } => Some(format!("moved {} to Trash", plural(ids.len(), "note", "notes"))),
            Step::NoteWas { .. } => Some("put a note back as it was".into()),
            Step::TrashWhiteboards { ids } => Some(format!("moved {} to Trash", plural(ids.len(), "whiteboard", "whiteboards"))),
            Step::RemoveObjects { nodes, .. } => Some(format!("took {} off a whiteboard", plural(nodes.len(), "shape", "shapes"))),
            Step::SceneWas { .. } => Some("put a whiteboard back as it was".into()),
            Step::TrashProjects { ids } => Some(format!("moved {} to Trash", plural(ids.len(), "project", "projects"))),
            Step::ProjectWas { .. } => Some("put a project back as it was".into()),
            Step::DeleteBoards { ids } => Some(format!("removed {}", plural(ids.len(), "board", "boards"))),
            Step::DeleteMilestones { ids } => Some(format!("removed {}", plural(ids.len(), "milestone", "milestones"))),
            // True but not worth a clause of its own.
            Step::DeleteLabels { .. } => None,
        }
    }

    fn run(&self, conn: &Connection) -> AppResult<()> {
        let now = now_ms();
        match self {
            Step::TrashTasks { ids } => tasks::soft_delete(conn, ids)?,
            Step::RestoreTasks { ids } => tasks::restore(conn, ids)?,
            Step::TaskWas { id, fields } => {
                tasks::update_task(conn, id, &fields.patch())?;
            }
            Step::TrashNotes { ids } => {
                for id in ids {
                    conn.execute("UPDATE notes SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL", params![now, id])?;
                }
            }
            Step::NoteWas { id, title, content } => {
                conn.execute(
                    "UPDATE notes SET title = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
                    params![title, content, now, id],
                )?;
            }
            Step::TrashWhiteboards { ids } => {
                for id in ids {
                    conn.execute(
                        "UPDATE whiteboards SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                        params![now, id],
                    )?;
                }
            }
            Step::RemoveObjects { id, nodes, edges } => {
                let patch = whiteboards::ScenePatch {
                    removed_nodes: nodes.clone(),
                    removed_edges: edges.clone(),
                    ..Default::default()
                };
                whiteboards::patch_scene(conn, id, &patch)?;
            }
            Step::SceneWas { id, nodes, edges } => whiteboards::save_scene(conn, id, nodes, edges)?,
            Step::TrashProjects { ids } => {
                for id in ids {
                    conn.execute("UPDATE projects SET deleted_at = ?1 WHERE id = ?2 AND deleted_at IS NULL", params![now, id])?;
                    for table in ["tasks", "notes", "whiteboards"] {
                        conn.execute(
                            &format!("UPDATE {table} SET deleted_at = ?1 WHERE project_id = ?2 AND deleted_at IS NULL"),
                            params![now, id],
                        )?;
                    }
                    conn.execute("DELETE FROM recent_items WHERE entity_type = 'project' AND entity_id = ?1", [id])?;
                }
            }
            Step::ProjectWas { id, fields } => {
                projects::update_project(conn, id, &fields.patch())?;
            }
            Step::DeleteBoards { ids } => {
                for id in ids {
                    conn.execute("DELETE FROM boards WHERE id = ?1", [id])?;
                    conn.execute("UPDATE projects SET default_board_id = NULL WHERE default_board_id = ?1", [id])?;
                }
            }
            Step::DeleteMilestones { ids } => {
                for id in ids {
                    milestones::delete(conn, id)?;
                }
            }
            Step::DeleteLabels { ids } => {
                for id in ids {
                    conn.execute("DELETE FROM labels WHERE id = ?1", [id])?;
                }
            }
        }
        Ok(())
    }
}

/// Replays a batch, all of it or none. The sentence it returns is what the
/// user is told happened.
pub fn apply(conn: &mut Connection, steps: &[Step]) -> AppResult<String> {
    let tx = conn.transaction()?;
    for step in steps {
        step.run(&tx)?;
    }
    tx.commit()?;
    let mut phrases: Vec<String> = steps.iter().filter_map(|s| s.phrase()).collect();
    Ok(match phrases.len() {
        0 => "Nothing left to put back.".to_string(),
        1 => format!("Reverted: {}.", phrases.remove(0)),
        _ => {
            let last = phrases.pop().unwrap_or_default();
            format!("Reverted: {} and {last}.", phrases.join(", "))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use crate::domain::notes;
    use crate::domain::projects::{create_project, get_project, update_project, ProjectInput, ProjectPatch};
    use crate::domain::tasks::TaskInput;

    fn db() -> Connection {
        open_memory()
    }

    #[test]
    fn a_created_task_goes_to_trash_and_an_edit_goes_back() {
        let c = &mut db();
        let t = tasks::create_task(
            c,
            &TaskInput { title: "Wireframes".into(), due_date: Some("2030-01-02".into()), ..Default::default() },
        )
        .unwrap();
        // The before-picture of a title-and-due-date change.
        let touched = Touched { title: true, due_date: true, ..Default::default() };
        let was = Step::TaskWas { id: t.id.clone(), fields: TaskFields::of(&t, &touched) };
        tasks::update_task(
            c,
            &t.id,
            &tasks::TaskPatch { title: Some("Renamed".into()), due_date: Some(None), ..Default::default() },
        )
        .unwrap();
        assert_eq!(tasks::get_task(c, &t.id).unwrap().title, "Renamed");

        let said = apply(c, &[was]).unwrap();
        let back = tasks::get_task(c, &t.id).unwrap();
        assert_eq!(back.title, "Wireframes");
        assert_eq!(back.due_date.as_deref(), Some("2030-01-02"), "an emptied field is filled again");
        assert!(said.contains("put a task back"), "{said}");

        apply(c, &[Step::TrashTasks { ids: vec![t.id.clone()] }]).unwrap();
        assert!(tasks::get_task(c, &t.id).unwrap().deleted_at.is_some(), "recoverable, not destroyed");
    }

    #[test]
    fn a_note_and_a_project_go_back() {
        let c = &mut db();
        let p = create_project(c, &ProjectInput { name: "Website".into(), ..Default::default() }).unwrap();
        let n = notes::create_note(c, "Brief", "## Goals", Some(&p.id)).unwrap();
        let steps = vec![
            Step::NoteWas { id: n.id.clone(), title: n.title.clone(), content: n.content.clone() },
            Step::ProjectWas {
                id: p.id.clone(),
                fields: ProjectFields { name: Some(p.name.clone()), ..Default::default() },
            },
        ];
        notes::update_note(c, &n.id, &notes::NotePatch { content: Some("Rewritten".into()), ..Default::default() }).unwrap();
        update_project(c, &p.id, &ProjectPatch { name: Some("Something else".into()), ..Default::default() }).unwrap();

        apply(c, &steps).unwrap();
        assert_eq!(notes::get_note(c, &n.id).unwrap().content, "## Goals");
        assert_eq!(get_project(c, &p.id).unwrap().name, "Website");
    }

    #[test]
    fn a_whole_project_is_trashed_with_everything_in_it() {
        let c = &mut db();
        let p = create_project(c, &ProjectInput { name: "Website".into(), ..Default::default() }).unwrap();
        let t = tasks::create_task(c, &TaskInput { title: "Wireframes".into(), project_id: Some(p.id.clone()), ..Default::default() }).unwrap();
        apply(c, &[Step::TrashProjects { ids: vec![p.id.clone()] }]).unwrap();
        assert!(tasks::get_task(c, &t.id).unwrap().deleted_at.is_some());
        let trashed = crate::domain::trash::list(c).unwrap();
        assert!(trashed.iter().any(|i| i.kind == "project" && i.id == p.id));
    }

    #[test]
    fn a_failing_step_leaves_the_batch_alone() {
        let c = &mut db();
        let t = tasks::create_task(c, &TaskInput { title: "Wireframes".into(), ..Default::default() }).unwrap();
        let steps = vec![
            Step::TrashTasks { ids: vec![t.id.clone()] },
            // A milestone that was never there.
            Step::DeleteMilestones { ids: vec!["nope".into()] },
        ];
        assert!(apply(c, &steps).is_err());
        assert!(tasks::get_task(c, &t.id).unwrap().deleted_at.is_none(), "the first step rolled back with it");
    }

    #[test]
    fn the_record_round_trips_through_json() {
        let steps = vec![
            Step::TaskWas {
                id: "t1".into(),
                fields: TaskFields { title: Some("Wireframes".into()), due_date: Some(None), ..Default::default() },
            },
            Step::TrashTasks { ids: vec!["t2".into()] },
        ];
        let json = serde_json::to_string(&steps).unwrap();
        // An untouched field stays out of the record entirely.
        assert!(!json.contains("description"), "{json}");
        let back: Vec<Step> = serde_json::from_str(&json).unwrap();
        let Step::TaskWas { fields, .. } = &back[0] else { panic!("the first step changed shape") };
        assert_eq!(fields.title.as_deref(), Some("Wireframes"));
        assert_eq!(fields.due_date, Some(None), "\"it was empty\" survives the round trip");
        assert!(fields.status.is_none());
    }
}
