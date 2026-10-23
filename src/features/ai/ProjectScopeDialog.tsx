/**
 * @Author Christian Relf
 * @Date 2026-10-23
 */

// Which projects an assistant may see: every one, or a chosen few. The same
// dialog sets the list that covers every assistant and each assistant's own,
// and a project has to be in both to be seen, so the per-assistant one says
// which projects the other list has already ruled out.

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { useProjects } from "@/hooks/data";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Checkbox, RadioCards } from "@/components/ui/Controls";

export default function ProjectScopeDialog({
  title,
  lead,
  value,
  within,
  onSave,
  onClose,
}: {
  title: string;
  lead: string;
  value: string[];
  /** The list that covers every assistant, when this is one assistant's own. */
  within?: string[];
  onSave: (ids: string[]) => void | Promise<unknown>;
  onClose: () => void;
}) {
  const { data: projects } = useProjects(false);
  const [mode, setMode] = useState<"all" | "some">(value.length ? "some" : "all");
  const [chosen, setChosen] = useState(() => new Set(value));
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  const outside = (id: string) => !!within?.length && !within.includes(id);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (projects ?? []).filter((p) => !s || p.name.toLowerCase().includes(s));
  }, [projects, q]);
  const toggle = (id: string, on: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const blocking = mode === "some" && chosen.size === 0 ? "Choose at least one project." : null;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(mode === "all" ? [] : [...chosen]);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      footer={
        <>
          {blocking && <span className="wizard-dialog__blocking" style={{ marginRight: "auto" }}>{blocking}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!!blocking || saving} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <p className="wizard-lead">{lead}</p>
      <RadioCards
        value={mode}
        onChange={setMode}
        ariaLabel="Projects"
        columns={2}
        options={[
          { value: "all", title: within?.length ? "Every allowed project" : "Every project", text: "Including projects you create later." },
          { value: "some", title: "Only these", text: "Everything else is invisible, and no new project can be created." },
        ]}
      />
      {mode === "some" && (
        <div className="mcp-pick">
          <div className="input-wrap">
            <Search />
            <input className="input" autoFocus placeholder="Find a project" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a project" />
          </div>
          <div className="mcp-pick__list" role="group" aria-label="Projects">
            {list.length === 0 && <span className="faint mcp-pick__empty">{projects?.length ? "No project matches that." : "You have no projects yet."}</span>}
            {list.map((p) => (
              <label key={p.id} className="mcp-pick__row" data-off={outside(p.id) || undefined}>
                <Checkbox checked={chosen.has(p.id)} onChange={(on) => toggle(p.id, on)} label={p.name} disabled={outside(p.id)} />
                <span className="truncate grow">{p.name}</span>
                {outside(p.id) && <span className="faint mcp-pick__note">Not allowed for any assistant</span>}
              </label>
            ))}
          </div>
          <span className="faint mcp-pick__count tabular">
            {chosen.size} of {projects?.length ?? 0} chosen
          </span>
        </div>
      )}
      <span className="field__hint">Projects locked with a passkey stay invisible to assistants whatever this says.</span>
    </Dialog>
  );
}
