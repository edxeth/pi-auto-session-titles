import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const SETTINGS_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
const SETTINGS_NAMESPACE = "autoSessionTitles";
const VALID_THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const MAX_TITLE_LENGTH = 72;
const MAX_TITLE_WORDS = 15;
const DEFAULT_TITLE_THINKING_LEVEL: ThinkingLevel = "minimal";

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
type ModelRef = { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };

type AutoTitleSettings = {
	enabled?: boolean;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
};

type SettingsFile = {
	defaultProvider?: string;
	defaultModel?: string;
	defaultThinkingLevel?: string;
	autoSessionTitles?: AutoTitleSettings;
};

function readSettings(): SettingsFile {
	try {
		if (!existsSync(SETTINGS_FILE)) return {};
		const raw = readFileSync(SETTINGS_FILE, "utf8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SettingsFile) : {};
	} catch {
		return {};
	}
}

function validThinkingLevel(value?: string): ThinkingLevel | undefined {
	return value && VALID_THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : undefined;
}

function parseModelRef(spec: string, fallbackProvider?: string, fallbackThinking?: string): ModelRef | null {
	const trimmed = spec.trim();
	if (!trimmed) return null;

	let provider = fallbackProvider ?? "";
	let modelId = trimmed;
	let thinkingLevel: ThinkingLevel | undefined = undefined;

	const slashIndex = trimmed.indexOf("/");
	if (slashIndex !== -1) {
		provider = trimmed.slice(0, slashIndex).trim();
		modelId = trimmed.slice(slashIndex + 1).trim();
	}

	const colonIndex = modelId.lastIndexOf(":");
	if (colonIndex !== -1) {
		const suffix = modelId.slice(colonIndex + 1).trim();
		if (VALID_THINKING_LEVELS.has(suffix)) {
			thinkingLevel = suffix as ThinkingLevel;
			modelId = modelId.slice(0, colonIndex).trim();
		}
	}

	if (!provider || !modelId) return null;
	if (!thinkingLevel) thinkingLevel = validThinkingLevel(fallbackThinking);

	return { provider, modelId, thinkingLevel };
}

function resolveTitleModel(ctx: ExtensionContext): ModelRef | null {
	const settings = readSettings();
	const configured = settings[SETTINGS_NAMESPACE];
	if (configured?.enabled === false) return null;

	if (configured?.model) {
		const fromConfig = parseModelRef(
			configured.model,
			configured.provider ?? settings.defaultProvider,
			configured.thinkingLevel ?? DEFAULT_TITLE_THINKING_LEVEL,
		);
		if (fromConfig) return fromConfig;
	}

	if (settings.defaultProvider && settings.defaultModel) {
		const fromDefaults = parseModelRef(
			`${settings.defaultProvider}/${settings.defaultModel}`,
			settings.defaultProvider,
			DEFAULT_TITLE_THINKING_LEVEL,
		);
		if (fromDefaults) return fromDefaults;
	}

	if (settings.defaultModel) {
		const fromModelOnly = parseModelRef(settings.defaultModel, settings.defaultProvider, DEFAULT_TITLE_THINKING_LEVEL);
		if (fromModelOnly) return fromModelOnly;
	}

	const current = ctx.model;
	if (!current) return null;
	return {
		provider: String(current.provider),
		modelId: current.id,
		thinkingLevel: DEFAULT_TITLE_THINKING_LEVEL,
	};
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return contentBlocksText(content, "text");
}

function contentBlocksText(content: unknown, type: "text" | "thinking"): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: unknown; text?: unknown; thinking?: unknown };
			if (type === "text" && block.type === "text" && typeof block.text === "string") return block.text;
			if (type === "thinking" && block.type === "thinking" && typeof block.thinking === "string") return block.thinking;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function buildConversationSnippet(ctx: ExtensionContext, prompt?: string): string {
	const parts: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const text = contentText(message.content);
			if (text) parts.push(`[User]: ${text}`);
		} else if (message.role === "assistant") {
			const thinking = contentBlocksText(message.content, "thinking");
			const text = contentBlocksText(message.content, "text");
			if (thinking) parts.push(`[Assistant thinking]: ${thinking}`);
			if (text) parts.push(`[Assistant]: ${text}`);
		}
	}
	if (prompt?.trim()) parts.push(`[User]: ${prompt.trim()}`);
	return parts.join("\n\n");
}

