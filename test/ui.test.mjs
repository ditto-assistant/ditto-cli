import assert from "node:assert/strict";
import test from "node:test";

import { colorEnabled, makePainter } from "../dist/ui.js";

test("colorEnabled follows TTY, NO_COLOR, FORCE_COLOR and TERM=dumb", () => {
  assert.equal(colorEnabled({ isTTY: true }, {}), true);
  assert.equal(colorEnabled({ isTTY: false }, {}), false);
  assert.equal(colorEnabled(undefined, {}), false);
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "" }), true, "empty NO_COLOR is unset per no-color.org");
  assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
  assert.equal(colorEnabled({ isTTY: true }, { FORCE_COLOR: "0" }), false);
  assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1", FORCE_COLOR: "1" }), false, "NO_COLOR wins");
  assert.equal(colorEnabled({ isTTY: true }, { TERM: "dumb" }), false);
  assert.equal(colorEnabled({ isTTY: true }, { NODE_DISABLE_COLORS: "1" }), false);
});

test("painter wraps in SGR codes only when enabled", () => {
  const on = makePainter(true);
  const off = makePainter(false);
  assert.equal(on("bold", "x"), "\u001b[1mx\u001b[22m");
  assert.equal(on(["bold", "green"], "x"), "\u001b[1m\u001b[32mx\u001b[39m\u001b[22m");
  assert.equal(on("cyan", ""), "", "empty text stays empty");
  assert.equal(off(["bold", "green"], "x"), "x");
  assert.equal(on.enabled, true);
  assert.equal(off.enabled, false);
});
