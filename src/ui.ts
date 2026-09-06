/**
 * Minimal terminal styling for the CLI's human-facing output. No dependency:
 * plain SGR codes, gated on the stream being a TTY and on the usual
 * NO_COLOR / FORCE_COLOR / TERM=dumb conventions (https://no-color.org).
 * JSON output and piped logs stay byte-for-byte plain.
 */

export interface ColorEnv {
  NO_COLOR?: string;
  NODE_DISABLE_COLORS?: string;
  FORCE_COLOR?: string;
  TERM?: string;
}

/** Decides whether `stream` should receive ANSI colors under `env`. */
export function colorEnabled(stream: { isTTY?: boolean } | undefined, env: ColorEnv = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.NODE_DISABLE_COLORS !== undefined && env.NODE_DISABLE_COLORS !== "") return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.TERM === "dumb") return false;
  return Boolean(stream?.isTTY);
}

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  underline: [4, 24],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
} as const;

export type Style = keyof typeof CODES;

export interface Painter {
  (style: Style | Style[], text: string): string;
  readonly enabled: boolean;
}

const CSI = "\u001b[";

/** Builds a painter; `paint("bold", s)` returns `s` untouched when colors are off. */
export function makePainter(enabled: boolean): Painter {
  const paint = ((style: Style | Style[], text: string): string => {
    if (!enabled || text === "") return text;
    const styles = Array.isArray(style) ? style : [style];
    let open = "";
    let close = "";
    for (const s of styles) {
      const [on, off] = CODES[s];
      open += `${CSI}${on}m`;
      close = `${CSI}${off}m${close}`;
    }
    return `${open}${text}${close}`;
  }) as Painter;
  Object.defineProperty(paint, "enabled", { value: enabled, enumerable: true });
  return paint;
}

/** Painter for stderr, where the launchers write their status lines. */
export const err = makePainter(colorEnabled(process.stderr));
