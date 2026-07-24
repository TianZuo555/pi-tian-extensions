# pi-tian-usage

Show **OpenAI Codex** and **GitHub Copilot** account usage from inside the
[pi coding agent](https://pi.dev).

`/usage` opens a menu with the current usage for both providers, and a compact
meter is shown in the footer whenever the active model belongs to a supported
provider.

```text
OpenAI Codex · Plus
  Weekly limit:     [████████████░░░░░░░░] 60% left · resets 14:20 on 27 Jul
GitHub Copilot · Business
  Premium requests: [██████████░░░░░░░░░░] 49% left · 12,387 / 25,000
  Chat:             unlimited
  Completions:      unlimited
  Quota resets: 2026-08-01
```

## Commands

- `/usage` — open the usage menu. Pick **Refresh** to re-query, **Close** to
  dismiss. In non-interactive modes it prints a one-line summary instead.

## Statusline

When the active model provider is Codex or Copilot, the footer shows a compact
meter such as `codex 60% wk` or `copilot 49% premium`, refreshed at most every
five minutes (results are cached to avoid hammering the endpoints).

## How it works

Credentials are read from the same store pi writes, `~/.pi/agent/auth.json`:

| Provider | Endpoint | Token used |
|----------|----------|------------|
| OpenAI Codex | `https://chatgpt.com/backend-api/wham/usage` | ChatGPT OAuth **access** token (pi resolves/refreshes it via the model registry, falling back to `auth.json`) |
| GitHub Copilot | `https://api.github.com/copilot_internal/user` | GitHub OAuth token (the `refresh` credential pi stores for `github-copilot`) |

For Copilot, if pi has no stored credential the extension falls back to the
`GH_TOKEN` / `GITHUB_TOKEN` / `GITHUB_COPILOT_TOKEN` / `COPILOT_GITHUB_TOKEN`
environment variables and then to the VS Code Copilot credential file
(`~/.config/github-copilot/apps.json`).

A provider that has no resolvable credential is shown as **Not configured** —
sign in with `/login` and select that provider.

## Install

```bash
pi install npm:pi-tian-usage
```

Try it without installing permanently:

```bash
pi -e npm:pi-tian-usage
```

## License

[MIT](./LICENSE) © Tian Zuo
