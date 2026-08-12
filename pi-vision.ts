/**
 * pi-vision — route images to a vision model of your choice.
 *
 * When images are attached to a prompt (or appear in a tool result, e.g. the
 * read tool opening an image file), they are sent to a configured vision
 * model. The model's detailed description is injected into the conversation
 * so the main model can work with the image even if it cannot see pixels.
 * Raw image parts are stripped from the payload sent to the main model.
 *
 * Configuration:
 *   - No default model: pick one with /vision (interactive menu in TUI, or
 *     /vision model <id-or-provider/id> in any mode). Until a model is set,
 *     images pass through untouched and pi-vision just reminds you.
 *   - Thinking defaults to "high"; change with /vision thinking <level>.
 *   - TUI: bare /vision opens an interactive menu (model, thinking level, reset).
 *   - One-liners (any mode): /vision model <id-or-provider/id>, /vision thinking <level>, /vision reset
 *   - Persisted to ~/.pi/agent/pi-vision.json
 *
 * Also registers the describe_image tool (file path or screenshot).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  Context,
  ImageContent,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { readFile, unlink } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const DEFAULT_CONFIG = {
  thinking: "high",
} as const;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

type VisionConfig = {
  provider?: string;
  model?: string;
  thinking: ThinkingLevel;
};

function isConfigured(
  config: VisionConfig,
): config is VisionConfig & { provider: string; model: string } {
  return typeof config.provider === "string" && typeof config.model === "string";
}

const CONFIG_PATH = join(getAgentDir(), "pi-vision.json");
const VISION_TIMEOUT_MS = 180_000;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const DESCRIBE_SYSTEM =
  "You are the vision component of a terminal-based coding assistant. " +
  "Your user's main model cannot see images. Produce a thorough, precise " +
  "description of the attached image(s) so a text-only model can fully " +
  "understand them. Requirements:\n" +
  "- Transcribe all visible text verbatim: code, errors, labels, URLs, button text, terminal output.\n" +
  "- For code screenshots, reproduce the code accurately with correct syntax.\n" +
  "- Describe layout, UI elements, and relevant visual details (colors, icons, charts, diagrams).\n" +
  "- For diagrams or charts, describe structure and data points.\n" +
  "- Be concrete and complete; do not editorialize or summarize vaguely.";

const DESCRIBE_USER = "Describe the attached image(s) in detail.";

let configCache: VisionConfig | null = null;

// Descriptions by image content hash: the same image often re-enters context
// (attached, then re-read via the read tool) — skip the second vision call.
const descriptionCache = new Map<string, { text: string; usage?: Usage }>();
const DESCRIPTION_CACHE_MAX = 16;

function imageCacheKey(images: ImageContent[]): string {
  const hash = createHash("sha1");
  for (const image of images) {
    hash.update(image.mimeType);
    hash.update("\0");
    hash.update(image.data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function getConfig(): VisionConfig {
  if (configCache) return configCache;
  let loaded: Partial<VisionConfig> = {};
  try {
    loaded = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    // no config file yet — defaults apply
  }
  configCache = {
    ...(typeof loaded.provider === "string" && loaded.provider
      ? { provider: loaded.provider }
      : {}),
    ...(typeof loaded.model === "string" && loaded.model ? { model: loaded.model } : {}),
    thinking: THINKING_LEVELS.includes(loaded.thinking as ThinkingLevel)
      ? (loaded.thinking as ThinkingLevel)
      : DEFAULT_CONFIG.thinking,
  };
  return configCache;
}

function saveConfig(config: VisionConfig) {
  configCache = config;
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  } catch (err) {
    console.error(`pi-vision: could not write ${CONFIG_PATH}: ${err}`);
  }
}

function configLabel(config: VisionConfig): string {
  const thinking = config.thinking === "off" ? "no thinking" : config.thinking;
  if (!isConfigured(config)) return `no model configured (thinking ${thinking})`;
  return `${config.provider}/${config.model} (thinking ${thinking})`;
}

/**
 * Send images to the configured vision model and return the description text.
 */
