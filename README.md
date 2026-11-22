# opencode-linked-work

Remember issue and review URLs alongside native OpenCode sessions. This is a server plugin for **OpenCode 2.3.2**, using its public Effect plugin API and durable plugin storage.

- Associate a full HTTP(S) URL with the current session or another session in the same native project.
- Find the sessions linked to that exact URL, or browse the project's associations in bounded pages.
- Remove one association without changing the session or the remote issue.
- Use four Code Mode tools or the deterministic `/linked-work` command.

The plugin records URLs as untrusted reference data. It never fetches linked content, contacts issue providers, creates sessions/worktrees, or changes remote tasks.

## Install a built archive

Requirements are OpenCode **2.3.2** and Node **22.19.0 or newer**. This package has no install lifecycle scripts. Use a dedicated local directory to install a built archive:

```sh
mkdir linked-work-plugin
cd linked-work-plugin
npm init -y
npm install --ignore-scripts /path/to/opencode-linked-work-0.1.0.tgz
```

Add the installed **package directory** to the existing `plugins` array in your project or global `opencode.json(c)`. Keep your other plugin entries.

```jsonc
{
  "plugins": [
    "/absolute/path/to/linked-work-plugin/node_modules/opencode-linked-work"
  ]
}
```

Use forward slashes for Windows paths, for example `C:/tools/linked-work-plugin/node_modules/opencode-linked-work`. Do not configure the archive or an individual JavaScript file as the plugin directory. OpenCode reloads plugin configuration without a service restart. Tools are available after the plugin has loaded at the session's location.

To build an archive from this repository:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run test:pack
```

`test:pack` builds the JavaScript and declarations, writes `artifacts/opencode-linked-work-0.1.0.tgz`, installs it into a dedicated consumer with lifecycle scripts disabled, runs the behavioral suite against the installed package, and typechecks an external TypeScript import. It uses the dependency cache populated by `npm ci`. Receipts, public tool schemas and logs are saved in `artifacts/`, or the directory selected by `OPENCODE_LINKED_WORK_EVIDENCE`. The consumer, its archive, `package.json` and `package-lock.json` are retained there so deployment can reuse the exact tested dependency graph.

## Tools

The Code Mode namespace is `linked_work`. Direct tool names are `linked_work_add`, `linked_work_list`, `linked_work_find`, and `linked_work_remove`.

```js
const added = await tools.linked_work.add({
  url: "https://github.example/team/repo/issues/17"
})

const matches = await tools.linked_work.find({
  url: "https://github.example/team/repo/issues/17",
  limit: 10
})

const page = await tools.linked_work.list({ limit: 10 })
if (page.nextCursor !== null) {
  const next = await tools.linked_work.list({
    limit: 10,
    cursor: page.nextCursor
  })
}

await tools.linked_work.remove({ id: added.link.id })
```

| Operation | Input | Result |
| --- | --- | --- |
| `add` | `url`, optional target `sessionID` | `{ link }` |
| `list` | Optional `limit`, `cursor` | `{ links, nextCursor }` |
| `find` | `url`, optional `limit`, `cursor` | `{ links, nextCursor }` |
| `remove` | Association `id` returned by this plugin | `{ id, removed, sessionStatus }` |

Each link contains `id`, normalized `url`, `sessionID`, and `sessionStatus`. The caller, project and location come from the trusted invocation and current native session. Tool input cannot choose a caller or another project's storage.

### Session availability

- `available` means native attribution still places the target in the current project and the required reads were permitted. It does not mean the session is running.
- `moved` means the old association remains, but the session no longer belongs to this scope. The result includes no new project, directory, title or transcript.
- `missing` means native lookup explicitly reported that exact session as missing. Other lookup failures fail the operation instead of being treated as absence.

Adding requires an available target. Existing moved/missing associations remain visible in their original scope until explicitly removed. The destination project does not inherit them. `remove` returns `removed:false` and `sessionStatus:null` when the association is already absent. Storage failures and permission rejections are reported as failures.

### URL identity

Normalization uses WHATWG `URL.href`: scheme/host case, international hostnames, default ports and dot segments follow the URL standard. Path case, nondefault ports, trailing slashes, query order/repeated parameters, fragments and empty `?`/`#` delimiters remain significant. Links on different hosts never collapse just because their issue numbers match.

