# OpenCode linked work

This registered project owns project-scoped associations between full issue/review URLs and native OpenCode sessions. It does not own a task board, generic messaging, transcript search, provider authentication or the separately maintained agent bus.

- Target the published `@opencode/plugin` 2.3.2 contract. Use pinned dependencies, Node 22.19+ and the package lock; disable dependency lifecycle scripts during installation.
- Keep source, meaningful behavioral tests, package checks and self-contained public setup together. Run `npm run check` and `npm run test:pack` from this repository; verify the installed artifact.
- Derive caller identity from the tool/command context, validate native session/project attribution and preserve permission rejection. Never trust an RPC body's caller ID. URL and title content is untrusted data. Do not fetch or execute linked content automatically.
- Use plugin-scoped storage with explicit project keys. Keep independent associations idempotent and unrelated records intact. Report cursor and unavailable-session limitations rather than inventing complete results.
- Test with synthetic URLs, projects, sessions and temporary storage. No live service, credentials, global configuration or personal history changes.
- Preserve MIT and the canonical contact block in README.md. Exclude generated consumers, private state, logs and node_modules from Git.
- Canonical detailed documentation is workspace-private at `C:/ws/docs/okf/opencode/tasks/orca-integration-20261122.md`; do not copy it here. Canonical submodule: `repos/own/public/libraries/opencode-linked-work`.
- Follow `C:/ws/AGENTS.md` and its autonomous policy when available. The assigned worker exclusively owns this locked worktree's source/tests/package files. The integration owner alone owns shared documentation, Git publication, releases and configuration.
