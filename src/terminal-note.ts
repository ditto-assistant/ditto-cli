import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";

/**
 * Writes a status note to stderr without painting over a full-screen TUI.
 *
 * A terminal is one character grid, and a write lands wherever the cursor is.
 * While Claude Code or Codex owns the screen that is the harness's own input
 * caret, so a note shows up inside its prompt box, the harness's renderer does
 * not know the characters are there and leaves them stranded until it redraws
 * that line, and a trailing newline on the last row scrolls its whole frame
 * up (issue #61, DITTO-249). No timing or save/restore-cursor trick fixes
 * that, so while a TUI session is active nothing is written to the terminal:
 * notes are appended to notesLogPath() and replayed on stderr when the harness
 * exits and nothing repaints any more. When nothing owns the screen a note is
 * written straight through.
 */

let active = false;
let pending: string[] = [];

export interface NoteOptions {
  /**
   * Only meaningful while it is current ("remote control on"): logged, but not
   * replayed after the harness exits, where it would read as stale news.
   */
  transient?: boolean;
}

/** Where notes go while a TUI owns the screen. */
export function notesLogPath(): string {
  return path.join(configDir(), "logs", "notes.log");
}

// Strips SGR colour codes for the log file.
const SGR = /\u001b\[[0-9;]*m/g;

function appendToLog(line: string): void {
  try {
    const file = notesLogPath();
    mkdirSync(path.dirname(file), { recursive: true });
    const text = line.replace(SGR, "").trimEnd();
    if (text) appendFileSync(file, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // A status note is never worth failing the session over.
  }
}

/** Call when a TUI harness takes over the screen; notes go to the log until it exits. */
export function holdNotesForTui(): void {
  active = true;
}

/** Call when the harness exits; replays the notes held while it ran. */
export function releaseNotes(): void {
  if (!active) return;
  active = false;
  const lines = pending;
  pending = [];
  for (const line of lines) process.stderr.write(line);
}

export function writeNote(line: string, options: NoteOptions = {}): void {
  if (!active) {
    process.stderr.write(line);
    return;
  }
  appendToLog(line);
  if (!options.transient) pending.push(line);
}

/** Test hook. */
export function pendingNoteCount(): number {
  return pending.length;
}
