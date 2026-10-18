/**
 * @Author Christian Relf
 * @Date 2026-10-18
 */

// Paste a Mermaid flowchart and see what it will become before it lands on
// the board. The parsing lives in mermaid.ts; this is only the dialog.

import { useMemo, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { parseMermaid, type MermaidChart } from "./mermaid";

const EXAMPLE = `flowchart TD
  A([Start]) --> B{Looks right?}
  B -->|Yes| C[Ship it]
  B -->|No| D[/Collect notes/]
  D --> B`;

export function MermaidDialog({ open, onOpenChange, onImport }: { open: boolean; onOpenChange: (o: boolean) => void; onImport: (chart: MermaidChart) => void }) {
  const [text, setText] = useState("");
  const result = useMemo(() => (text.trim() ? parseMermaid(text) : null), [text]);
  const chart = result && !("error" in result) ? result : null;
  const error = result && "error" in result ? result.error : null;

  const add = () => {
    if (!chart) return;
    onImport(chart);
    setText("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Paste a Mermaid flowchart"
      description="Boxes become shapes and arrows become connectors, laid out in the middle of the view. Everything is editable afterwards."
      wide
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={add} disabled={!chart}>
            Add to board
          </Button>
        </>
      }
    >
      <div className="field">
        <textarea
          className="textarea mono"
          autoFocus
          rows={12}
          spellCheck={false}
          placeholder={EXAMPLE}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Mermaid flowchart"
        />
        <div className="field__hint" aria-live="polite">
          {error ? (
            <span style={{ color: "var(--danger)" }}>{error}</span>
          ) : chart ? (
            `${chart.nodes.length} ${chart.nodes.length === 1 ? "shape" : "shapes"}, ${chart.edges.length} ${chart.edges.length === 1 ? "connector" : "connectors"}, ${
              chart.direction === "LR" || chart.direction === "RL" ? "left to right" : "top to bottom"
            }.`
          ) : (
            "flowchart and graph diagrams only."
          )}
        </div>
      </div>
    </Dialog>
  );
}
