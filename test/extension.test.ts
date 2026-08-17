import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import autoSessionTitles from "../index";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

function createHarness(options: { title?: string; deferTitle?: boolean; neverResolve?: boolean; branch?: unknown[] } = {}) {
	const handlers = new Map<string, EventHandler[]>();
	const commands = new Map<string, CommandHandler>();
	const setNames: string[] = [];
	const providerPrompts: string[] = [];
	const providerSignals: Array<AbortSignal | undefined> = [];
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
			find: () => ({ provider: "test", id: "title-model" }),
			getProvider: () => ({
				streamSimple: (
					_model: unknown,
					request: { messages: Array<{ content: Array<{ text: string }> }> },
					streamOptions: { signal?: AbortSignal },
				) => {
					providerPrompts.push(request.messages[0]?.content[0]?.text ?? "");
					providerSignals.push(streamOptions.signal);
					return {
						result: async () => {
							if (options.neverResolve) await new Promise<never>(() => {});
							await deferredTitle;
							return {
								content: [{ type: "text", text: JSON.stringify({ title: options.title ?? "Fix refresh token handling" }) }],
							};
						},
					};
				},
			}),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
		},
		ui: { notify() {} },
	} as unknown as ExtensionContext;

	autoSessionTitles(pi);

	return {
		providerPrompts,
		providerSignals,
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
