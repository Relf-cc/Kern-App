/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// "Create workspace": a short guided flow. Basics → about the team → GitHub
// organisation (optional) → invite people (optional) → review. Creating
// switches to the new workspace and imports the chosen repositories.
//
// Some servers only let people they have invited create a workspace, and say
// so in /instance as `workspaceKeys: "required"`. When this one does, the
// first step also asks for the key. It is asked for up front rather than at
// the end on purpose: being refused after filling in five steps is a horrible
// way to find out, and the answer is usually "ask whoever runs this server",
// which is better to read before the work than after it.

import { useEffect, useState } from "react";
import { ArrowLeft, Building2, Check, Loader, Mail, Sparkles } from "lucide-react";
import { api } from "@/lib/ipc";
import type { InviteResult, Space } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { toastError } from "@/stores/toast";
import { GithubMark } from "@/features/github/shared";
import { errorText, refreshMe, useCloud } from "./store";
import { spaceRef, switchSpace } from "./actions";
import { AboutFields, BasicsFields, GithubPicker, InviteEditor, localTimeZone, TEAM_SIZES, validWebsite, type GithubChoice, type InviteDraft, type WorkspaceDraft } from "./workspaceFields";
import { ROLE_LABEL, SpaceLogo, spaceLook } from "./ui";

/** `k_` then 32 hex characters, which is what a server mints. Checked here
 * only to catch a mis-paste early; the server decides whether it is real. */
const KEY_SHAPE = /^k_[0-9a-f]{32}$/;

const STEPS = [
  { id: "basics", label: "Basics" },
  { id: "about", label: "Your team" },
  { id: "github", label: "GitHub" },
  { id: "invite", label: "Invite" },
  { id: "review", label: "Review" },
] as const;
type StepId = (typeof STEPS)[number]["id"];

export function CreateWorkspaceDialog() {
  const open = useCloud((s) => s.createOpen);
  return open ? <Wizard /> : null;
}

