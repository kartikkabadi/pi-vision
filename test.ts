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
  writeFileSync(join(dir, "pi-vision.json"), JSON.stringify({ provider: "test", model: "a", thinking: "high" }));
  const extension = await import("./pi-vision.ts?cache-regression");
  const events = new Map();
  let command;
  let calls = 0;
  extension.default({
    on(name, handler) { events.set(name, handler); },
    registerTool() {},
    registerCommand(_name, definition) { command = definition.handler; },
  });
  const ctx = {
    hasUI: false,
    modelRegistry: {
      find(provider, id) { return { provider, id, input: ["image"], reasoning: true }; },
      async complete(model, _context, options) {
        calls++;
        return { content: [{ type: "text", text: `${model.id}/${options.reasoning}` }], usage: { input: 5, output: 1 } };
      },
    },
  };
  const image = { content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }] };
  const first = await events.get("tool_result")(image, ctx);
  const repeated = await events.get("tool_result")(image, ctx);
  assert.equal(calls, 1);
  assert.ok(first.usage);
  assert.equal(repeated.usage, undefined, "cached results must not replay billed usage");
  await command("model test/b", ctx);
  const changedModel = await events.get("tool_result")(image, ctx);
  assert.ok(changedModel.content[0].text.includes("b/high"));
  await command("thinking low", ctx);
  const changedThinking = await events.get("tool_result")(image, ctx);
  assert.ok(changedThinking.content[0].text.includes("b/low"));
  assert.equal(calls, 3);
  await command("model alternate/b", ctx);
  const changedProvider = await events.get("tool_result")(image, ctx);
  assert.ok(changedProvider.usage);
  assert.equal(calls, 4, "changing only the provider triggers inference");
  await events.get("tool_result")(image, ctx);
  assert.equal(calls, 4, "the new provider has its own cached result");
  console.log("PASS cache respects model and thinking changes without replaying usage");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
