import { defineTask } from "@earendil-works/pi-durable";

export type CodingInput = { prompt: string; sessionFile?: string };
export type CodingResult = { text: string; sessionFile: string };
export type CodingCheckpoint =
	| { phase: "prepare" }
	| { phase: "ready"; sessionFile: string }
	| { phase: "interrupted"; sessionFile: string };

export interface CodingEngine {
	prepare(input: CodingInput): Promise<string>;
	run(input: CodingInput, sessionFile: string, signal: AbortSignal): Promise<string>;
}

export function createCodingTask(engine: CodingEngine) {
	return defineTask<CodingInput, CodingCheckpoint, CodingResult>({
		name: "example.omp",
		version: 1,
		initial: () => ({ phase: "prepare" }),
		phases: {
			prepare: async (task, runtime, context) => {
				if (!task.input.prompt.trim()) throw new Error("A non-empty coding prompt is required");
				const sessionFile = await engine.prepare(task.input);
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "ready", sessionFile } }),
					context,
				);
			},
			ready: async (task, runtime, context) => {
				const { sessionFile } = task.state.checkpoint;
				// OMP effects cannot be committed atomically with the durable task.
				// On recovery, this marker prevents an automatic second invocation.
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "interrupted", sessionFile } }),
					context,
				);
				let text: string;
				try {
					text = await engine.run(task.input, sessionFile, runtime.signal);
				} catch (error) {
					runtime.signal.throwIfAborted();
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: {
								status: "failed",
								error: {
									message: error instanceof Error ? error.message : String(error),
									detail: { sessionFile },
								},
							},
						}),
						context,
					);
					return;
				}
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: { text, sessionFile } } }),
					context,
				);
			},
			interrupted: async (task, runtime, context) => {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: {
							status: "failed",
							error: {
								message: "OMP was interrupted. Inspect its session and workspace before explicitly continuing.",
								detail: { sessionFile: task.state.checkpoint.sessionFile },
							},
						},
					}),
					context,
				);
			},
		},
		abort: async (task, runtime, context) => {
			const checkpoint = task.state.checkpoint;
			await runtime.commit(
				() => ({
					status: "terminal",
					outcome: {
						status: "aborted",
						reason:
							checkpoint.phase === "prepare"
								? "Cancelled before the OMP session was checkpointed"
								: `Cancelled; inspect OMP session ${checkpoint.sessionFile} before continuing`,
					},
				}),
				context,
			);
		},
	});
}
