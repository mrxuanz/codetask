# Notes Search Requirements

Build a local notes search utility for the fixed business-e2e workspace.

## Goal

Search notes stored in `fixtures/notes.json` by title and body.

## Constraints

- Do not install third-party dependencies.
- Do not modify `SENTINEL.txt`.
- Keep the implementation in `src/search-notes.mjs`.
- Validate with `node --test` using `test/search-notes.test.mjs`.

## Acceptance criteria

- Searching is case-insensitive.
- Multiple keywords use AND semantics.
- An empty query returns an empty array.
- Each result includes stable `id`, `title`, and match `summary`.
- Final `node --test` passes.
