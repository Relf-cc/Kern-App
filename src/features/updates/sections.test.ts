/**
 * @Author Christian Relf
 * @Date 2026-10-19
 */

import { describe, expect, it } from "vitest";
import { parseNotes } from "./sections";
import { inAppNotes } from "./notes";

const body = [
  "## What's new",
  "",
  "### Flowcharts on whiteboards",
  "- Six new **flowchart shapes** in the shape menu.",
  "- **Paste Mermaid…** turns a flowchart into real shapes.",
  "",
  "### Fixes",
  "- **Sync no longer flickers.** A failed round waits out its backoff.",
  "",
  "## Install",
  "Windows: download the setup.",
].join("\n");

describe("parseNotes", () => {
  it("reads a release in the house shape", () => {
    const parsed = parseNotes(inAppNotes(body))!;
    expect(parsed.intro).toBe(null);
    expect(parsed.sections.map((s) => [s.title, s.kind])).toEqual([
      ["Flowcharts on whiteboards", "feature"],
      ["Fixes", "fix"],
    ]);
    expect(parsed.sections[0].items).toEqual([
      { lead: null, rest: "Six new **flowchart shapes** in the shape menu." },
      { lead: null, rest: "**Paste Mermaid…** turns a flowchart into real shapes." },
    ]);
    expect(parsed.sections[1].items[0]).toEqual({ lead: "Sync no longer flickers", rest: "A failed round waits out its backoff." });
  });

  it("reads a bold run set off by a dash as a lead", () => {
    expect(parseNotes("### Planning\n- **Day planner** — lay your day out beside your calendar.")!.sections[0].items[0]).toEqual({
      lead: "Day planner",
      rest: "lay your day out beside your calendar.",
    });
  });

  it("leaves a bold run that only opens a sentence in it", () => {
    expect(parseNotes("### Privacy\n- **Blur the window** when you switch to another app.")!.sections[0].items[0]).toEqual({
      lead: null,
      rest: "**Blur the window** when you switch to another app.",
    });
  });

  it("takes a bold bullet with nothing after it as a lead on its own", () => {
    expect(parseNotes("### Fixes\n- **Start minimised and Start maximised can no longer both be on.**")!.sections[0].items[0]).toEqual({
      lead: "Start minimised and Start maximised can no longer both be on",
      rest: "",
    });
  });

  it("names a security section so it can be marked", () => {
    expect(parseNotes("### Security\n- Tokens moved to the credential store.")!.sections[0].kind).toBe("security");
    expect(parseNotes("### Smaller things\n- A thing.")!.sections[0].kind).toBe("feature");
  });

  it("keeps an opening line as the intro, and untitled bullets as a group", () => {
    const parsed = parseNotes("A short release.\n\n- One thing.\n- Another.")!;
    expect(parsed.intro).toBe("A short release.");
    expect(parsed.sections).toEqual([{ title: null, kind: "feature", items: [{ lead: null, rest: "One thing." }, { lead: null, rest: "Another." }] }]);
  });

  it("joins a wrapped or nested bullet into the line above", () => {
    const items = parseNotes("### Notes\n- A bullet that\n  carries on,\n  - and nests.")!.sections[0].items;
    expect(items).toEqual([{ lead: null, rest: "A bullet that carries on, and nests." }]);
  });

  it("drops a heading with no bullets under it", () => {
    expect(parseNotes("### Thanks\n\n### Fixes\n- A fix.")!.sections.map((s) => s.title)).toEqual(["Fixes"]);
  });

  it("gives up on notes that aren't in the shape", () => {
    expect(parseNotes("### Fixes\n- A fix.\n\nSee the release page for the rest.")).toBe(null);
    expect(parseNotes("Just a sentence.")).toBe(null);
    expect(parseNotes("")).toBe(null);
  });
});
