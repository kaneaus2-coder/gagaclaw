# Changelog

## v1.1.0 (2026-03-05)

### New Features
- **Linux & macOS support** — Setup prompts now support Linux (Host mode, Docker B1/B2 mode) and macOS. The AI-guided installer detects the platform and generates appropriate launch scripts.
- **Cron prompt visibility** — Cron job prompts now appear as visible messages in Telegram before AI processing.
- **Startup version check** — Compares local version with GitHub on startup, notifies if update is available.
- **Server error detection** — Detects 503 and other server errors in the stream, reports to user when no response is produced.

### Improvements
- **Telegram HTML rendering** — Added `fixTgHtml()` to auto-close unclosed/misnested HTML tags during streaming. Added `<tg-spoiler>`, `<tg-emoji>`, `<blockquote expandable>` support.
- **Rate limit handling** — Respects Telegram 429 `retry_after`, auto-retries instead of failing.
- **Streaming display** — Thinking and response show last 3000 chars with continuous updates. At turn end, streaming message is deleted and full response is sent as new messages.
- **"Message not modified" fix** — Skips edits when content hasn't changed, eliminating spam.

### Config Changes
- `defaults.model` now requires the full model ID (e.g. `MODEL_PLACEHOLDER_M37`), not shorthand keys like `high`.
- `gagaclaw.example.json` updated with `adminChatId` field and correct model ID.

### Bug Fixes
- Fixed `<a>` tag missing from `fixTgHtml`, causing HTML parse failures.
- Fixed `<br>` tag (unsupported by Telegram) converted to `\n`.
- Fixed `processCronQueue` missing `async` keyword for `await tgSend`.
- Fixed MCP `adminChatId` fallback to `allowedUsers[0]`.

## v1.0.0 (2026-03-01)

Initial release.
- Telegram bot interface with inline keyboard buttons
- CLI interactive terminal interface
- Multi-model support (Gemini, Claude, GPT)
- Cron scheduler for recurring AI tasks
- MCP server (groq_transcribe + telegram_send_file)
- Permission system with YOLO auto-approve mode
- Workspace system with soul.md and memory.md
