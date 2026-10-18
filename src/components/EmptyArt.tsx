/**
 * Small line drawings for empty lists. They draw in the text color with one accent detail, so
 * they follow the mood and theme.
 */
export type EmptyKind = "inbox" | "snoozed" | "sent" | "drafts" | "trash" | "spam" | "search" | "scheduled";

const A = { stroke: "var(--accent)" };

const ART: Record<EmptyKind, JSX.Element> = {
  // A sun rising over a quiet horizon: inbox zero.
  inbox: (
    <>
      <path d="M14 70h68" />
      <path d="M22 78h52" opacity=".5" />
      <path d="M30 70a18 18 0 0 1 36 0" style={A} />
      <path d="M48 36v-8M28 44l-5-5M68 44l5-5M20 58h-7M83 58h-7" style={A} opacity=".7" />
    </>
  ),
  // A crescent moon and a couple of stars.
  snoozed: (
    <>
      <path d="M58 22a26 26 0 1 0 18 40 22 22 0 0 1-18-40Z" />
      <path d="M24 26v8M20 30h8" style={A} />
      <path d="M78 18v6M75 21h6" style={A} opacity=".7" />
      <circle cx="30" cy="70" r="1.5" style={A} />
    </>
  ),
  // A paper plane on a looping trail.
  sent: (
    <>
      <path d="M80 20 18 44l22 8 4 20 10-14 16 10Z" />
      <path d="m40 52 40-32" opacity=".6" />
      <path d="M36 80c-10 0-18-4-20-10" style={A} strokeDasharray="3 5" />
    </>
  ),
  // A sheet with a pencil resting on it.
  drafts: (
    <>
      <rect x="22" y="16" width="44" height="60" rx="4" />
      <path d="M32 32h24M32 42h24M32 52h14" opacity=".55" />
      <path d="m58 74 22-22 6 6-22 22-8 2Z" style={A} />
    </>
  ),
  // An empty bin.
  trash: (
    <>
      <path d="M26 30h44M40 30v-6h16v6" />
      <path d="M30 30l4 46h28l4-46" />
      <path d="M42 42v24M54 42v24" opacity=".5" />
      <path d="M74 20l3-3M80 28h4" style={A} />
    </>
  ),
  // A shield with a check.
  spam: (
    <>
      <path d="M48 16 74 26v20c0 16-11 28-26 34-15-6-26-18-26-34V26Z" />
      <path d="m37 47 8 8 15-16" style={A} />
    </>
  ),
  // A magnifier over nothing.
  search: (
    <>
      <circle cx="42" cy="42" r="20" />
      <path d="m57 57 17 17" />
      <path d="M34 38a10 10 0 0 1 8-6" style={A} />
    </>
  ),
  // A clock with a paper plane hand.
  scheduled: (
    <>
      <circle cx="48" cy="48" r="28" />
      <path d="M48 32v16l10 6" style={A} />
      <path d="M48 16v4M48 76v4M16 48h4M76 48h4" opacity=".5" />
    </>
  ),
};

export function EmptyArt({ kind }: { kind: EmptyKind }) {
  return (
    <svg
      className="empty-art"
      viewBox="0 0 96 96"
      width="88"
      height="88"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ART[kind]}
    </svg>
  );
}
