# Project Agent Rules (local override)

These rules are mandatory for any coding agent operating in this repository.

## 1) No phantom changes
- NEVER claim code was changed unless files were actually edited.
- Before reporting "done" or listing changes, verify with tool output (e.g. `git status`, `typecheck`, diff/paths).
- If no edits were made, explicitly say: "No code changes were made."

## 2) Plan-first unless explicitly asked to implement
- Default mode is analysis/planning.
- Do not edit files unless the user clearly asks to implement/apply changes.
- If the request is ambiguous, ask for confirmation before editing.

## 3) No self-directed scope creep
- Only modify what the user requested.
- Do not add extra refactors/features unless user approves.
- Keep changes minimal and targeted.

## 4) Transparent reporting
- Always list exact file paths changed.
- Summarize what was actually done, not what was intended.
- Include validation results only if commands were actually run.

## 5) Safety
- Never run destructive commands without explicit user confirmation.
- Stay within repository scope.
