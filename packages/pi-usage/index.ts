// usage — show OpenAI Codex and GitHub Copilot account usage in the pi coding
// agent.
//
// Commands:
//   /usage            open a menu with current Codex + Copilot usage
//                     (Refresh re-queries; Close dismisses)
//
// Statusline:
//   When the active model belongs to a supported provider, a compact meter is
//   published to the footer (e.g. `codex 40% wk` or `copilot 49% premium`) and
//   refreshed at most every 5 minutes.
//
// Credentials are resolved from the same store pi writes (~/.pi/agent/auth.json).
// Codex uses the ChatGPT OAuth access token; Copilot uses the GitHub OAuth token.
// Inspired by @narumitw/pi-usage, trimmed to just Codex and Copilot.

import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolveCodexToken, resolveCopilotToken, type ResolvedToken } from "./lib/auth";
import { formatReports, formatStatusline, type ProviderState } from "./lib/format";
import {
  CODEX_PROVIDER_ID,
  COPILOT_PROVIDER_ID,
  type ProviderReport,
  queryCodexUsage,
  queryCopilotUsage,
} from "./lib/providers";

const STATUS_KEY = "usage";
const CACHE_TTL_MS = 5 * 60 * 1000;
const REFRESH = "Refresh";
const CLOSE = "Close";

interface ProviderSpec {
  id: string;
  name: string;
  statusLabel: string;
  configureHint: string;
  resolve: (ctx: ExtensionContext) => Promise<ResolvedToken | undefined>;
  query: (token: string, signal?: AbortSignal) => Promise<ProviderReport>;
}

const PROVIDERS: ProviderSpec[] = [
  {
    id: CODEX_PROVIDER_ID,
    name: "OpenAI Codex",
    statusLabel: "codex",
    configureHint: "sign in with /login and select OpenAI Codex",
    resolve: (ctx) => resolveCodexToken(ctx),
    query: queryCodexUsage,
  },
  {
    id: COPILOT_PROVIDER_ID,
    name: "GitHub Copilot",
    statusLabel: "copilot",
    configureHint: "sign in with /login and select GitHub Copilot",
    resolve: async () => resolveCopilotToken(),
    query: queryCopilotUsage,
  },
];

