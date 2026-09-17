/**
 * Writes a status note to stderr without garbling a full-screen TUI that is
 * redrawing on stdout. A terminal is one character grid: a note landing
 * between two of the harness's paint calls is pasted at the cursor position —
 * i.e. on top of the agent's text — and the next cursor-home repaint strands
 * the fragment (see issue #61).
 *
 * While a TUI session is active, a note is held until the harness has been
 * quiet for a beat (between frames / between turns), then written wrapped in
 * save/restore cursor (DECSC/DECRC) so it leaves the cursor where the harness
 * left it. When nothing owns the screen the note is written straight through.
 * Anything still held when the harness exits flushes bare: nothing repaints
 * after exit, so the epilogue cannot collide with a frame.
 */
const DECSC = "7";
const DECRC = "8";

let active = false;
let pending: string[] = [];
let timer: NodeJS.Timeout | undefined;
/** Milliseconds of screen silence after which a note is safe to print. */
let quietMs = 250;
/** Reports how long the harness has not painted; null when no session. */
let quietFor: (() => number) | null = null;

function flushPending(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  const lines = pending;
  pending = [];
  for (const line of lines) process.stderr.write(`${DECSC}${line}${DECRC}`);
}

function scheduleFlush(): void {
  if (timer) return;
  const tick = () => {
    timer = undefined;
    if (!active) return;
    if (!quietFor || quietFor() >= quietMs) flushPending();
    else scheduleFlush();
  };
  timer = setTimeout(tick, Math.max(20, quietMs / 5));
  timer.unref?.();
}

/** Call when a TUI harness takes over the screen; notes defer until it is quiet. */
export function holdNotesForTui(quietProbe: () => number, holdQuietMs = 250): void {
  active = true;
  quietFor = quietProbe;
  quietMs = holdQuietMs;
  scheduleFlush();
}

/** Call when the harness exits; flushes anything still deferred, bare. */
export function releaseNotes(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (!active) return;
  active = false;
  quietFor = null;
  const lines = pending;
  pending = [];
  for (const line of lines) process.stderr.write(line);
}

export function writeNote(line: string): void {
  if (!active) {
    process.stderr.write(line);
    return;
  }
  pending.push(line);
  scheduleFlush();
}

/** Test hook. */
export function pendingNoteCount(): number {
  return pending.length;
}
