import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { type CodingEngine, createCodingTask } from "./task.ts";

const context = BACKGROUND_CONTEXT;

async function open(directory: string, engine: CodingEngine) {
	const task = createCodingTask(engine);
	const registry = createRegistry();
	registry.install(defineExtension({ name: "omp", tasks: [task] }));
	const storage = await openNodeJsonlStorage(directory, context);
	const harness = await Harness.open(storage, { models: createModels(), registry }, context);
	const root = await harness.root(context);
	return { task, harness, root };
}

async function fixture(t: TestContext) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-durable-"));
	const harnesses: Harness[] = [];
	t.after(async () => {
		for (const harness of harnesses) await harness.close(context);
		await fs.rm(directory, { recursive: true, force: true });
	});
	return {
		directory,
		async open(engine: CodingEngine) {
			const opened = await open(directory, engine);
			harnesses.push(opened.harness);
			return opened;
		},
	};
}

test("completed work survives reopening without invoking the engine twice", { timeout: 15_000 }, async t => {
	const state = await fixture(t);
	const { directory } = state;
	let calls = 0;
	const engine: CodingEngine = {
		prepare: async input => input.sessionFile ?? path.join(directory, "omp.jsonl"),
		run: async input => {
			calls++;
			return `Finished: ${input.prompt}`;
		},
	};
	const first = await state.open(engine);
	const id = await first.root.commit(
		tx => tx.createTask(first.task, { prompt: "update fixture" }, { ownership: { kind: "conversation" } }),
		context,
	);
	const completed = await first.harness.waitForTask(id, context);
	assert.deepEqual(completed.state.outcome, {
		status: "completed",
		result: { text: "Finished: update fixture", sessionFile: path.join(directory, "omp.jsonl") },
	});
	await first.harness.close(context);
	const second = await state.open(engine);
	const reopened = await second.harness.waitForTask(id, context);
	assert.deepEqual(reopened.state.outcome, completed.state.outcome);
	assert.equal(calls, 1);
});

test("engine failures are failed outcomes with the session needed for inspection", { timeout: 15_000 }, async t => {
	const state = await fixture(t);
	const { harness, root, task } = await state.open({
		prepare: async input => {
			assert.equal(input.sessionFile, "/existing/session.jsonl");
			return input.sessionFile;
		},
		run: async () => {
			throw new Error("Provider rejected request");
		},
	});
	const id = await root.commit(
		tx =>
			tx.createTask(
				task,
				{ prompt: "continue fixture", sessionFile: "/existing/session.jsonl" },
				{ ownership: { kind: "conversation" } },
			),
		context,
	);
	const settled = await harness.waitForTask(id, context);
	assert.deepEqual(settled.state.outcome, {
		status: "failed",
		error: {
			message: "Provider rejected request",
			detail: { sessionFile: "/existing/session.jsonl" },
		},
	});
});

test("closing during execution cancels the engine and reopening refuses to replay its effects", { timeout: 15_000 }, async t => {
	const state = await fixture(t);
	const { directory } = state;
	const started = Promise.withResolvers<void>();
	const stopped = Promise.withResolvers<void>();
	let calls = 0;
	const engine: CodingEngine = {
		prepare: async () => path.join(directory, "omp.jsonl"),
		run: async (_input, _sessionFile, signal) => {
			calls++;
			const pending = Promise.withResolvers<string>();
			signal.addEventListener(
				"abort",
				() => {
					stopped.resolve();
					pending.reject(signal.reason);
				},
				{ once: true },
			);
			started.resolve();
			return pending.promise;
		},
	};
	const first = await state.open(engine);
	const id = await first.root.commit(
		tx => tx.createTask(first.task, { prompt: "perform effects" }, { ownership: { kind: "conversation" } }),
		context,
	);
	const waiting = first.harness.waitForTask(id, context);
	const interruptedWait = assert.rejects(waiting);
	await started.promise;
	await first.harness.close(context);
	await stopped.promise;
	await interruptedWait;
	const second = await state.open(engine);
	const settled = await second.harness.waitForTask(id, context);
	assert.equal(settled.state.outcome.status, "failed");
	if (settled.state.outcome.status !== "failed") assert.fail("Interrupted work must require explicit recovery");
	assert.deepEqual(settled.state.outcome.error.detail, { sessionFile: path.join(directory, "omp.jsonl") });
	assert.equal(calls, 1);
});
