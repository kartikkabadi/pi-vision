# pi-vision

Automatic vision routing for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Any image that enters your session — attached to a prompt, or read by a tool like `read` — is sent to a vision model of your choice. The model writes a detailed description, which is injected into the conversation, so your main model can work with screenshots, diagrams, and image files even when it cannot see pixels. Raw image data never reaches the main model.

`pi-vision` ships with **no default model** — you pick the one you have access to. One command, in an interactive menu:

```bash
/vision
```

## Install

```bash
pi install git:github.com/kartikkabadi/pi-vision
```

No `@ref` means the package tracks the latest on `main`; run `pi update --extensions` to pull updates. Add `@tag` (for example `@v0.1.0`) to pin a specific release instead.

Then restart pi or run `/reload`. To try it without installing: `pi -e git:github.com/kartikkabadi/pi-vision`.

## First run: pick your vision model

There is no bundled default — you choose the model. In the TUI, run:

```bash
/vision
```

and the menu walks you through it (Model, Thinking level, Reset). The model list only shows vision-capable models from providers you have already authenticated.

Prefer the one-liner:

```bash
/vision model <model-id>          # bare id: resolved against your providers
/vision model <provider/model-id> # explicit provider
```

Your choice is saved to `~/.pi/agent/pi-vision.json`. Until a model is set, images pass through untouched and pi-vision just reminds you to pick one.

## Usage

| Command | Action |
| --- | --- |
| `/vision` | Interactive menu (TUI): model, thinking level, reset |
| `/vision model <id>` | Set the vision model |
| `/vision thinking <level>` | Set thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `/vision reset` | Clear the model, restore thinking to `high` |

The `describe_image` tool is also registered: point it at an image file or capture the screen.

```bash
describe_image(path: "screenshot.png")
describe_image(screenshot: true)   # macOS only
```

## Settings

Config file: `~/.pi/agent/pi-vision.json`.

```json
{
  "provider": "opencode-go",
  "model": "mimo-v2.5",
  "thinking": "high"
}
```

`thinking` controls the vision model's reasoning effort; it is only sent to models that support reasoning. `off` skips it entirely.

## How it works

1. An image enters context — attached to your prompt, or returned by a tool (for example `read` on an image file).
2. The image is sent to your configured vision model with a description prompt ("transcribe all visible text verbatim, describe layout, colors, diagrams...").
3. The description is injected into the conversation as a `[pi-vision]` message; the raw image parts are stripped from the payload sent to the main model.
4. Descriptions are cached by image content for the session, so the same image re-entering context (attached, then re-read) costs one vision call, not several.

If the vision call fails, the main model gets an explicit note that the image could not be described, instead of silent pixels.

## Privacy

Images are sent to the vision provider you configure — the same provider you already use for pi. `describe_image(screenshot: true)` captures your whole screen and sends it there. The description cache is in-memory only and never written to disk. Nothing else leaves your machine.
