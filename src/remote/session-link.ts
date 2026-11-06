import { appBaseURL } from "../config.js";

export interface SessionRegistration {
  threadId: string;
  /** Storage KG the session records into ("" = Personal Space). Never an app alias. */
  kgID?: string;
  /** The app graph picker's alias for kgID, or "" when the caller cannot select it. */
  graphAlias?: string;
}

/**
 * The app's graph selector takes its public alias, not a storage KG ID. A
 * session recording into a graph with no selectable alias gets no link: a bare
 * `/chat/<id>` would open Personal Space, where the thread does not live.
 */
export function remoteSessionURL(session: SessionRegistration): string | undefined {
  const base = `${appBaseURL()}/chat/${encodeURIComponent(session.threadId)}`;
  if (session.graphAlias) return `${base}?graph=${encodeURIComponent(session.graphAlias)}`;
  return session.kgID ? undefined : base;
}

export const UNLINKABLE_SESSION_NOTICE = "session link unavailable: this endpoint records to a workspace you cannot open in the Ditto app; the session still runs here";
