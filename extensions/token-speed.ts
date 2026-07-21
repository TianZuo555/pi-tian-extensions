// token-speed — live tokens-per-second meter for the pi coding agent.
//
// Shows a live generation-speed readout in the footer while the assistant
// streams, plus a summary (average tok/s, total tokens, time-to-first-token)
// when the message finishes.
//
// Commands:
//   /tps            cycle the display mode: live -> final -> off
//   /tps live       always show the live meter + summary
//   /tps final      show only the end-of-message summary
//   /tps off        show nothing
//
// The display mode is remembered in ~/.pi/token-speed/config.json.
//
// This is an original implementation. Live speed is sampled from streamed text
// (a rough chars-per-token estimate, which is what makes the meter responsive),
// while the end-of-message average uses the provider's authoritative output
// token count when available.

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { piConfigDir, readJson, writeJson } from "./lib/repo-registry";

type DisplayMode = "live" | "final" | "off";
const MODES: DisplayMode[] = ["live", "final", "off"];

const CONFIG_FILE = path.join(piConfigDir("token-speed"), "config.json");
const STATUS_KEY = "token-speed";

const WINDOW_MS = 5_000; // sliding window span for the live rate
const MIN_SPAN_MS = 250; // clamp the span so early bursts don't spike the rate
const CHARS_PER_TOKEN = 4; // rough live estimate when provider usage is absent
const RENDER_INTERVAL_MS = 100; // throttle footer updates during streaming

// --- config -----------------------------------------------------------------

interface Config {
  mode: DisplayMode;
}

function loadMode(): DisplayMode {
  const cfg = readJson<Config>(CONFIG_FILE, { mode: "live" });
  return MODES.includes(cfg.mode) ? cfg.mode : "live";
}

function saveMode(mode: DisplayMode): void {
  try {
    writeJson(CONFIG_FILE, { mode });
  } catch (error) {
    console.warn("[token-speed] Failed to write config:", error);
  }
}

// --- formatting -------------------------------------------------------------

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function formatRate(tps: number): string {
  return tps >= 100 ? `${Math.round(tps)}` : tps.toFixed(1);
}

function formatDuration(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

// --- sliding-window rate meter ----------------------------------------------

interface Sample {
  t: number;
  tokens: number;
}

// Tracks a single assistant stream and reports a smoothed tokens/sec rate over
// the most recent WINDOW_MS.
class StreamMeter {
  private samples: Sample[] = [];
  private head = 0; // index of the oldest sample still inside the window
  private startedAt = 0;
  private firstTokenAt: number | undefined;
  private estimatedTokens = 0;
  streaming = false;

  begin(now: number): void {
    this.samples = [];
    this.head = 0;
    this.startedAt = now;
    this.firstTokenAt = undefined;
    this.estimatedTokens = 0;
    this.streaming = true;
  }

  // Record generated text and return the estimated token count for it.
  record(text: string, now: number): number {
    if (!this.streaming) return 0;
    if (this.firstTokenAt === undefined) this.firstTokenAt = now;
    const tokens = Math.max(1, Math.round(text.length / CHARS_PER_TOKEN));
    this.estimatedTokens += tokens;
    this.samples.push({ t: now, tokens });
    // Reclaim memory once the dead prefix grows large.
    if (this.head > 512) {
      this.samples = this.samples.slice(this.head);
      this.head = 0;
    }
    return tokens;
  }

  // Smoothed tokens/sec over the trailing window.
  rate(now: number): number {
    const cutoff = now - WINDOW_MS;
    while (this.head < this.samples.length && this.samples[this.head].t < cutoff) {
      this.head++;
    }
    if (this.head >= this.samples.length) return 0;

    let tokens = 0;
    for (let i = this.head; i < this.samples.length; i++) tokens += this.samples[i].tokens;
    if (tokens === 0) return 0;

    const span = Math.max(now - this.samples[this.head].t, MIN_SPAN_MS);
    return (1000 * tokens) / span;
  }

  ttftMs(): number | undefined {
    return this.firstTokenAt === undefined ? undefined : this.firstTokenAt - this.startedAt;
  }

  // Overall average tokens/sec across the whole stream.
  averageRate(totalTokens: number, now: number): number {
    const from = this.firstTokenAt ?? this.startedAt;
    const span = Math.max(now - from, MIN_SPAN_MS);
    return (1000 * totalTokens) / span;
  }

  get liveTokens(): number {
    return this.estimatedTokens;
  }

  end(): void {
    this.streaming = false;
  }
}

// --- assistant message helpers ----------------------------------------------

function isAssistant(message: unknown): message is { role: "assistant"; usage?: { output?: number } } {
  return typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant";
}

// --- extension --------------------------------------------------------------

export default function tokenSpeedExtension(pi: ExtensionAPI): void {
  const meter = new StreamMeter();
  let mode: DisplayMode = "live";
  let lastRender = 0;

  const clear = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS_KEY, "");

  const renderLive = (ctx: ExtensionContext, now: number) => {
    if (mode !== "live") return;
    if (now - lastRender < RENDER_INTERVAL_MS) return;
    lastRender = now;
    ctx.ui.setStatus(STATUS_KEY, `⚡ ${formatRate(meter.rate(now))} tok/s`);
  };

  const renderSummary = (ctx: ExtensionContext, totalTokens: number, now: number) => {
    if (mode === "off") return;
    const parts = [`⚡ ${formatRate(meter.averageRate(totalTokens, now))} tok/s avg`, `${formatCount(totalTokens)} tok`];
    const ttft = meter.ttftMs();
    if (ttft !== undefined) parts.push(`TTFT ${formatDuration(ttft)}`);
    ctx.ui.setStatus(STATUS_KEY, parts.join(" · "));
  };

  pi.on("session_start", (_event, ctx) => {
    mode = loadMode();
    clear(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (!isAssistant(event.message)) return;
    meter.begin(Date.now());
    lastRender = 0;
    if (mode === "live") clear(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (!meter.streaming) return;
    const ev = event.assistantMessageEvent;
    if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;

    const now = Date.now();
    meter.record(ev.delta ?? "", now);
    renderLive(ctx, now);
  });

  pi.on("message_end", (event, ctx) => {
    if (!meter.streaming || !isAssistant(event.message)) return;
    const now = Date.now();
    // Prefer the provider's authoritative output count; fall back to the estimate.
    const total = event.message.usage?.output ?? meter.liveTokens;
    meter.end();
    renderSummary(ctx, total, now);
  });

  pi.on("turn_end", () => {
    if (meter.streaming) meter.end();
  });

  pi.on("session_shutdown", () => {
    meter.end();
  });

  pi.registerCommand("tps", {
    description: "Cycle or set the tokens-per-second display: /tps [live|final|off]",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && (MODES as string[]).includes(arg)) {
        mode = arg as DisplayMode;
      } else if (arg) {
        ctx.ui.notify(`token-speed: unknown mode "${arg}". Use live | final | off.`, "error");
        return;
      } else {
        mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      }
      saveMode(mode);
      if (mode === "off") clear(ctx);
      ctx.ui.notify(`token-speed: ${mode}`, "info");
    },
  });
}
