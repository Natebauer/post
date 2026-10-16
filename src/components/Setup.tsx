import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, Check, ChevronDown, Copy, ExternalLink, FileJson, Loader2, ShieldAlert } from "lucide-react";
import { api, errText } from "../api";
import { useStore } from "../store";
import { ACCENTS } from "../theme";
import { cx } from "../util";
import { WindowControls } from "./TitleBar";

/*
 * First-run onboarding, in five steps (the dots at the top of each card):
 *   1. Welcome            (Intro)
 *   2. Connect to Google  (ClientSetup: a checklist for the user's own Google Cloud OAuth client)
 *   3. Sign in            (SignIn: with help for Google's warning and for whatever goes wrong)
 *   4. Make it yours      (Welcome: look, AI, start with Windows, notifications, default email app)
 *   5. A short tour       (Tour, over the real app)
 * Steps 4 and 5 only follow a first sign-in; reconnecting an account goes straight back to mail.
 */

const STEPS = ["Welcome", "Connect", "Sign in", "Make it yours", "Tour"];

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 1024 1024" aria-hidden>
      <rect x="64" y="64" width="896" height="896" rx="210" fill="var(--accent)" />
      <rect x="236" y="318" width="552" height="388" rx="64" fill="none" stroke="#fff" strokeWidth="56" strokeLinejoin="round" />
      <path d="M262 356 L512 540 L762 356" fill="none" stroke="#fff" strokeWidth="56" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <div className="titlebar" data-tauri-drag-region>
        <div className="drag" data-tauri-drag-region />
        <WindowControls />
      </div>
      <div className="setup">{children}</div>
    </div>
  );
}

/** Where this card sits in the five steps. */
function Progress({ at }: { at: number }) {
  return (
    <ol className="ob-dots" aria-label={`Step ${at + 1} of ${STEPS.length}: ${STEPS[at]}`}>
      {STEPS.map((s, i) => (
        <li key={s} className={cx(i < at && "done", i === at && "now")} title={s} />
      ))}
    </ol>
  );
}

const open = (url: string) => void openUrl(url).catch(() => {});

/* ---------------- remembered progress ---------------- */

/** Setup progress survives closing Post halfway (it's only a convenience, so storage may fail). */
const KEY = "post.onboarding";
interface Saved {
  started?: boolean;
  done?: number[];
}
function load(): Saved {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Saved;
  } catch {
    return {};
  }
}
function save(p: Saved) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...load(), ...p }));
  } catch {
    /* fine without it */
  }
}

/* ---------------- 1. Welcome ---------------- */

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <div className="setup-card ob-intro">
      <Progress at={0} />
      <Logo />
      <h1>Welcome to Post</h1>
      <p>A calm Gmail client that lives on your computer. Your mail is stored and searched right here, and Post talks to Gmail directly, with nothing in between.</p>
      <p>
        Setting up takes about ten minutes, once: Google asks every app that reads Gmail to have its own sign-in, so
        you'll create one for Post in Google Cloud. Post walks you through each step.
      </p>
      <button className="btn primary" onClick={onStart}>
        Get started
      </button>
    </div>
  );
}

/* ---------------- 2. Connect to Google ---------------- */

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const APIS: [string, string, string][] = [
  ["Gmail API", "gmail.googleapis.com", "your mail"],
  ["People API", "people.googleapis.com", "contacts and their photos"],
  ["Google Calendar API", "calendar-json.googleapis.com", "the calendar on Home"],
];

/** The Client ID and secret from Google's downloaded client file (Desktop app, or Web by mistake). */
function readClientFile(text: string): { id: string; secret: string } | null {
  try {
    const j = JSON.parse(text);
    const c = j.installed ?? j.web;
    if (c?.client_id && c?.client_secret) return { id: String(c.client_id), secret: String(c.client_secret) };
  } catch {
    /* not JSON */
  }
  return null;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn outline sm"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          window.setTimeout(() => setDone(false), 1600);
        })
      }
    >
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? "Copied" : label}
    </button>
  );
}

