/**
 * @Author Christian Relf
 * @Date 2026-10-13
 */

// The Kern Cloud sign-in modal: sign in, create an account, confirm the
// email with a code, sign in with a code, and recover a forgotten password.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Cloud, Eye, EyeOff, MailCheck, Server } from "lucide-react";
import { api, KernError } from "@/lib/ipc";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { toast } from "@/stores/toast";
import { errorText, refreshMe, refreshStatus, useCloud, type AuthMode } from "./store";
import { CodeInput } from "./ui";

function Password({ value, onChange, autoFocus, label = "Password", autoComplete = "current-password" }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; label?: string; autoComplete?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="field">
      <label className="field__label">{label}</label>
      <div className="input-wrap">
        <input className="input grow" type={show ? "text" : "password"} value={value} autoFocus={autoFocus} autoComplete={autoComplete} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
        <IconButton icon={show ? EyeOff : Eye} label={show ? "Hide password" : "Show password"} size="sm" onClick={() => setShow(!show)} tabIndex={-1} />
      </div>
    </div>
  );
}

function strength(pw: string): { score: number; label: string } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return { score, label: ["Too short", "Weak", "Okay", "Good", "Strong"][score] };
}

const TITLES: Record<AuthMode, string> = {
  "sign-in": "Sign in to Kern Cloud",
  "sign-up": "Create your Kern account",
  verify: "Check your email",
  code: "Sign in with a code",
  forgot: "Recover your account",
  reset: "Choose a new password",
};

export function AuthDialog() {
  const req = useCloud((s) => s.auth);
  // The server is part of the key: it decides which account this is about, so
  // switching servers mid-dialog starts the flow again rather than carrying
  // a half-typed sign-in across.
  const server = useCloud((s) => s.info?.server.url);
  return req ? <AuthFlow key={JSON.stringify({ m: req.mode, e: req.email, s: server })} /> : null;
}

/**
 * What the server this is signing in to says about itself: its name, whether
 * it takes new accounts, and any note from its administrator.
 *
 * Asking is a plain unauthenticated GET /instance, so it costs nothing and
 * sends nothing. On the public server there is nothing worth saying, and on
 * somebody else's there is: the sign-up link is pointless if the server is
 * closed, and "we couldn't send you a code" is baffling without the line
 * explaining that this server has no mail set up.
 */
function useServerInfo() {
  const server = useCloud((s) => s.info?.server);
  const check = useQuery({
    queryKey: ["cloud", "instance", server?.url],
    queryFn: () => api.cloud.serverCheck(server!.url),
    enabled: !!server,
    staleTime: 60_000,
    retry: false,
  });
  return { server, info: check.data ?? null };
}

