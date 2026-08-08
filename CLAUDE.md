# Repository Guidelines

## Project Structure & Module Organization

LightInk is a Tauri desktop application. Frontend TypeScript lives in `src/`, organized by feature: `editor/`, `tabs/`, `file/`, `asset/`, `outline/`, `theme/`, `ui/`, and `export/`. Keep frontend tests beside their feature in `__tests__/`. The Rust/Tauri backend is under `src-tauri/`; commands are split across modules in `src-tauri/src/`, while application icons and capability declarations live in `src-tauri/icons/` and `src-tauri/capabilities/`. Performance tooling is in `scripts/`, and requirements are documented in `docs/requirements/`.

## Build, Test, and Development Commands

- `npm install`: install JavaScript dependencies from the lockfile.
- `npm run tauri:dev`: launch the complete desktop app with Vite hot reload.
- `npm run dev`: run only the frontend server on port 1420.
- `npm run build`: run strict TypeScript checking, then create the Vite production bundle.
- `npm test`: run all Vitest suites once; use `npm test -- src/editor` to target a feature.
- `npm run test:watch`: rerun frontend tests during development.
- `cargo test --manifest-path src-tauri/Cargo.toml`: run backend tests.
- `npm run perf:test`: test the Python performance harness; `npm run perf` executes the actual performance gates.
- `npm run tauri:build`: produce platform-specific installers.

## Coding Style & Naming Conventions

Use strict TypeScript and ES modules. Follow existing files: two-space indentation, semicolons, single quotes, and explicit types at public boundaries. Name files and modules in kebab-case (`file-service.ts`), functions and variables in camelCase, and types/classes in PascalCase. Rust code should follow `rustfmt` defaults and snake_case naming. No standalone formatter or linter is configured; `npm run build` is the required static check. Keep feature logic in its owning directory rather than adding broad utility modules.

## Testing Guidelines

Use Vitest with `describe`/`it` and name files `*.test.ts` inside `__tests__/`. Add focused tests for behavior changes and regression cases. Python harness tests use `unittest` and `test_*.py`; Rust tests use standard `#[test]` modules. Before submitting, run the relevant targeted suite, then `npm test` and the Cargo tests for cross-layer changes.

## Commit & Pull Request Guidelines

History generally uses concise, imperative subjects with Conventional Commit prefixes such as `feat(export):`, `fix(perf):`, `docs:`, and `ci:`. Keep commits scoped to one concern. Pull requests should explain the user-visible change, list verification commands, link related requirements or issues, and include screenshots or recordings for UI changes. Call out platform-specific Tauri behavior and any known limitations.