/** One step of the Google checklist: open while it's the current one, ticked off when done. */
function Step({
  n,
  title,
  done,
  current,
  onToggle,
  onDone,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  current: boolean;
  onToggle: () => void;
  onDone?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={cx("ob-step", done && "done", current && "current")}>
      <button className="ob-step-head" onClick={onToggle} aria-expanded={current}>
        <span className="ob-num">{done ? <Check size={13} strokeWidth={3} /> : n}</span>
        <span className="ob-step-title">{title}</span>
        <ChevronDown size={15} className="ob-chev" />
      </button>
      {current && (
        <div className="ob-step-body">
          {children}
          {onDone && (
            <button className="btn primary sm ob-next" onClick={onDone}>
              Done, next step
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function ClientSetup() {
  const [started, setStarted] = useState(() => !!load().started);
  const [done, setDone] = useState<Set<number>>(() => new Set(load().done ?? []));
  const [current, setCurrent] = useState(() => [1, 2, 3, 4].find((n) => !(load().done ?? []).includes(n)) ?? 4);
  const [id, setId] = useState("");
  const [secret, setSecret] = useState("");
  const [fromFile, setFromFile] = useState(false);
  const [manual, setManual] = useState(false);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const init = useStore((s) => s.init);
  const editing = useStore((s) => s.editClient);

  if (!started && !editing)
    return (
      <Frame>
        <Intro
          onStart={() => {
            save({ started: true });
            setStarted(true);
          }}
        />
      </Frame>
    );

  const finish = (n: number) => {
    const next = new Set(done).add(n);
    setDone(next);
    save({ done: [...next] });
    setCurrent([1, 2, 3, 4].find((s) => !next.has(s)) ?? 4);
  };

  const takeFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    const c = readClientFile(await f.text());
    if (!c) return setErr("That isn't Google's client file. Download it from the client you created (the ⤓ JSON button).");
    setId(c.id);
    setSecret(c.secret);
    setFromFile(true);
  };

  const submit = async () => {
    setErr(null);
    if (!id.trim().endsWith(".apps.googleusercontent.com"))
      return setErr("A Client ID ends in .apps.googleusercontent.com. Check you copied the whole thing.");
    setBusy(true);
    try {
      await api.setClient(id.trim(), secret.trim());
      save({ done: [1, 2, 3, 4] });
      useStore.setState({ editClient: false });
      await init();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame>
      <div className="setup-card ob-wide">
        <Progress at={1} />
        {editing && (
          <button className="link-btn ob-back" onClick={() => useStore.setState({ editClient: false })}>
            <ArrowLeft size={13} /> Back to sign-in
          </button>
        )}
        <h1>Connect Post to Google</h1>
        <p>
          Four steps in Google Cloud, each with a button that opens the right page. Sign in there with the Gmail account
          you'll use in Post. Post remembers where you got to.
        </p>

        <Step n={1} title="Create a project" done={done.has(1)} current={current === 1} onToggle={() => setCurrent(1)} onDone={() => finish(1)}>
          <p>Name it <b>Post</b> and click <b>Create</b>. Then check it's the selected project at the top of the page.</p>
          <button className="btn outline" onClick={() => open("https://console.cloud.google.com/projectcreate")}>
            <ExternalLink size={14} /> New project
          </button>
        </Step>

        <Step n={2} title="Turn on three APIs" done={done.has(2)} current={current === 2} onToggle={() => setCurrent(2)} onDone={() => finish(2)}>
          <p>Open each and click <b>Enable</b>.</p>
          <div className="ob-apis">
            {APIS.map(([name, id, why]) => (
              <button key={id} className="ob-api" onClick={() => open(`https://console.cloud.google.com/apis/library/${id}`)}>
                <ExternalLink size={14} />
                <span>
                  <b>{name}</b>
                  <small>For {why}</small>
                </span>
              </button>
            ))}
          </div>
        </Step>

        <Step n={3} title="Set up Google sign-in" done={done.has(3)} current={current === 3} onToggle={() => setCurrent(3)} onDone={() => finish(3)}>
          <ol className="ob-list">
            <li>
              <button className="link-btn" onClick={() => open("https://console.cloud.google.com/auth/overview")}>
                Open Google Auth Platform
              </button>{" "}
              and click <b>Get started</b>. App name <b>Post</b>, your email twice, audience <b>External</b>, then{" "}
              <b>Create</b>.
            </li>
            <li>
              In{" "}
              <button className="link-btn" onClick={() => open("https://console.cloud.google.com/auth/scopes")}>
                Data access
              </button>
              , click <b>Add or remove scopes</b>, paste these into <b>Manually add scopes</b>, then <b>Add to table</b>{" "}
              and <b>Save</b>:
              <div className="ob-scopes">
                <code>{SCOPES.join("\n")}</code>
                <CopyButton text={SCOPES.join("\n")} label="Copy all four" />
              </div>
            </li>
            <li>
              In{" "}
              <button className="link-btn" onClick={() => open("https://console.cloud.google.com/auth/audience")}>
                Audience
              </button>
              , add your Gmail address under <b>Test users</b>, then click <b>Publish app</b>. (Without publishing,
              Google signs you out every week.)
            </li>
          </ol>
        </Step>

        <Step n={4} title="Create Post's client and bring it here" done={false} current={current === 4} onToggle={() => setCurrent(4)}>
          <p>
            In{" "}
            <button className="link-btn" onClick={() => open("https://console.cloud.google.com/auth/clients/create")}>
              Clients
            </button>
            , choose <b>Desktop app</b>, name it <b>Post</b> and click <b>Create</b>. Click <b>Download JSON</b>, then drop
            the file here.
          </p>
          <div
            className={cx("ob-drop", drag && "over", fromFile && "got")}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void takeFile(e.dataTransfer.files[0]);
            }}
            onClick={() => fileInput.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileInput.current?.click()}
          >
            <FileJson size={22} />
            {fromFile ? (
              <span>
                <b>Got it.</b> Client {id.slice(0, 14)}… is ready.
              </span>
            ) : (
              <span>
                <b>Drop the client file here</b> or click to choose it (client_secret_….json)
              </span>
            )}
            <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={(e) => void takeFile(e.target.files?.[0])} />
          </div>
          <button className="link-btn ob-manual" onClick={() => setManual(!manual)}>
            {manual ? "Hide" : "Or paste the Client ID and secret instead"}
          </button>
          {manual && (
            <>
              <div className="field">
                <label htmlFor="cid">Client ID</label>
                <input id="cid" className="input" value={id} onChange={(e) => setId(e.target.value)} placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} />
              </div>
              <div className="field">
                <label htmlFor="csec">Client secret</label>
                <input id="csec" className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="GOCSPX-…" spellCheck={false} />
              </div>
            </>
          )}
          {err && <p className="error">{err}</p>}
          <button className="btn primary" disabled={!id.trim() || !secret.trim() || busy} onClick={() => void submit()}>
            {busy ? <Loader2 size={15} className="spin" /> : null} Continue to sign-in
          </button>
        </Step>
        <p className="faint ob-foot">
          Stuck? The same steps, in more detail and with troubleshooting, are in{" "}
          <button className="link-btn" onClick={() => open("https://github.com/Natebauer/post/blob/main/SETUP.md")}>
            the setup guide
          </button>
          .
        </p>
      </div>
    </Frame>
  );
}

/* ---------------- 3. Sign in ---------------- */

/** What went wrong signing in, in plain words, and where to fix it. */
function signInHelp(e: string): { text: string; fix?: [string, () => void] } {
  const editClient: [string, () => void] = ["Check the client", () => useStore.setState({ editClient: true })];
  if (/invalid_client|unauthorized_client|Token exchange failed/i.test(e))
    return { text: "Google didn't accept Post's Client ID or secret. They may be mistyped, or from a different client.", fix: editClient };
  if (/SERVICE_DISABLED|has not been used|accessNotConfigured/i.test(e))
    return {
      text: "The Gmail API isn't turned on in your Google Cloud project yet.",
      fix: ["Turn on the Gmail API", () => open("https://console.cloud.google.com/apis/library/gmail.googleapis.com")],
    };
  if (/Timed out/i.test(e))
    return {
      text: "Post didn't hear back from Google. If the browser said \"Access blocked\", add yourself as a test user and publish the app, then try again.",
      fix: ["Open Audience", () => open("https://console.cloud.google.com/auth/audience")],
    };
  if (/cancelled/i.test(e)) return { text: "Sign-in was cancelled in the browser. Try again, and tick every permission Google asks about." };
  return { text: e };
}

/** A sketch of Google's "unverified app" screen, showing where to click. */
function UnverifiedSketch() {
  return (
    <div className="ob-sketch" aria-label="Google's warning screen: click Advanced, then Go to Post (unsafe)">
      <div className="ob-sk-title">
        <ShieldAlert size={16} /> Google hasn't verified this app
      </div>
      <div className="ob-sk-lines">
        <i />
        <i />
      </div>
      <div className="ob-sk-row">
        <span className="ob-sk-link ob-sk-hit">
          Advanced <em>1</em>
        </span>
        <span className="ob-sk-btn">Back to safety</span>
      </div>
      <div className="ob-sk-link ob-sk-hit ob-sk-go">
        Go to Post (unsafe) <em>2</em>
      </div>
    </div>
  );
}

export function SignIn({ reconnect }: { reconnect?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [trouble, setTrouble] = useState(false);
  const init = useStore((s) => s.init);

  // If the sign-in check was a temporary hiccup, recover on our own instead of
  // waiting for the user to sign in again.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (busy) return;
      api
        .appState()
        .then((info) => {
          if (info.signedIn) {
            useStore.setState({ authProblem: false });
            void init();
          }
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(t);
  }, [busy, init]);

  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.signIn();
      // A first sign-in (not a reconnect) goes on to "Make it yours" and the tour.
      useStore.setState({ authProblem: false, welcome: !reconnect });
      await init();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (reconnect)
    return (
      <Frame>
        <div className="setup-card">
          <Logo />
          <h1>Reconnect your account</h1>
          <p>Google asked Post to sign in again. Your local mail is still here.</p>
          {err && <p className="error">{signInHelp(err).text}</p>}
          <button className="btn primary" disabled={busy} onClick={() => void go()}>
            {busy ? (
              <>
                <Loader2 size={15} className="spin" /> Waiting for your browser…
              </>
            ) : (
              "Sign in with Google"
            )}
          </button>
        </div>
      </Frame>
    );

  const help = err ? signInHelp(err) : null;
  return (
    <Frame>
      <div className="setup-card ob-wide">
        <Progress at={2} />
        <button className="link-btn ob-back" onClick={() => useStore.setState({ editClient: true })}>
          <ArrowLeft size={13} /> Back to Google setup
        </button>
        <h1>Sign in with Google</h1>
        <p>
          Your browser opens Google's sign-in. Because Post is your own app, Google first shows a warning. That's
          expected: click <b>Advanced</b>, then <b>Go to Post (unsafe)</b>. Then tick <b>every</b> permission and click{" "}
          <b>Continue</b>.
        </p>
        <UnverifiedSketch />
        {help && (
          <div className="ob-help" role="alert">
            <p>{help.text}</p>
            {help.fix && (
              <button className="btn outline sm" onClick={help.fix[1]}>
                {help.fix[0]}
              </button>
            )}
          </div>
        )}
        <div className="ob-actions">
          <button className="btn primary" disabled={busy} onClick={() => void go()}>
            {busy ? (
              <>
                <Loader2 size={15} className="spin" /> Waiting for your browser…
              </>
            ) : err ? (
              "Try again"
            ) : (
              "Sign in with Google"
            )}
          </button>
          <button className="link-btn" onClick={() => setTrouble(!trouble)}>
            Having trouble?
          </button>
        </div>
        {trouble && (
          <ul className="ob-trouble">
            <li>
              <b>"Access blocked"</b> in the browser: add yourself as a test user and publish the app.{" "}
              <button className="link-btn" onClick={() => open("https://console.cloud.google.com/auth/audience")}>
                Open Audience
              </button>
            </li>
            <li>
              <b>"redirect_uri_mismatch"</b>: the client was made as a Web application. Create a <b>Desktop app</b> client.{" "}
              <button className="link-btn" onClick={() => useStore.setState({ editClient: true })}>
                Use a different client
              </button>
            </li>
            <li>
              <b>Nothing happened</b> after signing in: come back to this window; Post finishes on its own. If it still
              waits, click Sign in again.
            </li>
          </ul>
        )}
      </div>
    </Frame>
  );
}

/* ---------------- 4. Make it yours ---------------- */

export function Welcome() {
  const settings = useStore((s) => s.settings);
  const saveSettings = useStore((s) => s.saveSettings);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mailto, setMailto] = useState<string | null>(null);

  const connectAi = async () => {
    setBusy(true);
    setAiMsg(null);
    try {
      await api.setAiKey(key.trim());
      await api.testAi();
      await saveSettings({ aiEnabled: true });
      setKey("");
      setAiMsg({ ok: true, text: "Connected. The AI assistant is in the sidebar (Ctrl+J)." });
    } catch (e) {
      setAiMsg({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const finish = () => useStore.setState({ welcome: false, tour: true });

  return (
    <Frame>
      <div className="setup-card ob-wide">
        <Progress at={3} />
        <h1>You're in. Make it yours</h1>
        <p>Your inbox is loading in the background. Everything here is optional, and all of it is also in Settings.</p>

        <div className="welcome-step">
          <h2>Look</h2>
          <div className="ob-look">
            <div className="seg" role="radiogroup" aria-label="Theme">
              {(
                [
                  ["system", "Like Windows"],
                  ["light", "Light"],
                  ["dark", "Dark"],
                ] as const
              ).map(([v, label]) => (
                <button key={v} role="radio" aria-checked={settings?.theme === v} className={cx(settings?.theme === v && "on")} onClick={() => void saveSettings({ theme: v })}>
                  {label}
                </button>
              ))}
            </div>
            <div className="swatches" role="radiogroup" aria-label="Accent color">
              {ACCENTS.map((a) => (
                <button
                  key={a.value}
                  role="radio"
                  className={cx("swatch", settings?.accent.toLowerCase() === a.value && "on")}
                  style={{ background: a.value }}
                  title={a.name}
                  aria-label={a.name}
                  aria-checked={settings?.accent.toLowerCase() === a.value}
                  onClick={() => void saveSettings({ accent: a.value })}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="welcome-step">
          <h2>Turn on AI</h2>
          <p>
            Ask questions about your mail, draft replies, summarize emails, sort mail into sections, or tell it what to do
            ("archive the shipping notices", "accept these invites") and confirm. It uses your own Anthropic API key; most
            requests cost about a cent, and you set a monthly cap.
          </p>
          <button className="btn ghost" style={{ margin: "0 0 10px -10px" }} onClick={() => open("https://console.anthropic.com/settings/keys")}>
            <ExternalLink size={14} /> Get a key at console.anthropic.com
          </button>
          <div className="welcome-row">
            <input
              className="input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-…"
              aria-label="Anthropic API key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && !busy && void connectAi()}
            />
            <button className="btn outline" disabled={!key.trim() || busy} onClick={() => void connectAi()}>
              {busy ? (
                <>
                  <Loader2 size={14} className="spin" /> Checking…
                </>
              ) : (
                "Connect"
              )}
            </button>
          </div>
          {aiMsg && <p className={aiMsg.ok ? "welcome-ok" : "error"}>{aiMsg.text}</p>}
        </div>

        <div className="welcome-step">
          <h2>Everyday</h2>
          <label className="ob-check">
            <input type="checkbox" checked={!!settings?.launchAtStartup} onChange={(e) => void saveSettings({ launchAtStartup: e.target.checked })} />
            <span>
              <b>Start with Windows</b>
              <small>Post waits quietly in the tray so new mail arrives right away.</small>
            </span>
          </label>
          <label className="ob-check">
            <input type="checkbox" checked={!!settings?.notifications} onChange={(e) => void saveSettings({ notifications: e.target.checked })} />
            <span>
              <b>Notify me about new mail</b>
              <small>A Windows notification for each new email, with Mark as read.</small>
            </span>
          </label>
          <div className="ob-check">
            <button
              className="btn outline sm"
              onClick={() =>
                void api
                  .makeDefaultMailApp()
                  .then(() => setMailto("Windows Settings opened: set Post as the app for Email (mailto) there."))
                  .catch((e) => setMailto(errText(e)))
              }
            >
              Make Post the default email app
            </button>
            {mailto && <small className="welcome-ok">{mailto}</small>}
          </div>
        </div>

        <button className="btn primary" onClick={finish}>
          Continue
        </button>
      </div>
    </Frame>
  );
}

/* ---------------- 5. The tour ---------------- */

const TOUR: { sel: string; title: string; text: string }[] = [
  {
    sel: ".read-pane",
    title: "This is Home",
    text: "Your calendar, pinned emails and what's waiting on you. Open an email and it shows here; close it to come back.",
  },
  {
    sel: "[data-ask]",
    title: "Your AI assistant",
    text: "Ask about your mail, or tell it what to do: draft a reply, archive a batch, accept invitations. It always asks before changing anything. Ctrl+J.",
  },
  {
    sel: ".sidebar",
    title: "Sections for the people you care about",
    text: "Drag an email onto the sidebar to give its sender their own section. Drop it on Home to pin it.",
  },
  {
    sel: ".search-wrap",
    title: "Search, and everything else",
    text: "Search all your mail here, even while it's still indexing. Press Ctrl+K for every command.",
  },
];

/** A few notes over the real app after setup, each pointing at what it describes. */
export function Tour() {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<DOMRect | null>(null);
  const stop = () => useStore.setState({ tour: false });
  const step = TOUR[i];

  useEffect(() => {
    const measure = () => setBox(document.querySelector(step.sel)?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("resize", measure);
    const t = window.setTimeout(measure, 300);
    return () => {
      window.removeEventListener("resize", measure);
      window.clearTimeout(t);
    };
  }, [step.sel]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && stop();
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  // The note sits beside the highlighted area (right, else left), and only over it when neither fits.
  const W = 320;
  const pad = 6;
  const top = box ? Math.min(Math.max(box.top + 24, 16), window.innerHeight - 220) : 0;
  const pos: React.CSSProperties = !box
    ? { left: "50%", top: "40%", transform: "translate(-50%, -50%)" }
    : box.right + W + 24 < window.innerWidth
      ? { left: box.right + 16, top }
      : box.left - W - 24 > 0
        ? { left: box.left - W - 16, top }
        : { left: Math.max(16, Math.min(box.left + 24, window.innerWidth - W - 16)), top };

  return (
    <div className="ob-tour" role="dialog" aria-modal="true" aria-label={`Tour: ${step.title}`}>
      {box && (
        <div
          className="ob-tour-hole"
          style={{ left: box.left - pad, top: box.top - pad, width: box.width + pad * 2, height: box.height + pad * 2 }}
        />
      )}
      <div className="ob-tour-note" style={{ ...pos, width: W }} key={i}>
        <div className="ob-tour-count">
          {i + 1} of {TOUR.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.text}</p>
        <div className="ob-tour-bar">
          <button className="link-btn" onClick={stop}>
            Skip tour
          </button>
          <button className="btn primary sm" autoFocus onClick={() => (i + 1 < TOUR.length ? setI(i + 1) : stop())}>
            {i + 1 < TOUR.length ? "Next" : "Start using Post"}
          </button>
        </div>
      </div>
    </div>
  );
}