function AuthFlow() {
  const req = useCloud((s) => s.auth)!;
  const [mode, setMode] = useState<AuthMode>(req.mode ?? "sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState(req.email ?? "");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // After verifying a new account, sign in with the password typed at sign-up.
  const [codeSent, setCodeSent] = useState(false);

  const { server, info: serverInfo } = useServerInfo();
  /** True on anything but the public Kern Cloud: then whose server this is
   * matters, and the screen says so. */
  const ownServer = !!server && server.source !== "default";
  const host = (() => {
    try {
      return new URL(server?.url ?? "").host;
    } catch {
      return server?.url ?? "";
    }
  })();
  /** The server takes no new accounts, so offering a sign-up form would only
   * lead to a refusal nobody could act on. */
  const closed = !!serverInfo && serverInfo.registration !== "open";

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = window.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => window.clearTimeout(t);
  }, [cooldown]);

  const close = () => useCloud.setState({ auth: null });
  const go = (m: AuthMode, msg: string | null = null) => {
    setMode(m);
    setError(null);
    setNotice(msg);
    setCode("");
  };

  const finish = async () => {
    await refreshStatus();
    await refreshMe();
    const then = req.then;
    close();
    toast("Signed in to Kern Cloud", { tone: "success" });
    await then?.();
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof KernError && e.code === "unverified") {
        // Signing in with an unconfirmed email sends a fresh code.
        setCooldown(30);
        go("verify", `Confirm your email to continue. We've sent a new code to ${email.trim()}.`);
      } else setError(errorText(e, "Something went wrong. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = (purpose: "verify" | "sign-in" | "reset", next?: AuthMode) =>
    run(async () => {
      await api.cloud.sendCode(email, purpose);
      setCooldown(30);
      setCodeSent(true);
      if (next) go(next, `We sent a 6-digit code to ${email.trim()}.`);
      else setNotice(`A new code is on its way to ${email.trim()}.`);
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    switch (mode) {
      case "sign-in":
        return void run(async () => {
          await api.cloud.signIn(email, password);
          await finish();
        });
      case "sign-up":
        if (closed)
          return setError(
            serverInfo!.registration === "invite"
              ? `${serverInfo!.name} only takes new accounts by invitation. Ask its administrator for one${serverInfo!.contact ? ` (${serverInfo!.contact})` : ""}.`
              : `${serverInfo!.name} isn't taking new accounts.`,
          );
        if (password.length < 8) return setError("Use at least 8 characters for your password.");
        return void run(async () => {
          await api.cloud.signUp(name, email, password);
          setCooldown(30);
          go("verify", `We sent a 6-digit code to ${email.trim()}. It expires in 10 minutes.`);
        });
      case "verify":
        return void verify(code);
      case "code":
        if (!codeSent) return void sendCode("sign-in");
        return void run(async () => {
          await api.cloud.signInWithCode(email, code);
          await finish();
        });
      case "forgot":
        return void sendCode("reset", "reset");
      case "reset":
        if (password.length < 8) return setError("Use at least 8 characters for your password.");
        if (password !== password2) return setError("The passwords don't match.");
        return void run(async () => {
          await api.cloud.resetPassword(email, code, password);
          await api.cloud.signIn(email, password);
          toast("Password changed. You're signed out everywhere else.");
          await finish();
        });
    }
  };

  const verify = (c: string) =>
    run(async () => {
      if (c.length !== 6) throw new KernError("invalid", "Enter the 6-digit code from the email.");
      await api.cloud.verifyEmail(email, c);
      await finish();
    });

  const s = strength(password);
  const back = (to: AuthMode) => (
    <button type="button" className="auth__back" onClick={() => go(to)}>
      <ArrowLeft size={13} /> Back
    </button>
  );
  const link = (label: string, onClick: () => void) => (
    <button type="button" className="auth__link" onClick={onClick}>
      {label}
    </button>
  );
  const resend = (purpose: "verify" | "sign-in" | "reset") => (
    <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
      Didn't get it? Check spam, or {cooldown > 0 ? <>send another in {cooldown}s</> : link("send a new code", () => void sendCode(purpose))}.
    </span>
  );

  let body: ReactNode;
  let primary = "Continue";
  switch (mode) {
    case "sign-in":
      primary = busy ? "Signing in…" : "Sign in";
      body = (
        <>
          <div className="field">
            <label className="field__label">Email</label>
            <input className="input" type="email" autoComplete="email" autoFocus={!email} value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Password value={password} onChange={setPassword} autoFocus={!!email} />
          <div className="row" style={{ justifyContent: "space-between" }}>
            {link("Forgot password?", () => go("forgot"))}
            {link("Email me a sign-in code", () => {
              setCodeSent(false);
              go("code");
            })}
          </div>
        </>
      );
      break;
    case "sign-up":
      primary = busy ? "Creating…" : "Create account";
      body = (
        <>
          <div className="field">
            <label className="field__label">Your name</label>
            <input className="input" autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown to people you collaborate with" />
          </div>
          <div className="field">
            <label className="field__label">Email</label>
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <Password value={password} onChange={setPassword} autoComplete="new-password" />
          {password && (
            <div className="auth__strength" data-score={s.score}>
              <span className="auth__meter">
                {[0, 1, 2, 3].map((i) => (
                  <i key={i} data-on={i < s.score || undefined} />
                ))}
              </span>
              <span>{s.label}</span>
            </div>
          )}
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            We'll email you a code to confirm the address. Your account is only used for Kern Cloud: offline data and files on this computer are never uploaded unless you choose to copy them.
          </span>
        </>
      );
      break;
    case "verify":
      primary = busy ? "Checking…" : "Confirm email";
      body = (
        <>
          <div className="auth__hero">
            <MailCheck size={22} strokeWidth={1.5} />
            <span>
              Enter the 6-digit code we sent to <strong>{email.trim()}</strong>.
            </span>
          </div>
          <CodeInput value={code} onChange={setCode} onComplete={(c) => void verify(c)} autoFocus />
          {resend("verify")}
        </>
      );
      break;
    case "code":
      primary = codeSent ? (busy ? "Signing in…" : "Sign in") : busy ? "Sending…" : "Email me a code";
      body = (
        <>
          {back("sign-in")}
          <div className="field">
            <label className="field__label">Email</label>
            <input className="input" type="email" autoComplete="email" autoFocus={!codeSent} value={email} onChange={(e) => setEmail(e.target.value)} disabled={codeSent} />
          </div>
          {codeSent && (
            <>
              <CodeInput
                value={code}
                onChange={setCode}
                autoFocus
                onComplete={(c) =>
                  void run(async () => {
                    await api.cloud.signInWithCode(email, c);
                    await finish();
                  })
                }
              />
              {resend("sign-in")}
            </>
          )}
        </>
      );
      break;
    case "forgot":
      primary = busy ? "Sending…" : "Send recovery code";
      body = (
        <>
          {back("sign-in")}
          <span className="muted">Enter your account's email. We'll send a code you can use to choose a new password.</span>
          <div className="field">
            <label className="field__label">Email</label>
            <input className="input" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
        </>
      );
      break;
    case "reset":
      primary = busy ? "Saving…" : "Set new password";
      body = (
        <>
          {back("forgot")}
          <div className="field">
            <label className="field__label">Recovery code</label>
            <CodeInput value={code} onChange={setCode} autoFocus />
          </div>
          <Password value={password} onChange={setPassword} label="New password" autoComplete="new-password" />
          <Password value={password2} onChange={setPassword2} label="Repeat new password" autoComplete="new-password" />
          {resend("reset")}
          <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
            Changing your password signs you out on your other devices.
          </span>
        </>
      );
      break;
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      centered
      className="auth-dialog"
      title={
        <span className="row" style={{ gap: 8 }}>
          <Cloud size={16} strokeWidth={1.75} /> {TITLES[mode]}
        </span>
      }
    >
      <form className="col auth" style={{ gap: 12 }} onSubmit={submit}>
        {req.reason && mode === "sign-in" && <div className="auth__reason">{req.reason}</div>}
        {ownServer && (
          <div className="auth__notice auth__server">
            <span className="row" style={{ gap: 6, fontWeight: 600 }}>
              <Server size={13} /> {serverInfo?.name ?? server!.name}
            </span>
            <span>
              {host} — your account here is separate from every other Kern server.
            </span>
            {serverInfo?.notice && <span>“{serverInfo.notice}”</span>}
            {serverInfo && !serverInfo.sendsEmail && <span>This server can't send email, so codes come from its administrator instead.</span>}
            {serverInfo?.contact && <span>Contact: {serverInfo.contact}</span>}
          </div>
        )}
        {notice && <div className="auth__notice">{notice}</div>}
        {body}
        {error && (
          <div className="auth__error" role="alert">
            {error}
          </div>
        )}
        <Button type="submit" variant="primary" block disabled={busy}>
          {primary}
        </Button>
        {mode === "sign-in" &&
          (closed ? (
            <div className="auth__switch">
              {serverInfo!.registration === "invite"
                ? "New accounts here need an invitation from this server's administrator."
                : "This server isn't taking new accounts."}
            </div>
          ) : (
            <div className="auth__switch">
              New to {serverInfo?.name ?? "Kern Cloud"}? {link("Create an account", () => go("sign-up"))}
            </div>
          ))}
        {mode === "sign-up" && (
          <div className="auth__switch">
            Already have an account? {link("Sign in", () => go("sign-in"))}
          </div>
        )}
        {mode === "verify" && <div className="auth__switch">{link("Use a different email", () => go("sign-up"))}</div>}
      </form>
    </Dialog>
  );
}
