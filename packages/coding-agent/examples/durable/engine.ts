import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { CodingEngine } from "./task.ts";

export function createOmpEngine(
	cwd: string,
	sessionDir: string,
	options: Omit<CreateAgentSessionOptions, "cwd" | "sessionManager"> = {},
): CodingEngine {
	return {
		async prepare(input) {
			const manager = input.sessionFile
				? await SessionManager.open(input.sessionFile, undefined, undefined, { throwIfMissing: true })
				: SessionManager.create(cwd, sessionDir);
			try {
				await manager.ensureOnDisk();
				const sessionFile = manager.getSessionFile();
				if (!sessionFile) throw new Error("OMP did not allocate a persistent session");
				return sessionFile;
			} finally {
				await manager.close();
			}
		},
		async run(input, sessionFile, signal) {
			signal.throwIfAborted();
			const manager = await SessionManager.open(sessionFile, undefined, undefined, { throwIfMissing: true });
			try {
				const { session } = await createAgentSession({
					...options,
					cwd,
					sessionManager: manager,
					bindProcessState: false,
				});
				let aborting: Promise<void> | undefined;
				let abortError: unknown;
				const abort = () => {
					aborting ??= session.abort({ reason: "Durable task stopped" }).catch(error => {
						abortError = error;
					});
				};
				signal.addEventListener("abort", abort, { once: true });
				try {
					signal.throwIfAborted();
					const accepted = await session.prompt(input.prompt, { runCommands: false, throwOnDrop: true });
					signal.throwIfAborted();
					if (!accepted) throw new Error("OMP did not accept the coding prompt");
					const answer = session.getLastAssistantMessage();
					if (!answer || answer.stopReason !== "stop") {
						throw new Error(answer?.errorMessage ?? `OMP ended without a final answer (${answer?.stopReason})`);
					}
					await manager.flush();
					return answer.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
				} finally {
					signal.removeEventListener("abort", abort);
					try {
						await aborting;
						if (abortError !== undefined) throw abortError;
					} finally {
						await session.dispose();
					}
				}
			} finally {
				await manager.close();
			}
		},
	};
}
