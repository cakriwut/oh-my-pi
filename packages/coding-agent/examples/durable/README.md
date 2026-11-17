# OMP as a pi-durable task

This standalone example uses the **full OMP SDK** as the coding engine. There is
no second LLM coordinating it: pi-durable owns a durable task, and OMP owns its
internal agent loop, tools, extensions, and MCP connections.

## Install and run

Prerequisites: Bun 1.3.14 or newer and credentials configured for OMP (for example
an `OPENAI_API_KEY`, or an existing OMP login). Install this example's dependencies
separately from the monorepo:

```sh
cd packages/coding-agent/examples/durable
npm install --workspaces=false
export OMP_DURABLE_MODEL=openai/gpt-4.1
bun run.ts run "Inspect this directory and summarize its contents without changing files."
```

`OMP_DURABLE_MODEL` is optional; without it, OMP uses its configured/default model.
The program prints the durable task ID to stderr and its JSON outcome to stdout.
Both pi-durable state and OMP sessions persist under `.state/`.

The working directory is the directory where you launch the program. To operate
on another project, use an absolute path to `run.ts` and keep an absolute,
project-specific `OMP_DURABLE_STATE`:

```sh
cd /path/to/your/project
export OMP_DURABLE_STATE=/path/to/your/project-state
bun /path/to/oh-my-pi/packages/coding-agent/examples/durable/run.ts run \
  "Inspect the failing tests and explain the cause."
```

For unattended work that needs tool approval, explicitly set
`OMP_DURABLE_AUTO_APPROVE=1`. This grants OMP permission to execute commands and
edit files; use a trusted workspace with suitable isolation. Otherwise the normal
OMP approval policy applies, and tools needing interactive approval may fail.
OMP's normal workspace discovery also applies; review project extensions and MCP
configuration before running untrusted workspaces.

## Reopen and explicitly continue

Use the printed ID with the **same state directory**:

```sh
bun run.ts wait <durable-task-id>
```

A completed task returns its saved receipt without calling OMP again. A task
interrupted during OMP execution fails with its `error.detail.sessionFile` rather
than automatically repeating potentially destructive work. Inspect that OMP
session and the workspace; then explicitly create a continuation:

```sh
bun run.ts run "Continue from the saved history; first check what already completed." \
  /absolute/path/from/error/detail/sessionFile
```

The original task remains failed; the continuation has its own durable task ID
and reuses the OMP session. A missing session is an error, not a new conversation.
Run only one host against a state directory and only one task per OMP session or
workspace at a time.

## Recovery guarantees and limits

- The OMP session is materialized and its path checkpointed before execution.
- A second checkpoint marks execution as unsafe to replay **before** invoking
  OMP. After a restart, this marker requires explicit inspection/continuation.
- Cancellation/closing the harness aborts the OMP session and disposes resources.
- Success stores the final text and session path in pi-durable's task receipt.
  Model/tool failures surface as failures, not successful text.
- OMP turns and tool calls are **not** pi-durable checkpoints. There is no
  exactly-once guarantee for external effects. A crash after execution starts,
  even after OMP saves an answer but before the task receipt commits, requires
  manual reconciliation.
- The two storage directories are separate; back up both. A crash during initial
  session allocation can leave an unused OMP session file, but runs no prompt.

## Tests

With dependencies installed and Node 22.19+ (or Bun), run:

```sh
npm test
```

These orchestration tests use the real pi-durable JSONL storage and a deterministic
engine fixture: persisted receipts, explicit session continuation, surfaced engine
errors, cancellation, and refusal to replay after reopening. They do **not** prove
OMP SDK/provider interoperability. The command above is the live SDK exercise;
run it with your configured provider before using the wrapper for important work.
