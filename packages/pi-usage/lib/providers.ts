// Provider queries and normalization for Codex and GitHub Copilot usage.
//
// Each provider is normalized into a small, presentation-friendly `ProviderReport`
// so the formatter does not need to know provider-specific JSON shapes.

export const CODEX_PROVIDER_ID = "openai-codex";
export const COPILOT_PROVIDER_ID = "github-copilot";

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const COPILOT_USAGE_URL = "https://api.github.com/copilot_internal/user";

// Copilot's internal endpoint expects the editor client headers plus a REST API
// version. Values mirror the GitHub Copilot chat client.
const COPILOT_HEADERS: Record<string, string> = {
  "Editor-Version": "vscode/1.104.0",
  "Editor-Plugin-Version": "copilot-chat/0.30.0",
  "Copilot-Integration-Id": "vscode-chat",
  "X-GitHub-Api-Version": "2025-04-01",
};

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 128 * 1024;

/** One usage window/bucket, already normalized for display. */
export interface UsageWindow {
  label: string;
  /** Percentage of the allowance still remaining (0-100). */
  remainingPercent?: number;
  /** Absolute remaining and total allowance, when the provider reports them. */
  remaining?: number;
  entitlement?: number;
  /** True when the allowance is unmetered. */
  unlimited?: boolean;
  /** Reset time as epoch seconds (Codex) — rendered as a clock/date. */
  resetsAt?: number;
}

export interface ProviderReport {
  id: string;
  name: string;
  plan?: string;
  windows: UsageWindow[];
  notes: string[];
}

// --- Codex ------------------------------------------------------------------

export async function queryCodexUsage(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProviderReport> {
  const data = await fetchProviderJson(
    CODEX_USAGE_URL,
    token,
    { "User-Agent": "pi-usage" },
    signal,
    timeoutMs,
    token,
  );

  const windows: UsageWindow[] = [];
  const rateLimit = asObject(data.rate_limit);
  addCodexWindow(windows, "5h", rateLimit?.primary_window);
  addCodexWindow(windows, "Weekly", rateLimit?.secondary_window);

  const notes: string[] = [];
  const credits = asObject(data.credits);
  if (credits?.has_credits === true) {
    if (credits.unlimited === true) notes.push("Credits: unlimited");
    else {
      const balance = asNumber(credits.balance);
      notes.push(balance !== undefined ? `Credits: ${balance}` : "Credits: available");
    }
  }

  if (windows.length === 0 && notes.length === 0) {
    throw new Error("Codex usage endpoint returned no displayable data.");
  }

  return {
    id: CODEX_PROVIDER_ID,
    name: "OpenAI Codex",
    plan: asString(data.plan_type),
    windows,
    notes,
  };
}

function addCodexWindow(windows: UsageWindow[], fallbackLabel: string, raw: unknown): void {
  const value = asObject(raw);
  if (!value) return;
  const used = asNumber(value.used_percent);
  if (used === undefined) return;
  const seconds = asNumber(value.limit_window_seconds);
  windows.push({
    label: `${seconds ? windowLabel(seconds) : fallbackLabel} limit`,
    remainingPercent: clampPercent(100 - used),
    resetsAt: asNumber(value.reset_at),
  });
}

function windowLabel(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes % 10_080 === 0) return minutes / 10_080 === 1 ? "Weekly" : `${minutes / 10_080}-week`;
  if (minutes % 1_440 === 0) return minutes / 1_440 === 1 ? "Daily" : `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// --- GitHub Copilot ---------------------------------------------------------

const COPILOT_SNAPSHOT_LABELS: Record<string, string> = {
  premium_interactions: "Premium requests",
  chat: "Chat",
  completions: "Completions",
};
const COPILOT_SNAPSHOT_ORDER = ["premium_interactions", "chat", "completions"];

export async function queryCopilotUsage(
  token: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ProviderReport> {
  const data = await fetchProviderJson(
    COPILOT_USAGE_URL,
    token,
    { ...COPILOT_HEADERS, "User-Agent": "GitHubCopilotChat/0.30.0" },
    signal,
    timeoutMs,
    token,
  );

  const snapshots = asObject(data.quota_snapshots) ?? {};
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const key of [...COPILOT_SNAPSHOT_ORDER, ...Object.keys(snapshots)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    const snapshot = asObject(snapshots[key]);
    if (!snapshot) continue;
    const unlimited = snapshot.unlimited === true;
    windows.push({
      label: COPILOT_SNAPSHOT_LABELS[key] ?? titleCase(key),
      unlimited,
      remainingPercent: unlimited ? undefined : asNumber(snapshot.percent_remaining),
      remaining: asNumber(snapshot.remaining) ?? asNumber(snapshot.quota_remaining),
      entitlement: asNumber(snapshot.entitlement),
    });
  }

  if (windows.length === 0) {
    throw new Error("Copilot usage endpoint returned no quota snapshots.");
  }

  const notes: string[] = [];
  const resetDate = asString(data.quota_reset_date) ?? asString(data.quota_reset_date_utc);
  if (resetDate) notes.push(`Quota resets: ${resetDate.slice(0, 10)}`);

  return {
    id: COPILOT_PROVIDER_ID,
    name: "GitHub Copilot",
    plan: asString(data.copilot_plan),
    windows,
    notes,
  };
}

// --- fetch helpers ----------------------------------------------------------

async function fetchProviderJson(
  url: string,
  token: string,
  extraHeaders: Record<string, string>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  secret: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...extraHeaders },
      signal: controller.signal,
    });
    const text = redact(await readBounded(response), secret);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}${text ? `: ${truncate(text, 200)}` : ""}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new Error("provider returned invalid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("provider response was not an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (signal?.aborted) throw new Error("usage query aborted");
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error instanceof Error ? new Error(redact(error.message, secret)) : error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        chunks.push(value.subarray(0, Math.max(0, value.byteLength - (total - MAX_BODY_BYTES))));
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(concat(chunks));
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join("[redacted]") : text;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

// --- small value helpers ----------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}
