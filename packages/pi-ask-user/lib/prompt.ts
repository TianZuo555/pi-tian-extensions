// Model-facing prompt strings for the ask_user tool. Kept separate from the
// implementation so the wording can be tuned without touching UI logic.

/** Schema descriptions shown to the model for the question and each option. */
export const ASK_USER_PARAMETER_DESCRIPTIONS = {
  optionLabel: "Short display label for this option",
  optionDescription: "Optional one-line description shown next to the label",
  question: "The question to ask the user",
  options:
    "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
};

/** Tool description shown to the model in the system prompt. */
export const ASK_USER_TOOL_DESCRIPTION =
  "Ask the user a single multiple-choice question (2-5 options). A free-form 'write my own answer' option is always added automatically, and the user may dismiss the question without answering. Ask exactly one question per call.";

/** One-line entry added to the model's `Available tools` section. */
export const ASK_USER_PROMPT_SNIPPET =
  "Ask the user a multiple-choice question (2-5 options plus a free-form answer)";

/** Guideline bullets appended to the system prompt while ask_user is active. */
export const ASK_USER_PROMPT_GUIDELINES = [
  "When asking the user a question whose likely answers can be enumerated, use the ask_user tool instead of asking in plain text.",
  "Ask one question per ask_user call; ask any follow-up questions in subsequent calls.",
];

/** Outcome of a single ask_user interaction. */
export type AskUserOutcome =
  | { kind: "no-ui" }
  | { kind: "cancelled" }
  | { kind: "dismissed" }
  | { kind: "custom"; answer: string }
  | { kind: "selected"; answer: string; index: number };

/** Builds the tool-result text reported back to the model for an outcome. */
export function buildAskUserResultMessage(outcome: AskUserOutcome): string {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the question could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled.";
    case "dismissed":
      return "User dismissed the question without answering. Do not assume an answer; proceed accordingly or ask differently.";
    case "custom":
      return `User wrote their own answer: ${outcome.answer}`;
    case "selected":
      return `User selected option ${outcome.index}: ${outcome.answer}`;
  }
}