function sentenceCaseTitleCase(title: string): string {
	const words = title.split(/\s+/).filter(Boolean);
	const plainWords = words.filter((word) => /\p{L}/u.test(word));
	if (plainWords.length < 2) return title;

	const titleCaseWord = /^["'`([{]*\p{Lu}\p{Ll}+[\p{Ll}\p{N}'’-]*["'`\])},:;]*$/u;
	const titleCasedWords = plainWords.filter((word) => titleCaseWord.test(word));
	if (titleCasedWords.length / plainWords.length < 0.6) return title;

	let keptFirst = false;
	return title
		.split(/(\s+)/)
		.map((word) => {
			if (!titleCaseWord.test(word)) return word;
			if (!keptFirst) {
				keptFirst = true;
				return word;
			}
			return word.toLocaleLowerCase();
		})
		.join("");
}

function extractTitleText(raw: string): string {
	const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
	try {
		const parsed = JSON.parse(text) as { title?: unknown };
		if (typeof parsed.title === "string") return parsed.title;
	} catch {
		const match = text.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
		if (match) {
			try {
				return JSON.parse(`"${match[1]}"`) as string;
			} catch {
				return match[1];
			}
		}
	}
	return text;
}

function cleanTitle(raw: string): string {
	let title = extractTitleText(raw)
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/\s+/g, " ")
		.replace(/[\r\n]+/g, " ")
		.replace(/[\p{Cf}]/gu, "")
		.trim();

	title = title
		.replace(/\b(?:reply|respond)\s+(?:with\s+)?(?:just\s+)?ok\b.*$/i, "")
		.replace(/\b(?:fuck(?:ing)?|shit|crap|damn)\b/gi, "")
		.replace(/\s+/g, " ")
		.replace(/[.!?]+$/g, "")
		.trim();
	title = sentenceCaseTitleCase(title).replace(/[.!?]+$/g, "").trim();
	if (!title) return "";
	if (title.length > MAX_TITLE_LENGTH) {
		title = title.slice(0, MAX_TITLE_LENGTH).trim();
		const lastSpace = title.lastIndexOf(" ");
		if (lastSpace > 18) title = title.slice(0, lastSpace).trim();
	}
	return title.replace(/[.!?]+$/g, "").trim();
}

function titlePrompt(snippet: string, retrying = false): string {
	return [
		"Generate a concise, complete, sentence-case title (3-15 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns. Do not end with an incomplete phrase like 'instead of', 'with', 'for', or 'of'.",
		"",
		"Return JSON with a single \"title\" field.",
		retrying ? "The previous attempt was too long, vague, unrelated, or malformed. Try again with a grounded title." : "",
		"",
		"Bad (too vague): {\"title\": \"Code changes\"}",
		"Bad (wrong case): {\"title\": \"Fix Login Button On Mobile\"}",
		"Bad (unrelated): {\"title\": \"Fix OAuth callback race\"} unless OAuth callbacks are actually in the conversation.",
		"",
		"Conversation:",
		snippet,
	].filter(Boolean).join("\n");
}

function wordCount(value: string): number {
	return value.trim().split(/\s+/).filter(Boolean).length;
}

function isBadTitle(value: string): boolean {
	const lower = value.toLocaleLowerCase().trim();
	if (["ok", "okay", "done", "yes"].includes(lower)) return true;
	if (/\b(?:instead\s+of|rather\s+than|such\s+as|as\s+a)$/i.test(value)) return true;
	if (/\b(?:a|an|and|as|at|by|for|from|in|into|of|on|or|the|to|with|without)$/i.test(value)) return true;
	return false;
}

function meaningfulWords(value: string): Set<string> {
	const stopwords = new Set([
		"a",
		"an",
		"and",
		"are",
		"for",
		"from",
		"how",
		"into",
		"just",
		"like",
		"make",
		"the",
		"this",
		"that",
		"with",
		"write",
	]);
	const words = value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
	return new Set(words.filter((word) => word.length > 2 && !stopwords.has(word)));
}

