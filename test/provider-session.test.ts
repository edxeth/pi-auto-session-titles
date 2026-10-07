import { expect, test } from "bun:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

for (const createProvider of [opencodeProvider, opencodeGoProvider]) {
	const provider = createProvider();

	test(`${provider.id} sends the session id in the outgoing request`, async () => {
		const sessionId = "0199abcd-session";
		const receivedSessionIds: Array<string | null> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				receivedSessionIds.push(request.headers.get("x-opencode-session"));
				return new Response(
					`data: ${JSON.stringify({
						id: "title-response",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: { content: '{"title":"Fix refresh token handling"}' }, finish_reason: "stop" }],
					})}\n\ndata: [DONE]\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		});

		try {
			const model = provider.getModels().find((candidate) => candidate.api === "openai-completions");
			if (!model) throw new Error(`${provider.id} has no OpenAI completions model for this regression test`);
			const response = await provider.streamSimple(
				{ ...model, baseUrl: server.url.toString() },
				normalizeContext({ messages: [{ role: "user", content: "Name this session", timestamp: 0 }] }),
				{ apiKey: "local-test-key", sessionId, signal: AbortSignal.timeout(2_000) },
			).result();

			expect(response.stopReason).toBe("stop");
			expect(receivedSessionIds).toEqual([sessionId]);
		} finally {
			await server.stop(true);
		}
	});
}
