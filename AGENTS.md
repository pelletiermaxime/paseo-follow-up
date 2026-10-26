# Development guidelines

- Do not commit or push without explicit approval.
- Keep this plugin standalone: client code in `client/`, host code in `server/`, shared settings/RPC contracts in `shared/`, and runtime entrypoints at the root.
- Target the official Paseo 0.13.0 SDK. Feature-detect optional composer capabilities; unsupported clients must not request generation.
- Use public SDK APIs and verify optional fork contracts before changing integration code. Do not access private frontend stores.
- Use the host's configured small model and thinking level for suggestions, defaulting to `gpt-6.1-terra` with low thinking. Never silently substitute another model or thinking level.
- Keep authentication and generation on the daemon host. Do not log transcripts, credentials or raw provider errors.
- Suggestions must not submit messages, overwrite drafts/attachments, execute tools or start agent work.
- Generate only for open, eligible chats. Preserve context/output bounds, per-turn deduplication and cancellation. Do not backfill historical chats or generate for internal agents/subagents.
- Use `vp install` and the `vp run` scripts. Keep native validation at four threads and tests at two workers.
- Keep live model tests opt-in. Report automated checks, real generation, plugin loading and composer interaction as separate verification results.
