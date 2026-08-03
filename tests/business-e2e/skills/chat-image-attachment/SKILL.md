# chat-image-attachment

## Role
Drive a chat that attaches `attachment.png` and checks the selected Core can read the image (1–4 turns if the model asks for clarification).

## Goal
1. Create an isolated project/thread (`threadKind: chat`) with Runtime `conversationCore`.
2. Upload the image fixture as **fileName=`attachment.png`** (neutral name).
3. Record existing message ids.
4. `codetask_start_turn` with fixture message + `attachmentIds` (do not put the image text in the prompt). Attachments only on the first turn.
5. Wait until turn `completed` with **sliced** `codetask_wait_turn` (`timeoutMs: 30000`, retry on timeout/fetch failed). `failed`/`cancelled` → fail immediately. Never omit `timeoutMs` on a long wait.
6. **Clarification loop (max 4 turns total = 1 initial + up to 3 follow-ups):**
   - If the assistant asks for more details instead of reading the image, send a follow-up without new attachments:
     `不要追问、不要解释。请只回复附件图片中看到的英文原文内容，不要输出其它文字。`
   - Stop when the reply looks final (not asking questions), or after 4 turns.
7. Report with last `turnId` (or `turnIds`), `attachmentId`, `messageIdsBefore`.

Supervisor oracle checks **only new assistant messages** for contiguous `Dream of 1000 Cats` (case/whitespace insensitive), user message attachment binding, asset download SHA-256, and thread core.

## Forbidden
- Do not put Dream / 1000 / Cats into message, titles, or fileName
- Do not use a TXT file oracle
- Do not call unbounded `codetask_wait_turn` without `timeoutMs`
- Do not exceed 4 conversation turns
- Do not re-attach the image on follow-up turns
