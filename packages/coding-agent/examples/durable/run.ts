import * as path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, type TaskId } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createOmpEngine } from "./engine.ts";
import { type CodingResult, createCodingTask } from "./task.ts";

const [command, ...args] = process.argv.slice(2);
if (
	(command !== "run" && command !== "wait") ||
	(command === "run" && (args.length < 1 || args.length > 2 || !args[0]?.trim())) ||
	(command === "wait" && args.length !== 1)
) {
	throw new Error('Usage: bun run.ts run "coding task" [OMP-session-file] | wait <durable-task-id>');
}
const context = BACKGROUND_CONTEXT;
const cwd = process.cwd();
const stateDir = path.resolve(process.env.OMP_DURABLE_STATE ?? ".state");
const task = createCodingTask(
	createOmpEngine(cwd, path.join(stateDir, "omp"), {
		modelPattern: process.env.OMP_DURABLE_MODEL,
		autoApprove: process.env.OMP_DURABLE_AUTO_APPROVE === "1",
	}),
);
const registry = createRegistry();
registry.install(defineExtension({ name: "omp", tasks: [task] }));
const storage = await openNodeJsonlStorage(path.join(stateDir, "durable"), context);
const harness = await Harness.open(storage, { models: createModels(), registry }, context);
const stop = () => {
	void harness.close(context).catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
	const root = await harness.root(context);
	let id: TaskId<CodingResult>;
	if (command === "run") {
		const [prompt, sessionFile] = args;
		if (!prompt || args.length > 2) throw new Error("Supply one quoted prompt and an optional OMP session file");
		id = await root.commit(
			tx =>
				tx.createTask(
					task,
					{ prompt, ...(sessionFile ? { sessionFile: path.resolve(sessionFile) } : {}) },
					{
						ownership: { kind: "conversation" },
					},
				),
			context,
		);
		console.error(`Durable task: ${id}\nReopen with: bun run.ts wait ${id}`);
	} else {
		// Task IDs are opaque branded strings; wait accepts one printed by the run command.
		id = args[0] as TaskId<CodingResult>;
	}
	const settled = await harness.waitForTask(id, context);
	console.log(JSON.stringify(settled.state.outcome, null, 2));
	if (settled.state.outcome.status !== "completed") process.exitCode = 1;
} finally {
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
	await harness.close(context);
}