function Wizard() {
  const account = useCloud((s) => s.info?.account);
  const [step, setStep] = useState<StepId>("basics");
  const [draft, setDraft] = useState<WorkspaceDraft>({
    name: "",
    slug: "",
    description: "",
    logo: null,
    accent: null,
    icon: null,
    tint: false,
    website: "",
    industry: "",
    teamSize: null,
    useCase: "",
    timezone: localTimeZone(),
  });
  const [github, setGithub] = useState<GithubChoice>({ org: null, repos: [], syncIssues: true });
  const [invites, setInvites] = useState<InviteDraft[]>([]);
  const [message, setMessage] = useState("");
  const [key, setKey] = useState("");
  /** null while we are still asking the server whether it wants one. */
  const [needsKey, setNeedsKey] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<{ space: Space; invites: InviteResult[]; imported: number } | null>(null);
  const set = (p: Partial<WorkspaceDraft>) => setDraft((d) => ({ ...d, ...p }));

  // Ask this server whether creating a workspace takes a key. A server too
  // old to answer, or one that cannot be reached, is treated as not wanting
  // one: it will refuse the creation itself if it does, with a message that
  // says so, and that is better than blocking the flow on a field nobody can
  // fill in.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const info = await api.cloud.request<{ workspaceKeys?: string }>("GET", "/instance");
        if (live) setNeedsKey(info.workspaceKeys === "required");
      } catch {
        if (live) setNeedsKey(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);
  const close = () => useCloud.setState({ createOpen: false });
  const index = STEPS.findIndex((s) => s.id === step);

  const problem = (s: StepId): string | null => {
    if (s === "basics") {
      if (!draft.name.trim()) return "Give the workspace a name.";
      if (draft.slug && draft.slug.length < 3) return "The workspace ID needs at least 3 characters.";
      if (needsKey && !key.trim()) return "This server needs a workspace key.";
      if (needsKey && !KEY_SHAPE.test(key.trim())) return "That doesn't look like a workspace key.";
    }
    if (s === "about" && !validWebsite(draft.website)) return "The website should start with https://";
    return null;
  };
  const blocking = problem(step);

  const create = async () => {
    setProgress("Creating your workspace…");
    try {
      const res = await api.cloud.request<{ workspace: Space; invites: InviteResult[] }>("POST", "/workspaces", {
        name: draft.name.trim(),
        slug: draft.slug || undefined,
        description: draft.description.trim(),
        logo: draft.logo,
        accent: draft.accent,
        settings: { icon: draft.icon, tint: draft.tint },
        website: draft.website.trim() || null,
        industry: draft.industry || null,
        teamSize: draft.teamSize,
        useCase: draft.useCase || null,
        timezone: draft.timezone || null,
        githubOrg: github.org,
        invites: invites.length ? invites : undefined,
        inviteMessage: message.trim() || undefined,
        key: key.trim() || undefined,
      });
      await refreshMe();
      setProgress("Opening it…");
      await switchSpace(spaceRef(res.workspace), { quiet: true });
      let imported = 0;
      if (github.org && github.repos.length) {
        setProgress(`Importing ${github.repos.length} repositor${github.repos.length === 1 ? "y" : "ies"} as projects…`);
        try {
          const r = await api.github.importRepos(
            github.repos.map((x) => ({ fullName: x.fullName, description: x.description, defaultBranch: x.defaultBranch, htmlUrl: x.htmlUrl })),
            github.syncIssues,
          );
          imported = r.created.length;
          await api.cloud.request("POST", `/workspaces/${res.workspace.id}/github-synced`, { org: github.org, repos: imported });
        } catch (e) {
          toastError(errorText(e, "The workspace was created, but importing repositories failed. Try again from workspace settings."));
        }
      }
      setDone({ space: res.workspace, invites: res.invites, imported });
    } catch (e) {
      // The server has the last word on the key, and says which way it is
      // wrong. Send the person back to the field rather than leaving them on
      // the review step with a toast and nowhere to type.
      const code = (e as { code?: string } | null)?.code;
      if (code === "workspace_key") {
        setNeedsKey(true);
        setStep("basics");
      }
      toastError(errorText(e, "Couldn't create the workspace."));
    } finally {
      setProgress(null);
    }
  };

  if (done) {
    const sent = done.invites.filter((i) => i.ok).length;
    const failed = done.invites.filter((i) => !i.ok);
    return (
      <Dialog open onOpenChange={(o) => !o && close()} centered title="Your workspace is ready">
        <div className="col" style={{ gap: 14, alignItems: "center", textAlign: "center", padding: "8px 0" }}>
          <SpaceLogo name={done.space.name} logo={done.space.logo} accent={done.space.accent} icon={spaceLook(done.space.settings).icon} size={56} />
          <div className="col" style={{ gap: 4 }}>
            <strong style={{ fontSize: "var(--fs-lg)" }}>{done.space.name}</strong>
            <span className="muted">You're in it now. Everything you add here - projects, boards, tasks, notes, whiteboards - is shared with members in real time.</span>
          </div>
          <div className="col" style={{ gap: 6, alignSelf: "stretch", textAlign: "left" }}>
            {done.imported > 0 && (
              <span className="row" style={{ gap: 8 }}>
                <GithubMark /> {done.imported} repositor{done.imported === 1 ? "y" : "ies"} imported as projects
              </span>
            )}
            {sent > 0 && (
              <span className="row" style={{ gap: 8 }}>
                <Mail size={14} /> {sent} invitation{sent === 1 ? "" : "s"} sent
              </span>
            )}
            {failed.map((f) => (
              <span key={f.email} className="field-error">
                {f.email}: {f.reason}
              </span>
            ))}
          </div>
          <Button variant="primary" block onClick={close}>
            Start working
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !progress && close()}
      wide
      className="wizard"
      title={
        <span className="row" style={{ gap: 8 }}>
          <Building2 size={16} strokeWidth={1.75} /> Create a workspace
        </span>
      }
      footer={
        <>
          {index > 0 && (
            <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(STEPS[index - 1].id)} disabled={!!progress}>
              Back
            </Button>
          )}
          <span className="spacer" />
          {blocking && <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{blocking}</span>}
          {(step === "github" || step === "invite") && (
            <Button variant="ghost" onClick={() => setStep(STEPS[index + 1].id)}>
              Skip
            </Button>
          )}
          {step === "review" ? (
            <Button variant="primary" icon={progress ? Loader : Sparkles} onClick={() => void create()} disabled={!!progress}>
              {progress ?? "Create workspace"}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setStep(STEPS[index + 1].id)} disabled={!!blocking}>
              Continue
            </Button>
          )}
        </>
      }
    >
      <div className="wizard__layout">
        <ol className="wizard__steps">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                type="button"
                className="wizard__step"
                data-state={s.id === step ? "current" : i < index ? "done" : "todo"}
                disabled={i > index && STEPS.slice(0, i).some((x) => problem(x.id))}
                onClick={() => setStep(s.id)}
              >
                <span className="wizard__dot">{i < index ? <Check size={11} /> : i + 1}</span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="wizard__body">
          {step === "basics" && (
            <>
              <p className="wizard__lead">A workspace is a shared space for a team: projects, boards, tasks, issues, notes and whiteboards sync to every member in real time. Files and folders stay on each person's computer.</p>
              <BasicsFields draft={draft} set={set} />
              {needsKey && (
                <div className="field">
                  <label className="field__label">Workspace key</label>
                  <input
                    className="input mono"
                    value={key}
                    maxLength={40}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    placeholder="k_…"
                    onChange={(e) => setKey(e.target.value.trim())}
                  />
                  <p className="field__hint">
                    This server only lets people it has invited create a workspace. Paste the key you were given — joining a workspace
                    somebody invites you to never needs one.
                  </p>
                </div>
              )}
            </>
          )}
          {step === "about" && (
            <>
              <p className="wizard__lead">A little about the team helps Kern set things up sensibly. All of it is optional and can be changed later.</p>
              <AboutFields draft={draft} set={set} />
            </>
          )}
          {step === "github" && (
            <>
              <p className="wizard__lead">Sync a GitHub organisation and each of its repositories becomes a project in this workspace, connected for issues and pull requests.</p>
              <GithubPicker value={github} onChange={setGithub} />
            </>
          )}
          {step === "invite" && (
            <>
              <p className="wizard__lead">Invite people by email. They get a link that opens Kern; they sign in (or create an account) with that address to join.</p>
              <InviteEditor invites={invites} onChange={setInvites} message={message} onMessage={setMessage} selfEmail={account?.email} />
            </>
          )}
          {step === "review" && <Review draft={draft} github={github} invites={invites} />}
        </div>
      </div>
    </Dialog>
  );
}

