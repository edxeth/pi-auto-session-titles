import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import autoSessionTitles from "../index";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

type FakeAuth = { ok: true; apiKey?: string } | { ok: false; error: string };

const SETTINGS_FIXTURES = join(import.meta.dir, "fixtures", "settings");

/** Point readSettings at a committed fixture dir; returns a restore function. */
function useSettingsFixture(name: string): () => void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(SETTINGS_FIXTURES, name);
	return () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	};
}

function createHarness(
	options: {
		title?: string;
		titles?: string[];
		deferTitle?: boolean;
		neverResolve?: boolean;
		branch?: unknown[];
		auth?: FakeAuth;
		registryMiss?: boolean;
		providerMiss?: boolean;
		providerStopReason?: "error" | "aborted";
		providerErrorMessage?: string;
		providerThrows?: string;
		authThrows?: string;
	} = {},
) {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, CommandHandler>();
	const setNames: string[] = [];
	const providerPrompts: string[] = [];
	const providerSignals: Array<AbortSignal | undefined> = [];
	const notifications: Array<{ message: string; level: string }> = [];
	let sessionName: string | undefined;
	const entries: unknown[] = [];
	let releaseDeferredTitle: (() => void) | undefined;
	const deferredTitle = options.deferTitle
		? new Promise<void>((resolve) => {
			releaseDeferredTitle = resolve;
		})
		: Promise.resolve();

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		setSessionName(name: string) {
			sessionName = name;
			setNames.push(name);
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: "/workspace/project",
		model: { provider: "test", id: "title-model" },
		sessionManager: {
			getBranch: () => options.branch ?? [],
			getEntries: () => entries,
			getSessionName: () => sessionName,
			getSessionFile: () => "/sessions/current.jsonl",
			getLeafId: () => "leaf-1",
		},
		modelRegistry: {
			find: () => (options.registryMiss ? undefined : { provider: "test", id: "title-model" }),
			getProvider: () =>
				options.providerMiss
					? undefined
					: {
						streamSimple: (
							_model: unknown,
							request: { messages: Array<{ content: Array<{ text: string }> }> },
							streamOptions: { signal?: AbortSignal },
						) => {
							providerPrompts.push(request.messages[0]?.content[0]?.text ?? "");
							providerSignals.push(streamOptions.signal);
							return {
								result: async () => {
									if (options.providerThrows) throw new Error(options.providerThrows);
									if (options.neverResolve) await new Promise<never>(() => {});
									await deferredTitle;
									const title = options.titles?.[providerPrompts.length - 1] ?? options.title ?? "Fix refresh token handling";
									const message: Record<string, unknown> = {
										content: [{ type: "text", text: JSON.stringify({ title }) }],
									};
									if (options.providerStopReason) message.stopReason = options.providerStopReason;
									if (options.providerErrorMessage !== undefined) message.errorMessage = options.providerErrorMessage;
									return message;
								},
							};
						},
					},
			getApiKeyAndHeaders: async () => {
				if (options.authThrows) throw new Error(options.authThrows);
				return options.auth ?? { ok: true, apiKey: "test-key" };
			},
		},
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext;

	autoSessionTitles(pi);

	return {
		providerPrompts,
		providerSignals,
		notifications,
		setNames,
		releaseTitle() {
			releaseDeferredTitle?.();
		},
		recordSessionInfo(id: string, name?: string) {
			sessionName = name;
			entries.push({ type: "session_info", id, name });
		},
		async emit(event: string, payload: unknown = {}) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
		async invokeCommand(name: string, args = "") {
			const handler = commands.get(name);
			if (!handler) throw new Error(`Command not registered: ${name}`);
			await handler(args, ctx);
		},
	};
}

describe("automatic session naming", () => {
	test("names the first settled request from visible work evidence", async () => {
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "Investigate the authentication failure",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("tool_call", {
			type: "tool_call",
			toolName: "read",
			toolCallId: "tool-1",
			input: { path: "@src/auth/refresh-token.ts" },
		});
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "The secret hypothesis must not be shared" },
						{ type: "text", text: "The refresh token is reused after rotation." },
					],
					stopReason: "stop",
				},
			],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(harness.setNames).toEqual(["Fix refresh token handling"]);
		expect(harness.providerPrompts).toHaveLength(1);
		const prompt = harness.providerPrompts[0] ?? "";
		expect(prompt).toContain("Investigate the authentication failure");
		expect(prompt).toContain("The refresh token is reused after rotation.");
		expect(prompt).toContain("read");
		expect(prompt).toContain("src/auth/refresh-token.ts");
		expect(prompt).not.toContain("secret hypothesis");
	});

	test("bounds title context and only includes allowlisted built-in paths", async () => {
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: `Investigate refresh tokens ${"request ".repeat(200)}`,
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		for (let index = 0; index < 25; index++) {
			await harness.emit("tool_call", {
				type: "tool_call",
				toolName: "read",
				toolCallId: `read-${index}`,
				input: { path: `./src/file-${index}.ts` },
			});
		}
		await harness.emit("tool_call", {
			type: "tool_call",
			toolName: "custom_secret_reader",
			toolCallId: "custom-1",
			input: { path: "/vault/private-token.txt" },
		});
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: `Refresh token analysis ${"details ".repeat(400)}` }] }],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		const prompt = harness.providerPrompts[0] ?? "";
		expect(prompt.length).toBeLessThan(4000);
		expect(prompt).toContain("src/file-19.ts");
		expect(prompt).not.toContain("src/file-20.ts");
		expect(prompt).not.toContain("/vault/private-token.txt");
		expect(prompt).toContain("custom_secret_reader");
	});

	test("does not treat a bare skill command as the session goal", async () => {
		const harness = createHarness({ title: "Update database migration schema" });

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "/skill:migrate",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Updated the database migration schema." }] }],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(harness.setNames).toEqual(["Update database migration schema"]);
		expect(harness.providerPrompts[0]).not.toContain("/skill:migrate");
	});

	test("does not overwrite an explicit name clear while generation is pending", async () => {
		const harness = createHarness({ deferTitle: true });

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "Investigate refresh token reuse",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Found refresh token reuse." }] }],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });

		harness.recordSessionInfo("manual-clear", undefined);
		harness.releaseTitle();
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(harness.setNames).toEqual([]);
	});

	test("manual rename excludes assistant thinking from the model prompt", async () => {
		const harness = createHarness({
			branch: [
				{ type: "message", message: { role: "user", content: "Fix authentication" } },
				{
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Secret abandoned OAuth hypothesis" },
							{ type: "text", text: "Fixed refresh token rotation." },
						],
					},
				},
			],
		});

		await harness.invokeCommand("rename-session");

		const prompt = harness.providerPrompts[0] ?? "";
		expect(prompt).toContain("Fixed refresh token rotation.");
		expect(prompt).not.toContain("Secret abandoned OAuth hypothesis");
	});

	test("manual rename bounds the prompt for very large sessions", async () => {
		const branch: unknown[] = [];
		for (let index = 0; index < 300; index++) {
			branch.push({
				type: "message",
				message: {
					role: index % 2 === 0 ? "user" : "assistant",
					content:
						index % 2 === 0
							? `Investigate the refresh token rotation bug, message ${index} ${"detail ".repeat(400)}`
							: [
									{ type: "thinking", thinking: "private reasoning" },
									{ type: "text", text: `Refresh token analysis step ${index} ${"notes ".repeat(400)}` },
								],
				},
			});
		}
		const harness = createHarness({ branch });

		await harness.invokeCommand("rename-session");

		const prompt = harness.providerPrompts[0] ?? "";
		// 24,000-char snippet cap plus the fixed prompt scaffold (~900 chars).
		expect(prompt.length).toBeLessThan(25_000);
		expect(prompt).toContain("Investigate the refresh token rotation bug, message 0");
		expect(prompt).toContain("Refresh token analysis step 299");
		expect(prompt).toContain("omitted");
		expect(harness.setNames).toEqual(["Fix refresh token handling"]);
	});

	test("does not use an errored assistant response as the agent summary", async () => {
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "Investigate refresh token handling",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Unauthorized internal error details" }],
					stopReason: "error",
				},
			],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(harness.setNames).toEqual(["Fix refresh token handling"]);
		expect(harness.providerPrompts[0]).not.toContain("Unauthorized internal error details");
	});

	test("gives the title provider an abort signal", async () => {
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "Investigate refresh token handling",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Found refresh token reuse." }] }],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(harness.providerSignals[0]).toBeInstanceOf(AbortSignal);
	});

	test("commits the latest staged idle input when the agent actually starts", async () => {
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "This input was handled before an agent run",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("input", {
			type: "input",
			text: "Investigate refresh token handling",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Found refresh token reuse." }] }],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		const prompt = harness.providerPrompts[0] ?? "";
		expect(prompt).toContain("Investigate refresh token handling");
		expect(prompt).not.toContain("This input was handled before an agent run");
	});

	test("waits for settlement and uses the final successful run after an error", async () => {
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "Investigate refresh token handling",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Temporary provider failure" }], stopReason: "error" }],
		});
		expect(harness.providerPrompts).toEqual([]);

		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Found refresh token reuse." }], stopReason: "stop" }],
		});
		expect(harness.providerPrompts).toEqual([]);

		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(harness.providerPrompts[0]).toContain("Found refresh token reuse.");
		expect(harness.providerPrompts[0]).not.toContain("Temporary provider failure");
	});

	test("ignores extension and steering inputs when capturing the original request", async () => {
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "Injected extension request",
			source: "extension",
			streamingBehavior: undefined,
		});
		await harness.emit("input", {
			type: "input",
			text: "Investigate refresh token handling",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("input", {
			type: "input",
			text: "Focus on logging instead",
			source: "interactive",
			streamingBehavior: "steer",
		});
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Found refresh token reuse." }] }],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		const prompt = harness.providerPrompts[0] ?? "";
		expect(prompt).toContain("Investigate refresh token handling");
		expect(prompt).not.toContain("Injected extension request");
		expect(prompt).not.toContain("Focus on logging instead");
	});

	test("does not auto-name resumed or explicitly named sessions", async () => {
		const resumed = createHarness({
			branch: [{ type: "message", message: { role: "user", content: "Existing conversation" } }],
		});
		await resumed.emit("session_start", { type: "session_start", reason: "resume" });
		await resumed.emit("input", {
			type: "input",
			text: "Continue the work",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await resumed.emit("agent_start", { type: "agent_start" });
		await resumed.emit("agent_settled", { type: "agent_settled" });

		const explicitlyCleared = createHarness();
		explicitlyCleared.recordSessionInfo("existing-session-info", undefined);
		await explicitlyCleared.emit("session_start", { type: "session_start", reason: "startup" });
		await explicitlyCleared.emit("input", {
			type: "input",
			text: "Investigate refresh token handling",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await explicitlyCleared.emit("agent_start", { type: "agent_start" });
		await explicitlyCleared.emit("agent_settled", { type: "agent_settled" });

		expect(resumed.providerPrompts).toEqual([]);
		expect(explicitlyCleared.providerPrompts).toEqual([]);
	});

	test("bounds shutdown even when a provider ignores cancellation", async () => {
		const harness = createHarness({ neverResolve: true });
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
			if (delay === 60_000) {
				queueMicrotask(() => (callback as (...callbackArgs: unknown[]) => void)(...args));
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}
			return originalSetTimeout(callback, delay, ...args);
		}) as typeof setTimeout;

		try {
			await harness.emit("session_start", { type: "session_start", reason: "startup" });
			await harness.emit("input", {
				type: "input",
				text: "Investigate refresh token handling",
				source: "interactive",
				streamingBehavior: undefined,
			});
			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("agent_end", {
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text: "Found refresh token reuse." }] }],
			});
			await harness.emit("agent_settled", { type: "agent_settled" });

			const outcome = await Promise.race([
				harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }).then(() => "completed"),
				new Promise<string>((resolve) => originalSetTimeout(() => resolve("timed-out"), 50)),
			]);
			expect(outcome).toBe("completed");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	test("preserves an explicit name clear before the naming attempt starts", async () => {
		const harness = createHarness();

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "Investigate refresh token handling",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Found refresh token reuse." }] }],
		});
		harness.recordSessionInfo("manual-clear", undefined);
		await harness.emit("session_info_changed", { type: "session_info_changed", name: undefined });
		await harness.emit("agent_settled", { type: "agent_settled" });

		expect(harness.providerPrompts).toEqual([]);
		expect(harness.setNames).toEqual([]);
	});
});

