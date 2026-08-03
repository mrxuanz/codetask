# draft-reference-path-job

## Role

Drive image + local-corpus directory references through Design Draft → Planning → Job, proving the task can read the image and every file under the referenced directory (including nested).

## Goal

1. Isolated project + chat conversation (Design owns drafts via `/api/drafts`).
2. Upload fixture as `attachment.png`; produce a draft (no answer leaks).
3. If the chat agent asks for details, follow up up to 3 more turns (4 total) without leaking fixture text; attachments only on the first turn.
4. Poll until draft is editable; keep `draftId`.
5. Import draft references with the message attachmentId + description.
6. Add local-corpus reference with an **absolute** directory path **outside** the project workspace.
7. Confirm draft → set execution profile → confirm final / start planning; keep planning session id.
8. Poll plans until ready; ensure tasks use Reference IDs (not absolute paths) with non-empty `referenceReason`.
9. Confirm plan → wait job completed.
10. Wait with the returned Job id/thread, never assume a create_task thread id.
11. Report: `draftId`, `attachmentId`, `directoryReferenceId`, planning/job identifiers, `localCorpusPath`.

## Forbidden
- Retired `create_task` turns / wizard APIs
- Leaking fixture answer text into prompts
- Exceeding 4 clarification chat turns
- Unbounded `codetask_wait_turn` without `timeoutMs`