function Review({ draft, github, invites }: { draft: WorkspaceDraft; github: GithubChoice; invites: InviteDraft[] }) {
  const row = (label: string, value: React.ReactNode) => (
    <div className="review__row">
      <span className="faint">{label}</span>
      <span>{value || <span className="faint">-</span>}</span>
    </div>
  );
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="row" style={{ gap: 12 }}>
        <SpaceLogo name={draft.name} logo={draft.logo} accent={draft.accent} icon={draft.icon} size={48} />
        <div className="col" style={{ minWidth: 0 }}>
          <strong style={{ fontSize: "var(--fs-lg)" }} className="truncate">{draft.name}</strong>
          <span className="faint mono">kern/{draft.slug || "…"}</span>
        </div>
      </div>
      {draft.description && <p className="muted" style={{ margin: 0 }}>{draft.description}</p>}
      <div className="review">
        {row("Used for", draft.useCase)}
        {row("Team size", TEAM_SIZES.find((t) => t.value === draft.teamSize)?.label)}
        {row("Industry", draft.industry)}
        {row("Time zone", draft.timezone)}
        {row("Website", draft.website)}
        {row(
          "GitHub",
          github.org ? (
            <span className="row" style={{ gap: 6 }}>
              <GithubMark /> {github.org} · {github.repos.length} repositor{github.repos.length === 1 ? "y" : "ies"}
              {github.syncIssues ? " · issues sync" : ""}
            </span>
          ) : null,
        )}
        {row("Invitations", invites.length ? invites.map((i) => `${i.email} (${ROLE_LABEL[i.role]})`).join(", ") : null)}
      </div>
      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
        Workspaces are free. You'll be the owner; you can add admins, change roles and transfer ownership later.
      </span>
    </div>
  );
}
