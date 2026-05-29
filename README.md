# pi-auto-session-titles

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

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
    "provider": "zai-messages",
    "model": "glm-5v-turbo",
    "thinkingLevel": "high"
  }
}
```

If `thinkingLevel` is omitted, title generation defaults to `minimal` thinking so it does not inherit a slow high-reasoning chat setting.
If `autoSessionTitles.model` is omitted, the extension falls back to pi's default model.

## Commands

### `/rename-session`

Regenerates the current session title from the current branch using the full user/assistant conversation transcript.

## Notes

- Auto-title generation only fills blank session titles. If another extension or launcher pre-titles a session, that explicit title is preserved. Use `/rename-session` to regenerate manually.
- Title generation uses only user messages and assistant text/thinking from the current branch.
- Tool calls, tool results, system prompts, available tool schemas, and other session metadata are excluded from the title prompt.
- Titles are kept short, lowercase, and punchier than default AI title-case sludge.
- Custom title-model selection lives in `~/.pi/agent/settings.json` under `autoSessionTitles.provider`, `autoSessionTitles.model`, and `autoSessionTitles.thinkingLevel`.
