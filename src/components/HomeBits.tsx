/** Small pieces shared by Home and its calendar. */
import type { ReactNode } from "react";
import { useStore } from "../store";

export function Empty({ children }: { children: ReactNode }) {
  return <p className="hempty">{children}</p>;
}

export function open(threadId: string) {
  useStore.getState().select(threadId);
}
