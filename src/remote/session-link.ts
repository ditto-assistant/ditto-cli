import { appBaseURL } from "../config.js";

/** The app's graph selector takes its public alias, not a storage KG ID. */
export function remoteSessionURL(session: { threadId: string; graphAlias?: string }): string {
  const base = `${appBaseURL()}/chat/${encodeURIComponent(session.threadId)}`;
  return session.graphAlias ? `${base}?graph=${encodeURIComponent(session.graphAlias)}` : base;
}
