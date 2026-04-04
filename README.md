# pi-auto-session-titles

Auto-generate session titles for [pi](https://github.com/badlogic/pi-mono).

## What it does

- Sets a title on the **first real message** in a session
- Skips retitling when you resume an existing chat
- Adds `/rename-session` to regenerate the title later from the full conversation

## Install

```bash
pi install git:github.com/edxeth/pi-auto-session-titles
```

## Configuration

Set a dedicated model for title generation in `~/.pi/agent/settings.json`:

```json
{
  "autoSessionTitles": {
    "enabled": true,
    "model": "anthropic/claude-haiku-4-5"
  }
}
```

You can also include a thinking level suffix, like `provider/model:low`.
If `autoSessionTitles.model` is omitted, the extension falls back to pi's default model.

## Commands

### `/rename-session`

Regenerates the current session title from the whole branch history.

## Notes

- Initial auto-titles use a short recent-context snippet.
- `/rename-session` uses a much larger context window for better accuracy.
- The title is still kept short and clean for the session selector.
- Custom title-model selection lives in `~/.pi/agent/settings.json` under `autoSessionTitles.model`.