function isGroundedTitle(title: string, snippet: string): boolean {
	const titleWords = meaningfulWords(title);
	if (titleWords.size === 0) return false;
	const snippetWords = meaningfulWords(snippet);
	return [...titleWords].some((word) => snippetWords.has(word));
}

function fallbackTitleFromSnippet(snippet: string): string {
	const firstUserLine = snippet
		.split(/\r?\n/)
		.find((line) => line.startsWith("[User]:"))
		?.replace(/^\[User\]:\s*/, "")
		.trim();
	if (!firstUserLine) return "";
	const words = firstUserLine.split(/\s+/).filter(Boolean).slice(0, MAX_TITLE_WORDS);
	if (words.length === 0) return "";
	return cleanTitle(words.join(" ").toLocaleLowerCase());
}

export default function (pi: ExtensionAPI) {
	let done = false;
	let pendingTitle: Promise<void> | null = null;

	function hasConversationMessages(ctx: ExtensionContext) {
		return ctx.sessionManager.getBranch().some((entry) => entry.type === "message");
	}

	async function generateTitle(ctx: ExtensionContext, snippet: string): Promise<string> {
		const modelRef = resolveTitleModel(ctx);
		if (!modelRef) return "";

		const currentTitle = ctx.sessionManager.getSessionName();
		if (/^Ralph loop iteration \d+\/\d+$/.test(currentTitle ?? "")) return "";
		const apiModel = ctx.modelRegistry.find(modelRef.provider, modelRef.modelId);
		if (!apiModel) return "";

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(apiModel);
		if (!auth.ok || !auth.apiKey) return "";

		const tryGenerate = async (retrying = false) => {
			const response = await complete(
				apiModel,
				{
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: titlePrompt(snippet, retrying) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: auth.apiKey,
					headers: auth.headers,
					reasoningEffort: modelRef.thinkingLevel,
				},
			);

			return response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join(" ");
		};

		let nextTitle = cleanTitle(await tryGenerate(false));
		if (nextTitle && (wordCount(nextTitle) > MAX_TITLE_WORDS || isBadTitle(nextTitle) || !isGroundedTitle(nextTitle, snippet))) {
			nextTitle = cleanTitle(await tryGenerate(true));
		}

		if (!nextTitle || isBadTitle(nextTitle) || !isGroundedTitle(nextTitle, snippet)) {
			nextTitle = fallbackTitleFromSnippet(snippet);
		}

		if (nextTitle && wordCount(nextTitle) <= MAX_TITLE_WORDS && !isBadTitle(nextTitle) && isGroundedTitle(nextTitle, snippet)) {
			return nextTitle;
		}

		return "";
	}

	async function runTitleOnce(ctx: ExtensionContext, prompt?: string) {
		if (done) return;
		done = true;
		try {
			const currentTitle = ctx.sessionManager.getSessionName();
			if (currentTitle) return;

			const snippet = buildConversationSnippet(ctx, prompt);
			if (!snippet) return;

			const nextTitle = await generateTitle(ctx, snippet);
			if (nextTitle) {
				pi.setSessionName(nextTitle);
			}
		} catch {
			// Leave the existing title unchanged on failure.
		}
	}

	pi.registerCommand("rename-session", {
		description: "Regenerate the current session title from the full user/assistant transcript",
		handler: async (_args, ctx) => {
			const snippet = buildConversationSnippet(ctx);
			const nextTitle = await generateTitle(ctx, snippet);
			if (!nextTitle) {
				ctx.ui.notify("Could not generate a session title", "warning");
				return;
			}
			pi.setSessionName(nextTitle);
			ctx.ui.notify(`Session renamed: ${nextTitle}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		done = hasConversationMessages(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		pendingTitle = runTitleOnce(ctx, event.prompt).finally(() => {
			pendingTitle = null;
		});
	});

	pi.on("session_shutdown", async () => {
		if (pendingTitle) await pendingTitle;
		done = true;
	});
}
