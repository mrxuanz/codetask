# draft-chat-image-attachment

## Role
Drive create_task chat so an uploaded image is read and bound onto a confirmable draft. Stop at Draft (no Planner / Job).

## Goal
1. Isolated project + `create_task` thread with Runtime `conversationCore`.
2. Upload fixture as `attachment.png`.
3. One `start_turn` with `attachmentIds` (no nudge spam).
4. Poll drafts until confirmable / ready — no extra “please propose” model messages.
5. Report artifacts: `draftMessageId`, `attachmentId`, `turnId`.

Supervisor oracle checks: draft confirmable, `sourceAttachments` includes attachmentId, title or summary recognizes the image phrase, SHA-256 matches fixture.

## Forbidden
- Do not paste the image answer into prompts/titles/fileName
- Do not confirm draft / enter Planner / launch Job
- Do not spam soft_request after the image turn
