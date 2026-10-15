import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pi-vision-config-"));
process.env.PI_CODING_AGENT_DIR = dir;
try {
  for (const [i, value] of [null, [], 42, "invalid"].entries()) {
    writeFileSync(join(dir, "pi-vision.json"), JSON.stringify(value));
    const extension = await import(`./pi-vision.ts?config=${i}`);
    let handler;
    const notices: string[] = [];
    extension.default({
      on() {},
      registerTool() {},
      registerCommand(_name, command) { handler = command.handler; },
    });
    await handler("", { mode: "rpc", hasUI: true, ui: { notify(text) { notices.push(text); } } });
    assert.ok(notices.some(text => text.includes("no model configured")));
  }
  console.log("PASS malformed config values fall back to defaults");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
