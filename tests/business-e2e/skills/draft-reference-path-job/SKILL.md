# draft-reference-path-job

## Role

Drive image + local-corpus directory references through Draft → Planner → Job, proving the task can read the image and every file under the referenced directory (including nested).

## Goal

1. Isolated project + `create_task` thread.
2. Upload fixture as `attachment.png`; one turn that proposes a draft (no answer leaks).
3. Poll until draft is editable; keep `draftMessageId`.
4. `codetask_import_draft_references` with the message attachmentId + description.
   (Turn attachments are often auto-added with empty descriptions; the import tool must still apply descriptions — via PATCH if the id already exists.)
5. `codetask_add_local_corpus_reference` with an **absolute** directory path **outside** the project workspace (under the case run's `reference-corpus/`).
6. `confirm_draft` → `update_draft_execution_config` → `confirm_draft_final`; keep `designSessionId`.
7. Poll `codetask_get_plans` (real `/plans`) until plan ready; ensure tasks use Reference IDs (not absolute paths) with non-empty `referenceReason`.
8. `confirm_plan` → `wait_job` completed.
9. `confirm_plan` publishes the executable Job into a new task-owned thread. Wait with the returned Job's `threadId`, never the original create-task thread id.
10. Report: `draftMessageId`, `attachmentId`, `directoryReferenceId`, `designSessionId`, `launchedJobId`, `launchedThreadId`, `localCorpusPath`.

This is a one-shot read proof, not a request to build a reusable tool. The Job must read the
bound References directly and only add `reference-proof.json`; it must not add programs, scripts,
dependencies, tests, fixtures, or mock design files. The proof contains image text + all design
sentinels (overview / api / nested constraints).

## Forbidden

- Do not put Dream / 1000 / Cats or DESIGN\_\* sentinels into prompts, titles, or fileName
- Do not place the local corpus inside the project workspace
- Do not treat absolute paths as Reference IDs
- Do not use missing-message probes as business success
