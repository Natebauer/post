import { AlertCircle, CalendarClock, Pencil, Send, X } from "lucide-react";
import { api, errText, type OutboxItem } from "../api";
import { fromComposeData, openCompose } from "../compose";
import { useStore } from "../store";
import { cx, longDate, sanitizeHtml, whenLabel } from "../util";
import { EmptyArt } from "./EmptyArt";

const key = (o: OutboxItem) => `outbox:${o.id}`;

async function edit(o: OutboxItem) {
  const back = await api.cancelSend(o.id);
  if (back) await openCompose(fromComposeData(back));
  else useStore.getState().snack({ text: "That message has already been sent" });
}

async function sendNow(o: OutboxItem) {
  const back = await api.cancelSend(o.id);
  if (back) {
    await api.queueSend(back, null);
    useStore.getState().snack({ text: "Sending now" });
  }
}

async function cancel(o: OutboxItem) {
  const back = await api.cancelSend(o.id);
  if (back) {
    useStore.getState().snack({
      text: "Scheduled send canceled",
      action: { label: "Undo", run: () => void api.queueSend(back, o.sendAt) },
    });
  }
}

function run(f: (o: OutboxItem) => Promise<void>, o: OutboxItem) {
  useStore.getState().select(null);
  void f(o)
    .catch((e) => useStore.getState().snack({ text: errText(e) }))
    .finally(() => void useStore.getState().loadThreads());
}

export function ScheduledList() {
  const outbox = useStore((s) => s.outbox);
  const selectedId = useStore((s) => s.selectedId);
  return (
    <section className="list-pane" aria-label="Scheduled">
      <div className="list-head">
        <h2>Scheduled</h2>
        <span className="sub">{outbox.length ? `${outbox.length} waiting` : ""}</span>
      </div>
      <div className="list-scroll" style={{ contain: "none" }} role="listbox" aria-label="Scheduled messages">
        {outbox.length === 0 ? (
          <div className="empty">
            <div>
              <EmptyArt kind="scheduled" />
              <div className="big">Nothing scheduled</div>
              Use the arrow next to Send to schedule a message.
            </div>
          </div>
        ) : (
          outbox.map((o) => (
            <div
              key={o.id}
              role="option"
              aria-selected={selectedId === key(o)}
              className={cx("row", selectedId === key(o) && "checked")}
              style={{ position: "relative" }}
              onClick={() => useStore.getState().select(key(o))}
            >
              <span className="avatar" aria-hidden>
                {o.status === "failed" ? <AlertCircle size={17} color="var(--danger)" /> : <CalendarClock size={17} />}
              </span>
              <div className="row-main">
                <div className="row-line">
                  <span className="row-from">
                    To {o.compose.to.map((a) => a.name || a.email).join(", ") || "(no recipients)"}
                  </span>
                  <span className="row-date" style={o.status === "failed" ? { color: "var(--danger)" } : undefined}>
                    {o.status === "failed" ? "Failed" : whenLabel(o.sendAt)}
                  </span>
                </div>
                <div className="row-line">
                  <span className="row-sub">
                    <span className="subj">{o.compose.subject || "(no subject)"}</span>
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function ScheduledView({ id }: { id: number }) {
  const o = useStore((s) => s.outbox.find((x) => x.id === id));
  if (!o) {
    return (
      <div className="empty">
        <div className="big">That message has been sent</div>
      </div>
    );
  }
  return (
    <>
      <div className="read-head" role="toolbar" aria-label="Scheduled message actions">
        <button className="icon-btn" title="Close" aria-label="Close" onClick={() => useStore.getState().select(null)}>
          <X size={17} />
        </button>
        <div className="spacer" />
        <button className="icon-btn labeled" title="Edit" aria-label="Edit" onClick={() => run(edit, o)}>
          <Pencil size={16} />
          <span className="tb-label">Edit</span>
        </button>
        <button className="icon-btn labeled" title="Send now" aria-label="Send now" onClick={() => run(sendNow, o)}>
          <Send size={16} />
          <span className="tb-label">Send now</span>
        </button>
        <button className="icon-btn labeled" title="Cancel send" aria-label="Cancel send" onClick={() => run(cancel, o)}>
          <X size={16} />
          <span className="tb-label">Cancel</span>
        </button>
      </div>
      <div className="read-scroll">
        <div className="read-inner enter" key={o.id}>
          <h1 className="thread-subject">{o.compose.subject || "(no subject)"}</h1>
          <div className="snooze-note" style={o.status === "failed" ? { color: "var(--danger)" } : undefined}>
            {o.status === "failed" ? (
              <>
                <AlertCircle size={14} /> Couldn't send: {o.error}
              </>
            ) : (
              <>
                <CalendarClock size={14} /> Sends {longDate(o.sendAt)}
              </>
            )}
          </div>
          <div className="msg-meta" style={{ marginBottom: 16 }}>
            To {o.compose.to.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ")}
            {o.compose.cc.length > 0 && ` · Cc ${o.compose.cc.map((a) => a.email).join(", ")}`}
          </div>
          <div className="msg-text" style={{ whiteSpace: "normal" }} dangerouslySetInnerHTML={{ __html: sanitizeHtml(o.compose.html) }} />
        </div>
      </div>
    </>
  );
}
