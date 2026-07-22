// ask-user — lets the model ask the user a single multiple-choice question.
//
// The model provides 2–5 options; a free-form "Write my own answer" option is
// always appended. In interactive (TUI) mode the options render as a popup:
//   ↑↓ or 1–N to move · Enter to confirm · Esc to dismiss.
// Choosing "Write my own answer" opens a multi-line editor; submitting an empty
// answer returns to the option list. Dismissing tells the model you declined.
//
// In RPC mode it falls back to the built-in select/input dialogs. In non-UI
// modes (print/json) it reports back that no UI was available so the model can
// ask in plain text instead.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  SelectList,
  type SelectItem,
  type SelectListTheme,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  type AskUserOutcome,
  buildAskUserResultMessage,
} from "./lib/prompt";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const OTHER_VALUE = "__ask_user_other__";
const OTHER_LABEL = "Write my own answer…";

const OptionSchema = Type.Object({
  label: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel }),
  description: Type.Optional(
    Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription }),
  ),
});

const AskUserParams = Type.Object({
  question: Type.String({ description: ASK_USER_PARAMETER_DESCRIPTIONS.question }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
  }),
});

export type AskUserInput = Static<typeof AskUserParams>;

interface AskUserDetails {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
}

type Picked =
  | { kind: "option"; label: string; index: number }
  | { kind: "other" }
  | { kind: "cancel" };

// Word-wrap a paragraph to a column width, preserving explicit newlines.
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > width && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: ASK_USER_TOOL_DESCRIPTION,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    parameters: AskUserParams,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (text: string, answer: string | null = null, wasCustom = false) => ({
        content: [{ type: "text" as const, text }],
        details: {
          question: params.question,
          options: params.options.map((o) => o.label),
          answer,
          wasCustom,
          cancelled: answer === null,
        } satisfies AskUserDetails,
      });

      if (params.options.length < MIN_OPTIONS || params.options.length > MAX_OPTIONS) {
        throw new Error(
          `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${params.options.length}). Retry with a valid number of options.`,
        );
      }

      const dismissedOrCancelled = (): AskUserOutcome =>
        signal?.aborted ? { kind: "cancelled" } : { kind: "dismissed" };

      // The model's options plus the always-present free-form option.
      const items: SelectItem[] = params.options.map((o, i) => ({
        value: `opt-${i}`,
        label: o.label,
        description: o.description,
      }));
      items.push({ value: OTHER_VALUE, label: OTHER_LABEL });

      // --- Interactive TUI popup -------------------------------------------
      if (ctx.mode === "tui") {
        // Loop so an empty free-form answer returns to the option list.
        for (;;) {
          if (signal?.aborted) {
            return reply(buildAskUserResultMessage({ kind: "cancelled" }));
          }

          const picked = await showOptions(ctx, params.question, items, signal);

          if (picked.kind === "cancel") {
            return reply(buildAskUserResultMessage(dismissedOrCancelled()));
          }

          if (picked.kind === "other") {
            const answer = (await ctx.ui.editor("Write your answer", ""))?.trim();
            if (answer) {
              return reply(buildAskUserResultMessage({ kind: "custom", answer }), answer, true);
            }
            continue; // back to the options
          }

          return reply(
            buildAskUserResultMessage({
              kind: "selected",
              answer: picked.label,
              index: picked.index,
            }),
            picked.label,
          );
        }
      }

      // --- RPC fallback: built-in select/input dialogs ---------------------
      if (ctx.hasUI) {
        const labels = items.map((i) =>
          i.description ? `${i.label} — ${i.description}` : i.label,
        );
        const choice = await ctx.ui.select(params.question, labels);
        if (choice === undefined) {
          return reply(buildAskUserResultMessage(dismissedOrCancelled()));
        }
        const idx = labels.indexOf(choice);
        if (idx === items.length - 1) {
          const answer = (await ctx.ui.input(params.question))?.trim();
          if (answer) {
            return reply(buildAskUserResultMessage({ kind: "custom", answer }), answer, true);
          }
          return reply(buildAskUserResultMessage({ kind: "dismissed" }));
        }
        const opt = params.options[idx];
        return reply(
          buildAskUserResultMessage({ kind: "selected", answer: opt.label, index: idx + 1 }),
          opt.label,
        );
      }

      // --- No UI (print/json) ----------------------------------------------
      return reply(buildAskUserResultMessage({ kind: "no-ui" }));
    },

    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("ask_user "));
      text += theme.fg("muted", typeof args.question === "string" ? args.question : "");
      const opts = Array.isArray(args.options)
        ? (args.options as Array<{ label?: string }>)
        : [];
      if (opts.length > 0) {
        const numbered = opts.map((o, i) => `${i + 1}. ${o.label ?? ""}`);
        text += `\n${theme.fg("dim", `  ${numbered.join("  ")}`)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as AskUserDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      if (details.cancelled || details.answer === null) {
        return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
      }
      if (details.wasCustom) {
        return new Text(
          theme.fg("success", "✓ ") +
            theme.fg("muted", "(wrote) ") +
            theme.fg("accent", details.answer),
          0,
          0,
        );
      }
      const idx = details.options.indexOf(details.answer) + 1;
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
    },
  });
}

// Renders the question header and the option list as a custom TUI popup,
// resolving to the user's choice (or a cancel when Esc/abort fires).
function showOptions(
  ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
  question: string,
  items: SelectItem[],
  signal: AbortSignal | undefined,
): Promise<Picked> {
  return ctx.ui.custom<Picked>((tui, theme, _keybindings, done) => {
    let settled = false;
    const finish = (picked: Picked) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      done(picked);
    };
    const onAbort = () => finish({ kind: "cancel" });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) queueMicrotask(onAbort);

    const listTheme: SelectListTheme = {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    };

    const list = new SelectList(items, Math.min(items.length, 8), listTheme);
    list.onSelect = (item) => {
      const index = items.findIndex((i) => i.value === item.value);
      if (item.value === OTHER_VALUE) finish({ kind: "other" });
      else finish({ kind: "option", label: item.label, index: index + 1 });
    };
    list.onCancel = () => finish({ kind: "cancel" });

    let cache: string[] | undefined;
    const invalidate = () => {
      cache = undefined;
      list.invalidate();
    };

    return {
      render(width: number): string[] {
        if (cache) return cache;
        const lines: string[] = [];
        const add = (s: string) => lines.push(truncateToWidth(s, width));

        const title = " Question ";
        add(
          theme.fg(
            "accent",
            `─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`,
          ),
        );
        for (const line of wrapText(question, Math.max(10, width - 2))) {
          add(` ${theme.fg("text", theme.bold(line))}`);
        }
        lines.push("");
        for (const line of list.render(width - 1)) add(` ${line}`);
        lines.push("");
        add(theme.fg("dim", ` ↑↓ or 1-${items.length} select · Enter confirm · Esc dismiss`));
        add(theme.fg("accent", "─".repeat(width)));

        cache = lines;
        return lines;
      },
      invalidate,
      handleInput(data: string) {
        // Number keys jump straight to (and confirm) an option.
        if (data.length === 1 && data >= "1" && data <= "9") {
          const n = Number(data);
          if (n >= 1 && n <= items.length) {
            list.onSelect?.(items[n - 1]);
            return;
          }
        }
        list.handleInput(data);
        invalidate();
        tui.requestRender();
      },
      dispose() {
        signal?.removeEventListener("abort", onAbort);
      },
    };
  });
}
