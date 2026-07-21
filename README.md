# pi-tian-extensions

A small collection of [pi coding agent](https://pi.dev) extensions.

| Extension | Commands / Tools | What it does |
|-----------|------------------|--------------|
| **pi-repo-model** | `/repo-model`, `/repo-model-unset`, `/repo-model-list`, tool `repo_default_model` | Remembers a default model + thinking level **per repository** and auto-applies it at session start. |
| **pi-repo-skills** | `/skills`, `/skills-list`, `/skills-reset`, tool `repo_skills` | Enable/disable individual skills **per repository** via a checkbox TUI. Disabled skills are stripped from the system prompt. |
| **image-cache** | `Ctrl+V`, `/images`, `/image-cache-clear` | Caches pasted/clipboard images as `[Image#NNN]` placeholders and attaches them to your messages (macOS clipboard support). |

Selections for the per-repo extensions are stored centrally and keyed by git
root, so each repository keeps its own preferences without touching global
settings or the repo's own `.pi/` folder.

## Install

```bash
pi install git:github.com/TianZuo555/pi-tian-extensions
```

Or add it to `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/TianZuo555/pi-tian-extensions"]
}
```

To load only some of the extensions, use the filtering object form:

```json
{
  "packages": [
    {
      "source": "git:github.com/TianZuo555/pi-tian-extensions",
      "extensions": ["extensions/pi-repo-skills.ts"]
    }
  ]
}
```

Try without installing:

```bash
pi -e git:github.com/TianZuo555/pi-tian-extensions
```

## Extensions

### pi-repo-model

Stores one model preference per repository in `~/.pi/repo-model/config.json` and
applies it at session start (default triggers: fresh start + new session).

- `/repo-model` — pick a model, then a thinking level, from dropdowns.
- `/repo-model provider/model[:thinking]` — set directly, e.g. `/repo-model cursor/composer-2.5:high`.
- `/repo-model-unset` — clear the current repo's default.
- `/repo-model-list` — list every configured repo.

The agent can also manage it via the `repo_default_model` tool.

### pi-repo-skills

Turns individual skills on/off per repository. Disabled skills are removed from
the system prompt (like `disable-model-invocation: true`), so the model won't
auto-load them. State lives in `~/.pi/repo-skills/config.json`.

- `/skills` — checkbox TUI: `↑↓/jk` move, `space` toggle, `a` disable all, `n` enable all, `enter` save, `esc` cancel.
- `/skills-list` — list all repos with overrides.
- `/skills-reset` — clear this repo's overrides.
- Tool `repo_skills` — `get` / `list` / `disable` / `enable` / `disable-all` / `enable-all` / `reset`.

`disabled` is stored as an array of skill names or the sentinel `"ALL"` (every
skill off, future-proof against newly installed skills).

### image-cache

Caches pasted images so they survive as compact `[Image#NNN]` placeholders and
are re-attached to the model on send. On macOS, `Ctrl+V` pastes the clipboard
image directly. Cache lives under `~/.pi/agent/cache/image-cache/` with a 24h TTL.

## Development

```bash
npm install
npm run typecheck
```

Extensions import pi's runtime packages
(`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, `typebox`) as **peer dependencies** — pi provides them
at runtime.

## License

[MIT](./LICENSE) © Tian Zuo