async function describeImages(
  images: ImageContent[],
  config: VisionConfig,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: Usage }> {
  if (!isConfigured(config)) {
    throw new Error(
      "no vision model configured — run /vision model <id> or open the /vision menu",
    );
  }
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model) {
    throw new Error(`vision model not found: ${config.provider}/${config.model}`);
  }
  if (!model.input.includes("image")) {
    throw new Error(
      `model does not accept images: ${config.provider}/${config.model} ` +
        `(input: ${model.input.join(",")})`,
    );
  }

  const visionContext: Context = {
    systemPrompt: DESCRIBE_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: DESCRIBE_USER },
          ...images,
        ],
        timestamp: Date.now(),
      },
    ],
  };

  const timeout = AbortSignal.timeout(VISION_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  // Cache hit: the same image bytes were already described this session.
  const cacheKey = imageCacheKey(images);
  const cached = descriptionCache.get(cacheKey);
  if (cached) return { ...cached };

  // ctx.modelRegistry.complete resolves provider auth (stored credentials /
  // env keys) and delegates to the provider — the bare provider.streamSimple
  // would skip auth resolution and fail with "No API key for provider".
  const message = await ctx.modelRegistry.complete(
    model,
    visionContext,
    model.reasoning && config.thinking !== "off"
      ? { reasoning: config.thinking, signal: combined }
      : { signal: combined },
  );

  const text = message.content
    .filter(
      (part): part is TextContent => part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) {
    const stop = message.stopReason && message.stopReason !== "stop"
      ? ` (stopReason: ${message.stopReason})`
      : "";
    const detail = message.errorMessage ? `: ${message.errorMessage}` : "";
    throw new Error(`vision model returned an empty description${stop}${detail}`);
  }
  const result = { text, usage: message.usage };
  descriptionCache.set(cacheKey, result);
  if (descriptionCache.size > DESCRIPTION_CACHE_MAX) {
    const oldest = descriptionCache.keys().next().value;
    if (oldest !== undefined) descriptionCache.delete(oldest);
  }
  return result;
}

function visionMessageText(config: VisionConfig, body: string): string {
  return `[pi-vision] Description via ${config.provider}/${config.model}:\n\n${body}`;
}