export default function usageExtension(pi: ExtensionAPI): void {
  const cache = new Map<string, { at: number; report: ProviderReport }>();
  let statusBusy = false;

  const safeSetStatus = (ctx: ExtensionContext, value: string | undefined) => {
    try {
      ctx.ui.setStatus(STATUS_KEY, value);
    } catch {
      // Context may be stale after a reload/session swap; ignore.
    }
  };

  const queryProvider = async (
    ctx: ExtensionContext,
    provider: ProviderSpec,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderState> => {
    const cached = cache.get(provider.id);
    if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return { id: provider.id, name: provider.name, status: "ready", report: cached.report };
    }
    // Resolve + query inside one guard so a failure for one provider can never
    // reject the sibling query (each provider is fully independent of the active
    // model / the other provider).
    try {
      const resolved = await provider.resolve(ctx);
      if (!resolved) {
        return {
          id: provider.id,
          name: provider.name,
          status: "unconfigured",
          message: provider.configureHint,
        };
      }
      const report = await provider.query(resolved.token, signal);
      cache.set(provider.id, { at: Date.now(), report });
      return { id: provider.id, name: provider.name, status: "ready", report };
    } catch (error) {
      return {
        id: provider.id,
        name: provider.name,
        status: "error",
        message: errorMessage(error),
      };
    }
  };

  const collectStates = async (
    ctx: ExtensionContext,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<ProviderState[]> => {
    // Always query every provider, independent of the active model. allSettled is
    // belt-and-braces: queryProvider already never rejects.
    const settled = await Promise.allSettled(
      PROVIDERS.map((provider) => queryProvider(ctx, provider, force, signal)),
    );
    return settled.map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      const provider = PROVIDERS[index];
      return {
        id: provider.id,
        name: provider.name,
        status: "error",
        message: errorMessage(result.reason),
      };
    });
  };

  const publishStatus = async (ctx: ExtensionContext, force: boolean) => {
    const provider = PROVIDERS.find((candidate) => candidate.id === ctx.model?.provider);
    if (!provider) {
      safeSetStatus(ctx, undefined);
      return;
    }
    if (statusBusy) return;
    statusBusy = true;
    try {
      const state = await queryProvider(ctx, provider, force);
      if (state.status === "ready") {
        safeSetStatus(ctx, formatStatusline(state.report));
      } else if (state.status === "error") {
        safeSetStatus(ctx, `${provider.statusLabel} usage error`);
      } else {
        safeSetStatus(ctx, undefined);
      }
    } finally {
      statusBusy = false;
    }
  };

  // Run an async query behind a bordered "loading" overlay in the TUI so /usage
  // never appears frozen while the endpoints are being fetched. Esc cancels.
  // Returns undefined when the user cancels; rethrows genuine query errors.
  const runWithLoader = async <T>(
    ctx: ExtensionCommandContext,
    label: string,
    parentSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> => {
    if (ctx.mode !== "tui") return operation(parentSignal);
    type LoaderResult = { ok: true; value: T } | { ok: false; error: unknown };
    const result = await ctx.ui.custom<LoaderResult | null>((tui, theme, _keybindings, done) => {
      const loader = new BorderedLoader(tui, theme, label, { cancellable: true });
      let finished = false;
      const finish = (value: LoaderResult | null) => {
        if (finished) return;
        finished = true;
        done(value);
      };
      loader.onAbort = () => finish(null);
      const signal = AbortSignal.any([parentSignal, loader.signal]);
      void operation(signal)
        .then((value) => finish({ ok: true, value }))
        .catch((error) => {
          if (isAbortError(error)) finish(null);
          else finish({ ok: false, error });
        });
      return loader;
    });
    if (!result) return undefined;
    if (!result.ok) throw result.error;
    return result.value;
  };

  const showMenu = async (ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI) {
      const states = await collectStates(ctx, false);
      ctx.ui.notify(compactSummary(states), "info");
      return;
    }
    const controller = new AbortController();
    try {
      let states = await runWithLoader(ctx, "Checking usage…", controller.signal, (signal) =>
        collectStates(ctx, false, signal),
      );
      if (!states) return;
      publishActiveFrom(ctx, states);
      while (!controller.signal.aborted) {
        const action = await ctx.ui.select(formatReports(states), [REFRESH, CLOSE], {
          signal: controller.signal,
        });
        if (!action || action === CLOSE) return;
        if (action === REFRESH) {
          const refreshed = await runWithLoader(
            ctx,
            "Refreshing usage…",
            controller.signal,
            (signal) => collectStates(ctx, true, signal),
          );
          // Cancelled refresh keeps the previously shown data.
          if (refreshed) {
            states = refreshed;
            publishActiveFrom(ctx, states);
          }
        }
      }
    } finally {
      controller.abort();
    }
  };

  // Reuse freshly-collected menu data to update the footer for the active model.
  const publishActiveFrom = (ctx: ExtensionContext, states: ProviderState[]) => {
    const provider = PROVIDERS.find((candidate) => candidate.id === ctx.model?.provider);
    if (!provider) {
      safeSetStatus(ctx, undefined);
      return;
    }
    const state = states.find((candidate) => candidate.id === provider.id);
    if (state?.status === "ready") safeSetStatus(ctx, formatStatusline(state.report));
  };

  pi.registerCommand("usage", {
    description: "Show OpenAI Codex and GitHub Copilot account usage",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/usage takes no arguments; use its menu.", "warning");
        return;
      }
      await showMenu(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    void publishStatus(ctx, false);
  });
  pi.on("model_select", (_event, ctx) => {
    void publishStatus(ctx, false);
  });
  pi.on("turn_start", (_event, ctx) => {
    void publishStatus(ctx, false);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    cache.clear();
    safeSetStatus(ctx, undefined);
  });
}

function compactSummary(states: ProviderState[]): string {
  return states
    .map((state) => {
      if (state.status === "ready") {
        return formatStatusline(state.report) ?? `${state.name}: no usage data`;
      }
      if (state.status === "unconfigured") return `${state.name}: not configured`;
      return `${state.name}: error`;
    })
    .join("  |  ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
