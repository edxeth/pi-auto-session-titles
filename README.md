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
If no suffix is provided, title generation defaults to `minimal` thinking so it does not inherit a slow high-reasoning chat setting.
If `autoSessionTitles.model` is omitted, the extension falls back to pi's default model.

## Commands

### `/rename-session`

Regenerates the current session title from the current branch using the full user/assistant conversation transcript.

## Notes

- Title generation uses only user messages and assistant text/thinking from the current branch.
- Tool calls, tool results, system prompts, available tool schemas, and other session metadata are excluded from the title prompt.
- Titles are kept short, lowercase, and punchier than default AI title-case sludge.
- Custom title-model selection lives in `~/.pi/agent/settings.json` under `autoSessionTitles.model`.
