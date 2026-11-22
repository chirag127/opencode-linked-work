import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent, Location, Tool } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect, Schema, Scope } from "effect"

export function session(id, projectID = "project-a", directory = "/projects/a") {
  return Schema.decodeUnknownSync(Session.Info)({
    id, projectID, agent: "general", location: { directory },
    title: "Synthetic session", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  })
}

export async function fixture() {
  const directory = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), "linked-work-"))
  const database = join(directory, "storage.sqlite")
  return {
    directory, database,
    close: () => rm(directory, { recursive: true, force: true }),
  }
}

export async function host(plugin, options = {}) {
  const db = new DatabaseSync(options.database ?? ":memory:")
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  const scope = await Effect.runPromise(Scope.make())
  const tools = new Map()
  const commands = new Map()
  const sessions = options.sessions ?? new Map([
    ["ses_caller", session("ses_caller")],
    ["ses_target", session("ses_target")],
  ])
  const records = []
  const permissions = []
  const state = { reads: 0, writes: 0, scans: 0, synthetic: [] }
  let closed = false
  const location = Schema.decodeUnknownSync(Location.Info)({
    directory: options.directory ?? "/projects/a",
    project: {
      id: options.projectID ?? "project-a",
      directory: options.canonical ?? options.directory ?? "/projects/a",
      canonical: options.canonical ?? options.directory ?? "/projects/a",
    },
  })
  const context = {
    app: { name: "OpenCode", version: "2.3.2", channel: "stable" },
    options: {}, location,
    tool: {
      transform: (callback) => Effect.sync(() => {
        callback({
          namespace() {},
          add(definition) {
            const id = `${definition.options.namespace}_${definition.name}`
            assert.ok(!tools.has(id), `duplicate tool ${id}`)
            tools.set(id, definition)
          },
        })
        return { dispose: Effect.sync(() => tools.clear()) }
      }),
    },
    command: {
      transform: (callback) => Effect.sync(() => {
        callback({ add: (definition) => commands.set(definition.name, definition) })
        return { dispose: Effect.sync(() => commands.clear()) }
      }),
    },
    agent: {
      get: ({ agentID }) => Effect.succeed({ location, data: Agent.Info.default(Agent.ID.make(agentID)) }),
    },
    session: {
      get: ({ sessionID }) => Effect.suspend(() => {
        options.beforeSessionGet?.(sessionID, sessions)
        const error = options.sessionError?.(sessionID)
        if (error) return Effect.fail(error)
        const value = sessions.get(sessionID)
        return value
          ? Effect.succeed(value)
          : Effect.fail({ _tag: "Session.NotFoundError", sessionID })
      }),
      synthetic: (input) => Effect.sync(() => {
        state.synthetic.push(input)
        return { id: input.id ?? "msg_command_result", sessionID: input.sessionID, type: "synthetic" }
      }),
    },
    permission: {
      assert: (input) => Effect.suspend(() => {
        permissions.push(input)
        const result = options.permission?.(input, sessions)
        return result ?? Effect.void
      }),
    },
    storage: {
      get: (key) => Effect.sync(() => {
        state.reads++
        options.storageError?.("get", key)
        const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key)
        return row ? JSON.parse(row.value) : undefined
      }),
      set: (key, value) => Effect.sync(() => {
        options.storageError?.("set", key)
        state.writes++
        db.prepare("INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(key, JSON.stringify(value))
        records.push({ key, value })
      }),
      remove: (key) => Effect.sync(() => {
        options.storageError?.("remove", key)
        state.writes++
        db.prepare("DELETE FROM kv WHERE key = ?").run(key)
      }),
      scan: ({ prefix, after, limit }) => Effect.sync(() => {
        state.scans++
        options.storageError?.("scan", prefix)
        assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 25)
        const rows = db.prepare("SELECT key, value FROM kv WHERE substr(key,1,length(?)) = ? AND key > ? ORDER BY key LIMIT ?")
          .all(prefix, prefix, after ?? "", limit + 1)
        const entries = rows.slice(0, limit).map((row) => ({ key: row.key, value: JSON.parse(row.value) }))
        return { entries, ...(rows.length > limit ? { next: entries.at(-1).key } : {}) }
      }),
    },
  }
  await Effect.runPromise(Effect.provideService(plugin.effect(context), Scope.Scope, scope))
  function tool(name) {
    const definition = tools.get(`linked_work_${name}`)
    assert.ok(definition, `Expected registered linked_work_${name}; got ${[...tools.keys()].join(", ")}`)
    return definition
  }
  const invocation = {
    sessionID: "ses_caller", agent: "general", messageID: "msg_call", id: "call_link",
    progress: () => Effect.void,
  }
  return {
    tools, commands, sessions, state, permissions, records, context, invocation,
    execute(name, input, caller = invocation) {
      const definition = tool(name)
      const decoded = Schema.decodeUnknownSync(definition.input, { onExcessProperty: "error" })(input)
      return Effect.flatMap(definition.execute(decoded, caller), (result) => Effect.sync(() => {
        if (definition.output) Schema.encodeSync(definition.output)(result.output)
        return result.output
      }))
    },
    call(name, input, caller = invocation) { return Effect.runPromise(this.execute(name, input, caller)) },
    command(text, sessionID = "ses_caller") {
      const command = commands.get("linked-work")
      assert.ok(command, "Expected registered /linked-work")
      return Effect.runPromise(command.execute({ sessionID, prompt: { text }, delivery: "queue" }))
    },
    entries() { return db.prepare("SELECT key,value FROM kv ORDER BY key").all() },
    put(key, value) { db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(key, JSON.stringify(value)) },
    async close() {
      if (closed) return
      closed = true
      await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined }))
      db.close()
    },
  }
}

export { Tool }
