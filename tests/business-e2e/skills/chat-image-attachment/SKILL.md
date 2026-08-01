# chat-image-attachment

## Role
Drive a single chat turn that attaches `attachment.png` and checks the selected Core can read the image.

## Goal
1. Create an isolated project/thread (`threadKind: chat`) with Runtime `conversationCore`.
2. Upload the image fixture as **fileName=`attachment.png`** (neutral name).
3. Record existing message ids.
4. `codetask_start_turn` with fixture message + `attachmentIds` (do not put the image text in the prompt).
5. Wait until turn `completed` (`failed`/`cancelled` → fail immediately).
6. Report with `turnId`, `attachmentId`, `messageIdsBefore`.

Supervisor oracle checks **only new assistant messages** for contiguous `Dream of 1000 Cats` (case/whitespace insensitive), user message attachment binding, asset download SHA-256, and thread core.

## Forbidden
- Do not put Dream / 1000 / Cats into message, titles, or fileName
- Do not use a TXT file oracle
