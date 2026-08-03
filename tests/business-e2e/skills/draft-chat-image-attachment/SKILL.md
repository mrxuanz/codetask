# draft-chat-image-attachment

## Role
Drive Design draft collection so an uploaded image is read and bound onto a confirmable draft. Stop at Draft (no Planner / Job).

## Goal
1. Isolated project + chat conversation with Runtime `conversationCore`.
2. Upload fixture as `attachment.png`.
3. `codetask_start_turn` with fixture message + `attachmentIds` (attachments only on the first turn).
4. Wait with sliced `codetask_wait_turn` (`timeoutMs: 30000`, retry on timeout/fetch failed).
5. **Clarification loop (max 4 turns total = 1 initial + up to 3 follow-ups):**
   - If the assistant asks for more details instead of reading the image / drafting, send a follow-up without new attachments that restates: read the image only, do not invent text, proceed toward a draft when ready.
   - Stop when the reply looks final or a confirmable draft already exists.
6. Poll Design drafts until confirmable / ready — no extra “please propose” model spam beyond the clarify budget.
7. Report artifacts: `draftId` (aka draftMessageId), `attachmentId`, `turnId` / `turnIds`.

Supervisor oracle checks: draft confirmable, references/sourceAttachments include attachmentId, title or summary recognizes the image phrase, SHA-256 matches fixture.

## Forbidden
- Do not paste the image answer into prompts/titles/fileName
- Do not confirm draft / enter Planner / launch Job
- Do not use retired `create_task` thread kinds
- Do not spam soft_request after the image turn
- Do not exceed 4 conversation turns
- Do not re-attach the image on follow-up turns
- Do not call unbounded `codetask_wait_turn` without `timeoutMs`
