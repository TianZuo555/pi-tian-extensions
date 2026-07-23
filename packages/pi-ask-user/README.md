# pi-tian-ask-user

Let the model ask you a multiple-choice question from [pi](https://pi.dev).

```bash
pi install npm:pi-tian-ask-user
```

Registers an `ask_user` tool. The model supplies a question and 2–5 options; a
free-form **"Write my own answer"** option is always added, and you can dismiss
the question without answering.

In interactive mode the options render as a popup: `↑↓` or number keys to move,
`Enter` to confirm, `Esc` to dismiss.

While it waits for your answer, the tool reports the input requirement on pi's
**shared event bus** (`pi.events`). This is pi's in-process mechanism for tool ↔
integration communication: an integration subscribes with `pi.events.on(...)`,
aggregates active requests into its own agent state, and bridges that state to
its client.

The canonical event is `agent:input_required`. Its versioned payload has a
stable `id` so consumers can handle duplicate and concurrent requests safely:

```ts
{
  version: 1,
  id: string,        // ask_user tool-call ID
  source: "ask_user",
  active: boolean,   // true before waiting, false in finally
  label: string      // normalized question, always present
}
```

The same payload is temporarily also emitted as `herdr:blocked` for compatibility
with version 6 of [Herdr](https://herdr.dev)'s shipped pi integration. New
consumers should subscribe to `agent:input_required`; the producer reports why
it is waiting, while clients such as Herdr own final status precedence and
notification behavior.

Pi core has no native "blocked" status (only *working* while a tool call is in
flight vs *idle*), and can't distinguish an autonomous long-running tool from
one waiting on a human. Emitting is best-effort, balanced active→inactive via
`try/finally`, and a harmless no-op when nothing listens. No event is emitted in
non-UI modes.

See the [collection repository](https://github.com/TianZuo555/pi-tian-extensions#ask-user)
for full documentation.
