import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const SETTINGS_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "settings.json");
const SETTINGS_NAMESPACE = "autoSessionTitles";
const VALID_THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const MAX_SNIPPET_MESSAGES = 10;
const MAX_SNIPPET_CHARS = 6000;
const MAX_FULL_SNIPPET_CHARS = 50000;
const MAX_TITLE_LENGTH = 72;

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
type ModelRef = { provider: string; modelId: string; thinkingLevel?: ThinkingLevel };

type AutoTitleSettings = {
	enabled?: boolean;
	model?: string;
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
	if (!thinkingLevel && fallbackThinking && VALID_THINKING_LEVELS.has(fallbackThinking)) {
		thinkingLevel = fallbackThinking as ThinkingLevel;
	}

	return { provider, modelId, thinkingLevel };
}

function resolveTitleModel(ctx: ExtensionContext): ModelRef | null {
	const settings = readSettings();
	const configured = settings[SETTINGS_NAMESPACE];
	if (configured?.enabled === false) return null;

	if (configured?.model) {
		const fromConfig = parseModelRef(configured.model, settings.defaultProvider, settings.defaultThinkingLevel);
		if (fromConfig) return fromConfig;
	}

	if (settings.defaultProvider && settings.defaultModel) {
		const fromDefaults = parseModelRef(
			`${settings.defaultProvider}/${settings.defaultModel}`,
			settings.defaultProvider,
			settings.defaultThinkingLevel,
		);
		if (fromDefaults) return fromDefaults;
	}

	if (settings.defaultModel) {
		const fromModelOnly = parseModelRef(settings.defaultModel, settings.defaultProvider, settings.defaultThinkingLevel);
		if (fromModelOnly) return fromModelOnly;
	}

	const current = ctx.model;
	if (!current) return null;
	const thinkingLevel = ctx.getThinkingLevel();
	return {
		provider: String(current.provider),
		modelId: current.id,
		thinkingLevel: VALID_THINKING_LEVELS.has(thinkingLevel) ? (thinkingLevel as ThinkingLevel) : undefined,
	};
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const text = (block as { type?: string; text?: string }).text;
		if ((block as { type?: string }).type === "text" && typeof text === "string") {
			parts.push(text);
		}
	}
	return parts.join(" ").trim();
}

function buildConversationSnippet(ctx: ExtensionContext, prompt?: string, maxMessages = MAX_SNIPPET_MESSAGES, maxChars = MAX_SNIPPET_CHARS): string {
	const entries = ctx.sessionManager.getBranch();
	const messages: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !("message" in entry)) continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = extractText(message.content);
		if (!text) continue;
		messages.push(`${message.role === "user" ? "User" : "Assistant"}: ${text}`);
	}

	if (prompt?.trim()) {
		messages.push(`User: ${prompt.trim()}`);
	}

	const recent = maxMessages >= messages.length ? messages : messages.slice(-maxMessages);
	let snippet = recent.join("\n\n");
	if (snippet.length > maxChars) {
		snippet = snippet.slice(snippet.length - maxChars);
	}
	return snippet;
}

function cleanTitle(raw: string): string {
	let title = raw
		.replace(/^['"`]+|['"`]+$/g, "")
		.replace(/\s+/g, " ")
		.replace(/[\r\n]+/g, " ")
		.replace(/[\p{Cf}]/gu, "")
		.trim();

	title = title.replace(/[.!?]+$/g, "").trim();
	if (!title) return "";
	if (title.length > MAX_TITLE_LENGTH) {
		title = title.slice(0, MAX_TITLE_LENGTH).trim();
		const lastSpace = title.lastIndexOf(" ");
		if (lastSpace > 18) title = title.slice(0, lastSpace).trim();
	}
	return title;
}

function titlePrompt(snippet: string, retrying = false): string {
	return [
		"Write a short title for this coding session.",
		"Rules:",
		"- up to 12 words",
		"- Title Case",
		"- no quotes, bullets, markdown, or punctuation",
		"- focus on the main task",
		"- output only the title",
		retrying ? "- previous attempt was too long, shorten it" : "",
		"",
		"Conversation:",
		snippet,
	].filter(Boolean).join("\n");
}

function wordCount(value: string): number {
	return value.trim().split(/\s+/).filter(Boolean).length;
}

function fallbackTitleFromSnippet(snippet: string): string {
	const firstUserLine = snippet
		.split(/\r?\n/)
		.find((line) => line.startsWith("User:"))
		?.replace(/^User:\s*/, "")
		.trim();
	if (!firstUserLine) return "";
	const words = firstUserLine.split(/\s+/).filter(Boolean).slice(0, 12);
	if (words.length === 0) return "";
	return cleanTitle(words.map((word) => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase()).join(" "));
}

export default function (pi: ExtensionAPI) {
	let done = false;

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
		if (nextTitle && wordCount(nextTitle) > 12) {
			nextTitle = cleanTitle(await tryGenerate(true));
		}

		if (!nextTitle) {
			nextTitle = fallbackTitleFromSnippet(snippet);
		}

		if (nextTitle && wordCount(nextTitle) <= 12) {
			return nextTitle;
		}

		return "";
	}

	async function runTitleOnce(ctx: ExtensionContext, prompt?: string) {
		if (done) return;
		done = true;
		try {
			const snippet = buildConversationSnippet(ctx, prompt);
			if (!snippet) return;

			const currentTitle = ctx.sessionManager.getSessionName();
			const nextTitle = await generateTitle(ctx, snippet);
			if (nextTitle && nextTitle !== currentTitle) {
				pi.setSessionName(nextTitle);
			}
		} catch {
			// Leave the existing title unchanged on failure.
		}
	}

	pi.registerCommand("rename-session", {
		description: "Regenerate the current session title from the full conversation",
		handler: async (_args, ctx) => {
			const snippet = buildConversationSnippet(ctx, undefined, undefined, MAX_FULL_SNIPPET_CHARS);
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
		void runTitleOnce(ctx, event.prompt);
	});

	pi.on("session_shutdown", async () => {
		done = true;
	});
}