Only absolute `http://` and `https://` URLs are accepted. Credentials, raw whitespace/control characters, backslashes, malformed percent escapes and lone Unicode surrogates are rejected. Input and normalized output are limited to 2,048 UTF-8 bytes. Provider-specific redirects, aliases and equivalences are not inferred.

### Pagination and persistence

Pages contain at most 25 associations; the default is 10. Follow `nextCursor` with the same operation and, for `find`, the same normalized URL. A `null` cursor means that scan reached its end. Ordering follows stable storage keys, not creation time. Pages are not snapshots: concurrent additions/removals may require a fresh scan.

Associations are independent immutable records in `ctx.storage`, partitioned by native project identity. Repeating the same URL/session addition produces the same record. Projects using the native `global` fallback receive an additional exact-directory partition. Same-project worktrees share links; another server has its own plugin storage. The plugin does not migrate records when a native project identity changes.

There is no transaction spanning native session ownership and plugin storage. Ownership is checked around permission waits and storage operations; a change can still race an operation. An ambiguous result is reconciled with `find` or `list`, not interpreted as a guaranteed rollback. Concurrent operations on the same association follow their individual storage writes; unrelated keys are preserved.

## Deterministic command

`/linked-work` takes an operation followed by a JSON object. Omit the operation to list the first page.

```text
/linked-work
/linked-work add {"url":"https://github.example/team/repo/issues/17"}
/linked-work add {"url":"https://gitlab.example/team/repo/-/merge_requests/8","sessionID":"ses_target"}
/linked-work find {"url":"https://github.example/team/repo/issues/17","limit":5}
/linked-work list {"limit":5,"cursor":"<nextCursor>"}
/linked-work remove {"id":"<association-id>"}
```

The command calls the same registry directly and admits a synthetic JSON receipt to the invoking session with `resume:false`. It does not start model work. An idle session may leave that receipt pending until its next normal wake. A receipt-admission failure does not undo an already completed association write. Command input is limited to 8,192 UTF-8 bytes.

## Permissions

The plugin preserves OpenCode's native permission errors, plain rejection and interruption. Every operation checks its semantic action plus `read` for the caller's directory and any other in-scope target directory it needs.

| Semantic action | Resource |
| --- | --- |
| `linked_work.add` | Normalized URL |
| `linked_work.list` | `project:<native project ID>` |
| `linked_work.find` | Normalized URL |
| `linked_work.remove` | Association ID |

Tool-origin requests carry the native tool call/message identity. Commands use their native invoking session without pretending to be a model tool call. This package adds no global permission rules.

## Verification boundaries

`npm run check` typechecks, builds and tests the registered plugin with native schemas, Effect error semantics and a temporary persistent SQLite implementation of the public storage boundary. `npm run test:pack` repeats behavior through a separately installed archive and verifies emitted declarations. Native OpenCode-host acceptance is a separate integration check; these package tests do not certify every host release or the exact minimum Node runtime.

<footer class="hire-me">
  <h3>Hire me</h3>
  <p>Chirag Singhal — building free, open APIs and tools.</p>
  <p>
    <a href="mailto:chirag@oriz.in">chirag@oriz.in</a> ·
    <a href="https://github.com/chirag127">GitHub</a> ·
    <a href="https://www.linkedin.com/in/chirag127/">LinkedIn</a> ·
    <a href="https://x.com/singhal127">X</a> ·
    <a href="https://www.youtube.com/@ChiragSinghal127">YouTube</a> ·
    <a href="https://www.instagram.com/chiragsinghal127/">Instagram</a> ·
    <a href="https://www.reddit.com/user/Far_Macaron_9910/">Reddit</a> ·
    <a href="https://buymeacoffee.com/chirag127">Buy me a coffee</a>
  </p>
</footer>
