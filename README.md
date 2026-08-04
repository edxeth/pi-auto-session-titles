# pi-auto-session-titles

## 🌐 **Join the Community**

> [!NOTE]
> **Building with AI doesn’t have to be a solo grind.**  
> Join our Discord community to meet other people exploring the latest models, tools, workflows, and ideas: **https://discord.gg/whhrDtCrSS**
>
> We talk about what’s new, what’s useful, and what’s actually worth paying attention to in AI.  
> *And if you want more than conversation,* members also get access to **heavily discounted AI products and services** — including deals on tools like **ChatGPT Plus** and more for just a few dollars.

This extension generates automatic session titles for [pi](https://github.com/badlogic/pi-mono).

## What it does

- The extension sets a title after the **first request fully settles**.
- Pi completes automatic retries, compaction recovery, and queued continuation before automatic naming starts.
- The extension uses the original request, the final response from the assistant, tool names, and relevant paths.
- The extension does not change the title when you resume an existing session.
- The `/rename-session` command regenerates the title from the full conversation.

Before automatic naming is complete, the session has no explicit title. Pi shows the first user message in the session selector.

## Install

```bash
pi install git:github.com/edxeth/pi-auto-session-titles
```

## Configuration

Set a dedicated model for automatic naming in `~/.pi/agent/settings.json`:

```json
{
  "autoSessionTitles": {
    "enabled": true,
    "provider": "zai",
    "model": "glm-5v-turbo",
    "thinkingLevel": "high"
  }
}
```

If you omit `thinkingLevel`, automatic naming uses `minimal` thinking. This value prevents inheritance of a slow setting for high-reasoning chat.

If you omit `autoSessionTitles.model`, the extension uses the default model of Pi.

## Commands

### `/rename-session`

This command regenerates the session title from the current branch. It uses the full transcript between the user and the assistant.

## Notes

- Automatic naming sets only blank session titles.
- If another extension or launcher sets a title first, this extension keeps that title unchanged.
- The `/rename-session` command provides manual title regeneration.
- Automatic naming uses the original request, the final response from the assistant, and deduplicated tool names.
- Automatic naming includes up to 20 normalized paths from these built-in tools:
  - `read`
  - `edit`
  - `write`
  - `grep`
  - `find`
  - `ls`
- The extension does not send these items to the title model:
  - assistant thinking
  - tool-result contents
  - file contents
  - bash commands
  - custom-tool arguments
  - images
  - system prompts
  - available tool schemas
  - other session metadata
- A bare skill invocation, such as `/skill:migrate`, is not the session goal.
- Automatic naming relies on the work that the agent reports and the files that the agent touches.
- The extension limits each context field and the total input for automatic naming.
- The extension stops a title-model request after 15 seconds.
- The configured title model receives relevant paths. These paths can reveal project structure, but they do not contain file contents.
- The extension does not change an automatic title after creation. Compaction does not start automatic naming again.
- The extension keeps titles short and in sentence case. It does not use title case for all words.
- The configuration for the title model uses `autoSessionTitles.provider`, `autoSessionTitles.model`, and `autoSessionTitles.thinkingLevel` in `~/.pi/agent/settings.json`.

## Development

Install the development dependencies:

```bash
bun install
```

Run the project verification:

```bash
bun run verify
```

The `verify` command runs the behavior tests and the TypeScript type check.