describe("title rule enforcement", () => {
	const agentsmdBranch = [
		{ type: "message", message: { role: "user", content: "Improve the agentsmd skill using Dex Horthy's improve-claude-md principles" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Improved the agentsmd skill and published it." }] } },
	];

	test("regenerates from the rejection instead of truncating mid-phrase", async () => {
		const overlong = "Improve agentsmd skill using Dex Horthy's improve-claude-md, then benchmark and publish it";
		const harness = createHarness({
			branch: agentsmdBranch,
			titles: [overlong, "Improve agentsmd skill from Dex Horthy's improve-claude-md"],
		});

		await harness.invokeCommand("rename-session");

		expect(harness.providerPrompts).toHaveLength(2);
		expect(harness.providerPrompts[0] ?? "").toContain("at most 72 characters");
		const retryPrompt = harness.providerPrompts[1] ?? "";
		expect(retryPrompt).toContain(overlong);
		expect(retryPrompt).toContain(`${overlong.length} characters, limit is 72`);
		expect(harness.setNames).toEqual(["Improve agentsmd skill from Dex Horthy's improve-claude-md"]);
	});

	test("falls back when the retry repeats the rejected overlong title", async () => {
		const overlong = "Improve agentsmd skill using Dex Horthy's improve-claude-md, then benchmark and publish it";
		const harness = createHarness({
			branch: agentsmdBranch,
			titles: [overlong, overlong],
		});

		await harness.invokeCommand("rename-session");

		expect(harness.providerPrompts).toHaveLength(2);
		expect(harness.setNames[0] ?? "").not.toBe("Improve agentsmd skill using Dex Horthy's improve-claude-md, then");
		expect(harness.setNames).toEqual(["improve the agentsmd skill using dex horthy's improve-claude-md"]);
	});

	test("bounds the rejected-title echo in the retry prompt", async () => {
		const huge = "X".repeat(5_000);
		const harness = createHarness({
			branch: agentsmdBranch,
			titles: [huge, "Improve agentsmd skill from Dex Horthy's improve-claude-md"],
		});

		await harness.invokeCommand("rename-session");

		expect(harness.providerPrompts).toHaveLength(2);
		const retryPrompt = harness.providerPrompts[1] ?? "";
		expect(retryPrompt).toContain("5000 characters, limit is 72");
		expect(retryPrompt.length).toBeLessThan((harness.providerPrompts[0] ?? "").length + 400);
		expect(harness.setNames).toEqual(["Improve agentsmd skill from Dex Horthy's improve-claude-md"]);
	});

	test("keeps the deterministic fallback for unusable first attempts", async () => {
		const harness = createHarness({
			branch: [{ type: "message", message: { role: "user", content: "Fix the refresh token rotation bug in the auth service" } }],
			titles: [""],
		});

		await harness.invokeCommand("rename-session");

		expect(harness.setNames).toEqual(["fix the refresh token rotation bug in the auth service"]);
	});
});

describe("rename-session failure diagnostics", () => {
	const renameBranch = [
		{ type: "message", message: { role: "user", content: "Fix the refresh token rotation bug" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Fixed the rotation." }] } },
	];

	function warning(harness: { notifications: Array<{ message: string; level: string }> }): string {
		const message = harness.notifications.find((entry) => entry.level === "warning")?.message;
		expect(message).toBeDefined();
		return message ?? "";
	}

	const SENTINEL = "SECRET-TOKEN-DO-NOT-ECHO";

	test("classifies a provider error response and keeps the current title", async () => {
		const harness = createHarness({
			branch: renameBranch,
			providerStopReason: "error",
			providerErrorMessage: "429 rate limit exceeded, retry after 30s",
		});

		await harness.invokeCommand("rename-session");

		// A real provider failure must not become a deterministic fallback title.
		expect(harness.setNames).toEqual([]);
		const message = warning(harness);
		expect(message).toContain("Could not generate a session title");
		expect(message).toContain("title model request failed");
		expect(message).toContain("rate limited");
		// Raw provider payload text must not reach the user.
		expect(message).not.toContain("retry after 30s");
		expect(message).toContain("/name");
	});

	test("never echoes a returned provider error containing a sentinel secret", async () => {
		const harness = createHarness({
			branch: renameBranch,
			providerStopReason: "error",
			// Sentinel sits inside the first 200 chars, followed by raw payload.
			providerErrorMessage: `${SENTINEL} gateway trace\n${"payload ".repeat(100)}`,
		});

		await harness.invokeCommand("rename-session");

		const message = warning(harness);
		expect(message).not.toContain(SENTINEL);
		expect(message).not.toContain("gateway trace");
		expect(message).toContain("the title model request failed");
		expect(message.length).toBeLessThan(200);
	});

	test("classifies a thrown provider failure and never echoes its sentinel secret", async () => {
		const harness = createHarness({ branch: renameBranch, providerThrows: `${SENTINEL} fetch failed` });

		await harness.invokeCommand("rename-session");

		expect(harness.setNames).toEqual([]);
		const message = warning(harness);
		expect(message).toContain("title model request failed");
		expect(message).toContain("network request failed");
		expect(message).not.toContain(SENTINEL);
	});

	test("reports authentication failure without requesting a title", async () => {
		const restore = useSettingsFixture("empty");
		const harness = createHarness({ branch: renameBranch, auth: { ok: false, error: 'No API key found for "test"' } });

		try {
			await harness.invokeCommand("rename-session");
		} finally {
			restore();
		}

		expect(harness.providerPrompts).toEqual([]);
		expect(harness.setNames).toEqual([]);
		const message = warning(harness);
		expect(message).toContain("authentication failed");
		expect(message).toContain('no API key found for provider "test"');
	});

	test("never echoes a raw credential error containing a sentinel secret", async () => {
		const restore = useSettingsFixture("empty");
		const harness = createHarness({
			branch: renameBranch,
			auth: { ok: false, error: `${SENTINEL}: credential command failed with exit code 1` },
		});

		try {
			await harness.invokeCommand("rename-session");
		} finally {
			restore();
		}

		expect(harness.providerPrompts).toEqual([]);
		const message = warning(harness);
		expect(message).toContain("authentication failed");
		expect(message).toContain('credential resolution failed for provider "test"');
		expect(message).not.toContain(SENTINEL);
	});

	test("treats a rejected credential lookup as an authentication failure", async () => {
		const restore = useSettingsFixture("empty");
		const harness = createHarness({ branch: renameBranch, authThrows: "keychain unavailable" });

		try {
			await harness.invokeCommand("rename-session");
		} finally {
			restore();
		}

		expect(harness.providerPrompts).toEqual([]);
		expect(harness.setNames).toEqual([]);
		expect(warning(harness)).toContain("authentication failed");
	});

	test("reports an unregistered provider without requesting a title", async () => {
		const harness = createHarness({ branch: renameBranch, providerMiss: true });

		await harness.invokeCommand("rename-session");

		expect(harness.providerPrompts).toEqual([]);
		expect(warning(harness)).toContain('provider "test" is not registered');
	});

	test("reports a missing title model without requesting a title", async () => {
		const restore = useSettingsFixture("empty");
		const harness = createHarness({ branch: renameBranch, registryMiss: true });

		try {
			await harness.invokeCommand("rename-session");
		} finally {
			restore();
		}

		expect(harness.providerPrompts).toEqual([]);
		const message = warning(harness);
		expect(message).toContain("no title model is available");
		expect(message).toContain('"test/title-model"');
	});

	test("reports disabled configuration without requesting a title", async () => {
		const restore = useSettingsFixture("disabled");
		const harness = createHarness({ branch: renameBranch });

		try {
			await harness.invokeCommand("rename-session");
		} finally {
			restore();
		}

		expect(harness.providerPrompts).toEqual([]);
		expect(harness.setNames).toEqual([]);
		expect(warning(harness)).toContain("disabled");
	});

	test("reports a timeout and keeps the current title", async () => {
		const harness = createHarness({ branch: renameBranch, neverResolve: true });
		const originalSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
			if (delay === 60_000) {
				queueMicrotask(() => (callback as (...callbackArgs: unknown[]) => void)(...args));
				return 1 as unknown as ReturnType<typeof setTimeout>;
			}
			return originalSetTimeout(callback, delay, ...args);
		}) as typeof setTimeout;

		try {
			await harness.invokeCommand("rename-session");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}

		expect(harness.setNames).toEqual([]);
		expect(warning(harness)).toContain("timed out after 60 seconds");
	});

	test("reports a session with no conversation evidence", async () => {
		const harness = createHarness({ branch: [] });

		await harness.invokeCommand("rename-session");

		expect(harness.providerPrompts).toEqual([]);
		expect(harness.setNames).toEqual([]);
		expect(warning(harness)).toContain("no conversation messages");
	});

	test("reports an unusable title when validation and fallback both fail", async () => {
		const harness = createHarness({
			branch: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "I refuse to help." }] } }],
			titles: ["ok", "ok"],
		});

		await harness.invokeCommand("rename-session");

		expect(harness.providerPrompts).toHaveLength(2);
		expect(harness.setNames).toEqual([]);
		expect(warning(harness)).toContain("not a usable title");
	});

	test("declines to rename a Ralph-loop-managed title with a specific message", async () => {
		const harness = createHarness({ branch: renameBranch });
		harness.recordSessionInfo("ralph-iteration", "Ralph loop iteration 2/5");

		await harness.invokeCommand("rename-session");

		expect(harness.providerPrompts).toEqual([]);
		expect(harness.setNames).toEqual([]);
		expect(warning(harness)).toContain("Ralph loop");
	});

	test("automatic naming stays silent and unset when the provider errors", async () => {
		const harness = createHarness({ providerStopReason: "error", providerErrorMessage: "429 rate limit exceeded" });

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.emit("input", {
			type: "input",
			text: "Investigate refresh token handling",
			source: "interactive",
			streamingBehavior: undefined,
		});
		await harness.emit("agent_start", { type: "agent_start" });
		await harness.emit("agent_end", {
			type: "agent_end",
			messages: [{ role: "assistant", content: [{ type: "text", text: "Found refresh token reuse." }], stopReason: "stop" }],
		});
		await harness.emit("agent_settled", { type: "agent_settled" });
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

		expect(harness.setNames).toEqual([]);
		expect(harness.notifications).toEqual([]);
	});
});
