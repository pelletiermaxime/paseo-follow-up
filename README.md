# Paseo Follow-up

Suggest a short next message after an agent responds, powered by **gpt-6-luna**.

> **Experimental — work in progress (WIP).** This plugin currently depends on my [Paseo Max fork](https://github.com/pelletiermaxime/paseo-max) to display suggestions. The model is **hardcoded to `gpt-6-luna`** and cannot be configured. Expect bugs, incomplete features and breaking changes.

Suggestions appear as faint text in an empty Paseo Max composer. Press **Tab** or **Right Arrow** to accept one as an editable draft, or **Escape** to dismiss it. Typing also dismisses the suggestion. Nothing is sent automatically, and existing text or attachments are preserved.

## Requirements

- Paseo Max with its composer API on desktop or web. The plugin targets the Paseo 0.13.0 SDK; stock Paseo clients do not display suggestions.
- Codex CLI installed and signed in on the daemon host, with access to `gpt-6-luna`.
- A local Codex model catalogue containing `gpt-6-luna` (`models_cache.json` under `CODEX_HOME`, default `~/.codex`).

Clients without the composer API remain usable without generating suggestions. Mobile generation is disabled because the current composer API does not support touch acceptance.

## Install

Clone this repository, install its dependencies with [Vite+](https://viteplus.dev), then install it as a local plugin:

```sh
cd /path/to/paseo-follow-up
vp install
paseo plugin install "$PWD" --json
```

Plugins run trusted, unsandboxed code on the daemon host and inside the app. Review the source before installing.

Open **Follow-up** in plugin settings or use the composer pill to enable or disable suggestions. Settings apply to that daemon host. Suggestions default to enabled and make additional Luna calls using the host's existing Codex login.

## Behavior and privacy

- Generates for open agent chats after successful replies. Historical replies are not backfilled at startup.
- Uses only recent user/assistant text: up to eight messages and 12,000 characters total. Tool results, reasoning, plugin entries and attachment data are excluded.
- Returns at most one single-line suggestion of 240 characters per completed turn. Luna may return no suggestion.
- Shares generation across clients and cancels obsolete requests on new turns, navigation, permissions, archive, disable or unload. Temporary composer unavailability or submission is retried using cached text; an existing draft, acceptance or dismissal prevents replay.
- Switching chats or tabs clears an unaccepted suggestion. Returning does not restore a suggestion that was already displayed. Accept it as an editable draft before leaving if you want to keep it.
- Uses a bounded, ephemeral Codex process. A local preflight verifies that the effective model request exposes no tools before conversation text is sent.
- Keeps credentials on the host, sends context over stdin, removes temporary files, and does not log transcripts or raw provider errors. No separate API key is required.

A local language check rejects clear mismatches with the latest user message. Uncertain language detection does not block suggestions.

If suggestions are missing, check that the composer is empty, suggestions are enabled, and Codex can access Luna on the host. The CLI must support the isolated, tool-free invocation; incompatible versions fail closed. Generation has been tested with Codex CLI 0.164.0.

Runtime logs contain request/delivery stages and identifiers, without conversation text:

```sh
paseo plugin logs follow-up --json
```

## Development

```sh
vp install
vp run check
vp run typecheck
vp run test
```

Validation uses at most four native threads and two test workers. Normal tests do not call a model. To run the opt-in generation tests using the host's saved login and model usage:

```sh
FOLLOW_UP_LIVE=1 vp run test tests/luna.test.ts
```

After changing an installed checkout, reload it with:

```sh
paseo plugin reload follow-up --json
```