export default function (pi: ExtensionAPI) {
  // Strip raw image parts from the payload sent to the main model once we
  // have described them (or failed to), so a non-vision main model never
  // receives pixels it cannot use. Set in before_agent_start, reset when the
  // run ends (NOT on agent_start — that fires after before_agent_start).
  let stripImages = false;
  pi.on("agent_end", () => {
    stripImages = false;
  });

  // Route images attached to a user prompt.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!event.images || event.images.length === 0) return;

    const config = getConfig();
    if (!isConfigured(config)) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-vision: no vision model configured — run /vision to pick one (images pass through)",
          "info",
        );
      }
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(
        `pi-vision: describing ${event.images.length} image(s) with ${configLabel(config)}…`,
        "info",
      );
    }

    try {
      const { text } = await describeImages(event.images, config, ctx, ctx.signal);
      stripImages = true;
      return {
        message: {
          customType: "pi-vision",
          content: [{ type: "text", text: visionMessageText(config, text) }],
          display: true,
        },
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-vision: vision call failed: ${detail}`, "error");
      }
      stripImages = true;
      return {
        message: {
          customType: "pi-vision",
          content: [
            {
              type: "text",
              text:
                `[pi-vision] Failed to describe the attached image(s) via ` +
                `${config.provider}/${config.model}: ${detail}. ` +
                `The image content is not available to the model.`,
            },
          ],
          display: true,
        },
      };
    }
  });

  // Strip image parts from user messages before each LLM call.
  pi.on("context", (event) => {
    if (!stripImages) return;
    const messages = event.messages.map((message) => {
      if (message.role !== "user" || typeof message.content === "string") return message;
      const content = message.content.filter((part) => part.type !== "image");
      return content.length === message.content.length
        ? message
        : { ...message, content };
    });
    return { messages };
  });

  // Route images that enter context through tool results (e.g. read tool on an image file).
  pi.on("tool_result", async (event, ctx) => {
    const images = (event.content ?? []).filter(
      (part): part is ImageContent => part.type === "image",
    );
    if (images.length === 0) return;

    const config = getConfig();
    if (!isConfigured(config)) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-vision: no vision model configured — run /vision to pick one (image left in result)",
          "info",
        );
      }
      return;
    }
    if (ctx.hasUI) {
      ctx.ui.notify(`pi-vision: describing ${images.length} image(s) from tool result…`, "info");
    }
    try {
      const { text, usage } = await describeImages(images, config, ctx, ctx.signal);
      const description: TextContent = {
        type: "text",
        text: visionMessageText(config, text),
      };
      return {
        content: [...event.content.filter((part) => part.type !== "image"), description],
        usage,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-vision: vision call failed: ${detail}`, "error");
      }
      return {
        content: [
          {
            type: "text",
            text:
              `[pi-vision] Failed to describe the image(s) in this result via ` +
              `${config.provider}/${config.model}: ${detail}.`,
          },
        ],
      };
    }
  });

  // Tool: describe an image file or take a screenshot.
  pi.registerTool({
    name: "describe_image",
    label: "Describe Image",
    description:
      "Describe an image file or a screenshot of the screen using the " +
      "configured vision model. Use when the user asks what is in an image, " +
      "a screenshot, or a picture of a screen.",
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({ description: "Path to an image file (png, jpg, gif, webp, bmp)" }),
      ),
      screenshot: Type.Optional(
        Type.Boolean({ description: "Capture the whole screen and describe it (macOS)" }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let file: string;
      if (params.screenshot) {
        if (process.platform !== "darwin") {
          throw new Error("screenshot capture requires macOS");
        }
        file = join(tmpdir(), `pi-vision-${Date.now()}.png`);
        await pi.exec("screencapture", ["-x", "-t", "png", file], { signal });
      } else if (params.path) {
        file = resolve(ctx.cwd, params.path);
      } else {
        throw new Error("provide either path or screenshot: true");
      }

      const buffer = await readFile(file);
      if (params.screenshot) unlink(file).catch(() => {}); // temp screenshot: clean up
      const mime = MIME_BY_EXT[extname(file).toLowerCase()] ?? "image/png";
      const image: ImageContent = {
        type: "image",
        data: buffer.toString("base64"),
        mimeType: mime,
      };

      const config = getConfig();
      if (!isConfigured(config)) {
        throw new Error(
          "no vision model configured — run /vision model <id> or open the /vision menu",
        );
      }
      onUpdate?.({
        content: [{ type: "text", text: `Describing with ${configLabel(config)}…` }],
        details: {},
      });
      const { text, usage } = await describeImages([image], config, ctx, signal);
      return {
        content: [{ type: "text", text }],
        details: {
          model: `${config.provider}/${config.model}`,
          thinking: config.thinking,
        },
        usage,
      };
    },
  });

  // ── /vision command ────────────────────────────────────────────────────
  // In TUI mode, bare /vision opens an interactive menu (model, thinking,
  // reset). Subcommands still work as one-liners in any mode:
  //   /vision model <id|provider/id>
  //   /vision thinking <level>
  //   /vision reset

  const notify = (ctx: ExtensionContext, message: string, kind: "info" | "error") => {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
    else console.log(message);
  };

  const USAGE =
    "Usage: /vision [model <id|provider/id> | thinking <" +
    THINKING_LEVELS.join("|") +
    "> | reset]";

  function setModelFromValue(value: string, ctx: ExtensionContext): boolean {
    const resolved = resolveVisionModel(value, ctx);
    if (!resolved) {
      notify(
        ctx,
        `pi-vision: no vision-capable model matching "${value}" (check provider/model id)`,
        "error",
      );
      return false;
    }
    const config = getConfig();
    config.provider = resolved.provider;
    config.model = resolved.id;
    saveConfig(config);
    notify(ctx, `pi-vision: vision model set to ${configLabel(config)}`, "info");
    return true;
  }

  function setThinkingFromValue(value: string, ctx: ExtensionContext): boolean {
    if (!THINKING_LEVELS.includes(value as ThinkingLevel)) {
      notify(ctx, USAGE, "error");
      return false;
    }
    const config = getConfig();
    config.thinking = value as ThinkingLevel;
    saveConfig(config);
    notify(ctx, `pi-vision: thinking level set to ${config.thinking}`, "info");
    return true;
  }

  async function resetConfig(ctx: ExtensionContext): Promise<void> {
    const ok = ctx.hasUI
      ? await ctx.ui.confirm(
          "Reset pi-vision?",
          "Clear the vision model and restore thinking to high?",
        )
      : true;
    if (!ok) return;
    saveConfig({ ...DEFAULT_CONFIG });
    notify(ctx, `pi-vision: reset to ${configLabel(getConfig())}`, "info");
  }

  /** Generic SelectList dialog for TUI mode. */
  async function showSelect(
    ctx: ExtensionContext,
    title: string,
    items: SelectItem[],
    hint?: string,
  ): Promise<string | null> {
    return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
      const selectList = new SelectList(items, Math.min(items.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
      container.addChild(selectList);
      container.addChild(
        new Text(theme.fg("dim", hint ?? "↑↓ navigate • enter select • esc cancel"), 1, 0),
      );
      container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  async function showVisionMenu(ctx: ExtensionContext): Promise<void> {
    const config = getConfig();

    const choice = await showSelect(
      ctx,
      `pi-vision — ${configLabel(config)}`,
      [
        {
          value: "model",
          label: "Model",
          description: isConfigured(config)
            ? `${config.provider}/${config.model}`
            : "not set",
        },
        {
          value: "thinking",
          label: "Thinking level",
          description: config.thinking,
        },
        {
          value: "reset",
          label: "Reset to defaults",
          description: `no model, thinking ${DEFAULT_CONFIG.thinking}`,
        },
        { value: "close", label: "Done" },
      ],
      "↑↓ navigate • enter select • esc cancel — or type e.g. /vision model kimi-k3",
    );
    if (!choice || choice === "close") return;

    if (choice === "reset") {
      await resetConfig(ctx);
      return;
    }

    if (choice === "model") {
      const models = ctx.modelRegistry
        .getAvailable()
        .filter((model) => model.input.includes("image"))
        .sort((a, b) => {
          const aCurrent = a.provider === config.provider && a.id === config.model ? 0 : 1;
          const bCurrent = b.provider === config.provider && b.id === config.model ? 0 : 1;
          if (aCurrent !== bCurrent) return aCurrent - bCurrent;
          return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
        });
      const items: SelectItem[] = models.map((model) => {
        const isCurrent = model.provider === config.provider && model.id === config.model;
        return {
          value: `${model.provider}/${model.id}`,
          label: `${model.provider}/${model.id}`,
          description: isCurrent ? "current" : undefined,
        };
      });
      if (items.length === 0) {
        notify(ctx, "pi-vision: no vision-capable models available", "error");
        return;
      }
      const picked = await showSelect(ctx, "Vision model", items, "↑↓ navigate • enter select • esc cancel");
      if (picked) setModelFromValue(picked, ctx);
      return;
    }

    if (choice === "thinking") {
      const items: SelectItem[] = THINKING_LEVELS.map((level) => ({
        value: level,
        label: level,
        description: level === config.thinking ? "current" : undefined,
      }));
      const picked = await showSelect(ctx, "Thinking level", items);
      if (picked) setThinkingFromValue(picked, ctx);
    }
  }

  pi.registerCommand("vision", {
    description: "Configure pi-vision: which vision model and thinking level handles images",
    handler: async (args, ctx) => {
      const [command, value] = (args ?? "").trim().split(/\s+/);

      // Bare /vision: interactive menu in TUI, summary otherwise.
      if (!command) {
        if (ctx.mode === "tui" && ctx.hasUI) {
          await showVisionMenu(ctx);
          return;
        }
        notify(ctx, `pi-vision: ${configLabel(getConfig())} — ${USAGE}`, "info");
        return;
      }

      switch (command) {
        case "model":
          if (!value) {
            notify(ctx, "Usage: /vision model <model-id or provider/model-id>", "info");
            return;
          }
          setModelFromValue(value, ctx);
          return;
        case "thinking":
          if (!value) {
            notify(ctx, "Usage: /vision thinking <level>", "info");
            return;
          }
          setThinkingFromValue(value, ctx);
          return;
        case "reset":
          await resetConfig(ctx);
          return;
        default:
          notify(ctx, USAGE, "error");
      }
    },
  });
}

/**
 * Resolve "provider/model" or a bare model id to a vision-capable model.
 * Bare ids prefer the currently configured provider, then providers with
 * configured auth, so the resolved model is actually usable.
 */
function resolveVisionModel(
  value: string,
  ctx: ExtensionContext,
): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash > 0) {
    const provider = value.slice(0, slash);
    const id = value.slice(slash + 1);
    const model = ctx.modelRegistry.find(provider, id);
    return model ? { provider, id: model.id } : undefined;
  }

  const matches = ctx.modelRegistry
    .getAvailable()
    .filter((model) => model.id.toLowerCase() === value.toLowerCase());
  if (matches.length === 0) return undefined;
  if (matches.length === 1) {
    return { provider: matches[0].provider, id: matches[0].id };
  }

  // Multiple providers carry this model id: prefer the configured provider,
  // then any provider with working auth.
  const current = getConfig();
  const onCurrent = matches.find((m) => m.provider === current.provider);
  if (onCurrent) return { provider: onCurrent.provider, id: onCurrent.id };
  const authed = matches.find((m) => ctx.modelRegistry.hasConfiguredAuth(m));
  const chosen = authed ?? matches[0];
  return { provider: chosen.provider, id: chosen.id };
}
