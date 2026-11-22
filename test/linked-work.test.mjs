import assert from "node:assert/strict"
import { test } from "node:test"
import { Cause, Effect, Exit } from "effect"
import { fixture, host, session, Tool } from "./host.mjs"

const { default: plugin } = await import(process.env.LINKED_WORK_PACKAGE ?? "../dist/index.js")

test("registered tools preserve a URL association across plugin and storage reopen", async (t) => {
  const disk = await fixture()
  const instances = []
  t.after(async () => {
    for (const instance of instances) await instance.close()
    await disk.close()
  })
  const first = await host(plugin, { database: disk.database })
  instances.push(first)
  const added = await first.call("add", { url: "HTTPS://Example.COM:443/team/issues/17", sessionID: "ses_target" })
  assert.equal(added.link.url, "https://example.com/team/issues/17")
  assert.equal(added.link.sessionID, "ses_target")
  await first.close()
  const reopened = await host(plugin, { database: disk.database })
  instances.push(reopened)
  const found = await reopened.call("find", { url: "https://example.com/team/issues/17" })
  assert.equal(found.links.length, 1)
  assert.equal(found.links[0].id, added.link.id)
  assert.equal(found.links[0].sessionStatus, "available")
  assert.equal(found.nextCursor, null)
})

test("different hosts with the same issue number remain independent", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  await h.call("add", { url: "https://github.example/team/repo/issues/17" })
  await h.call("add", { url: "https://gitlab.example/team/repo/issues/17" })
  const page = await h.call("find", { url: "https://github.example/team/repo/issues/17" })
  assert.deepEqual(page.links.map((link) => link.url), ["https://github.example/team/repo/issues/17"])
  assert.equal((await h.call("list", {})).links.length, 2)
})

test("duplicate and concurrent adds preserve independent immutable associations", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  const input = { url: "https://example.test/issues/7" }
  const first = await h.call("add", input)
  const again = await h.call("add", { url: "https://EXAMPLE.test:443/issues/7" })
  assert.deepEqual(again, first)
  await Promise.all(Array.from({ length: 6 }, () => h.call("add", input)))
  await Promise.all([
    h.call("add", { url: input.url, sessionID: "ses_target" }),
    h.call("add", { url: "https://example.test/issues/8" }),
  ])
  const linked = await h.call("find", input)
  assert.deepEqual(linked.links.map((link) => link.sessionID).sort(), ["ses_caller", "ses_target"])
  assert.equal((await h.call("list", {})).links.length, 3)
  assert.equal(h.entries().length, 3)
})

test("URL normalization preserves path case, query order, fragments and empty delimiters", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  const urls = [
    "https://example.test/issues/7", "https://example.test/Issues/7",
    "http://example.test/issues/7", "https://example.test:8443/issues/7",
    "https://example.test/issues/7/", "https://example.test/issues/7?",
    "https://example.test/issues/7#", "https://example.test/issues/7#note-1",
    "https://example.test/issues/7#note-2", "https://example.test/issues/7?a=1&b=2",
    "https://example.test/issues/7?b=2&a=1", "https://example.test/issues/7?x=1&x=2",
    "https://example.test/issues/7?x=2&x=1", "https://example.test/issues/%37",
  ]
  for (const url of urls) await h.call("add", { url })
  for (const url of urls) {
    const page = await h.call("find", { url })
    assert.deepEqual(page.links.map((link) => link.url), [url])
  }
  assert.equal(h.entries().length, urls.length)
  const unicode = await h.call("add", { url: "https://bücher.example/路径/../问题/7" })
  assert.equal(unicode.link.url, "https://xn--bcher-kva.example/%E9%97%AE%E9%A2%98/7")
})

test("malformed, credential-bearing and over-budget URLs never reach storage", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  for (const url of [
    "issues/7", "//example.test/issues/7", "https:example.test/issues/7",
    "https:///example.test/issues/7", "https://", "file:///tmp/7", "ftp://example.test/7",
    "https://name:secret@example.test/7", "https://@example.test/7",
    "https://example.test/with space", " https://example.test/7", "https://example.test/7\n",
    "https://example.test\\evil/7", "https://example.test/%xx", "https://example.test/%",
    "https://example.test/\ud800", "https://example.test/" + "x".repeat(2048),
  ]) await assert.rejects(async () => h.call("add", { url }), /URL|url|length/i)
  assert.equal(h.state.writes, 0)
  assert.equal(h.entries().length, 0)
})

test("removing one association leaves other sessions and unrelated storage unchanged", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  h.put("another-plugin/value", { keep: true })
  const a = await h.call("add", { url: "https://example.test/1" })
  const b = await h.call("add", { url: "https://example.test/1", sessionID: "ses_target" })
  const c = await h.call("add", { url: "https://example.test/2" })
  const removed = await h.call("remove", { id: a.link.id })
  assert.equal(removed.removed, true)
  assert.equal((await h.call("remove", { id: a.link.id })).removed, false)
  assert.deepEqual((await h.call("list", {})).links.map((link) => link.id).sort(), [b.link.id, c.link.id].sort())
  assert.deepEqual(JSON.parse(h.entries().find((row) => row.key === "another-plugin/value").value), { keep: true })
})

test("current project scope cannot be selected or crossed through tool input or a cursor", async (t) => {
  const disk = await fixture()
  const instances = []
  t.after(async () => {
    for (const instance of instances) await instance.close()
    await disk.close()
  })
  const a = await host(plugin, { database: disk.database })
  instances.push(a)
  await a.call("add", { url: "https://example.test/1" })
  await a.call("add", { url: "https://example.test/2" })
  const firstPage = await a.call("list", { limit: 1 })
  assert.equal(typeof firstPage.nextCursor, "string")
  const b = await host(plugin, {
    database: disk.database, projectID: "project-b", directory: "/projects/b",
    sessions: new Map([["ses_caller", session("ses_caller", "project-b", "/projects/b")]]),
  })
  instances.push(b)
  assert.deepEqual((await b.call("list", {})).links, [])
  await assert.rejects(b.call("list", { cursor: firstPage.nextCursor }), /cursor/i)
  assert.equal((await b.call("remove", { id: firstPage.links[0].id })).removed, false)
  for (const input of [{ projectID: "project-a" }, { callerSessionID: "ses_target" }, { directory: "/projects/a" }]) {
    assert.throws(() => b.execute("list", input), /unexpected|property/i)
  }
  assert.equal((await a.call("list", {})).links.length, 2)
})

test("pagination visits each association once and binds continuation to the search", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  for (let index = 0; index < 31; index++) await h.call("add", { url: `https://example.test/issue/${index}` })
  const found = []
  let cursor
  for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
    const page = await h.call("list", { limit: 3, ...(cursor ? { cursor } : {}) })
    assert.ok(page.links.length <= 3)
    found.push(...page.links.map((link) => link.url))
    cursor = page.nextCursor
    if (!cursor) break
  }
  assert.equal(cursor, null)
  assert.equal(found.length, 31)
  assert.equal(new Set(found).size, 31)
  assert.deepEqual([...found].sort(), Array.from({ length: 31 }, (_, index) => `https://example.test/issue/${index}`).sort())
  const url = "https://example.test/issue/0"
  await h.call("add", { url, sessionID: "ses_target" })
  const page = await h.call("find", { url, limit: 1 })
  assert.equal(typeof page.nextCursor, "string")
  await assert.rejects(h.call("list", { cursor: page.nextCursor }), /cursor/i)
  await assert.rejects(h.call("find", { url: "https://example.test/issue/1", cursor: page.nextCursor }), /cursor/i)
  const next = await h.call("find", { url, limit: 1, cursor: page.nextCursor })
  assert.equal(next.links.length, 1)
  assert.notEqual(page.links[0].id, next.links[0].id)
  assert.equal(next.nextCursor, null)
})

test("bad cursors and page budgets cannot cause unbounded scans", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  for (const input of [{ limit: 0 }, { limit: 26 }, { limit: 1.1 }, { cursor: "bad!cursor" }, { cursor: "a".repeat(4096) }]) {
    await assert.rejects(async () => h.call("list", input), /cursor|limit|between|greater|less|integer|length/i)
  }
  assert.equal(h.state.scans, 0)
})

test("semantic permission denials preserve the native error and prevent storage mutation", async (t) => {
  const denial = new Tool.Error({ message: "native semantic deny" })
  const h = await host(plugin, {
    permission: (input) => input.action === "linked_work.add" ? Effect.fail(denial) : Effect.void,
  })
  t.after(() => h.close())
  const exit = await Effect.runPromiseExit(h.execute("add", { url: "https://example.test/1" }))
  assert.ok(Exit.isFailure(exit))
  assert.strictEqual(Cause.findErrorOption(exit.cause).value, denial)
  assert.equal(h.state.writes, 0)
  const request = h.permissions.find((item) => item.action === "linked_work.add")
  assert.deepEqual(request.source, { type: "tool", messageID: "msg_call", id: "call_link" })
  assert.equal(request.sessionID, "ses_caller")
  assert.equal(request.agent, "general")
})

test("read permission denial and plain rejection are never returned as a successful empty page", async (t) => {
  const rejection = { reason: "native plain rejection" }
  const h = await host(plugin, {
    permission: (input) => input.action === "read" ? Effect.die(rejection) : Effect.void,
  })
  t.after(() => h.close())
  const exit = await Effect.runPromiseExit(h.execute("list", {}))
  assert.ok(Exit.isFailure(exit))
  assert.strictEqual(exit.cause.reasons.find(Cause.isDieReason)?.defect, rejection)
  assert.equal(h.state.reads, 0)
  assert.equal(h.state.scans, 0)
})

test("native caller identity, selected agent and location must still match the invocation", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  for (const bad of [
    session("ses_caller", "project-b", "/projects/b"),
    session("ses_caller", "project-a", "/projects/another"),
    { ...session("ses_caller"), agent: "different-agent" },
    { ...session("ses_caller"), id: "ses_impostor" },
  ]) {
    h.sessions.set("ses_caller", bad)
    await assert.rejects(h.call("add", { url: "https://example.test/1" }), /caller|attribution|agent|location|project/i)
  }
  assert.equal(h.state.writes, 0)
})

test("an approved call rechecks ownership after the permission wait", async (t) => {
  const h = await host(plugin, {
    permission: (input, sessions) => {
      if (input.action === "read") sessions.set("ses_caller", session("ses_caller", "project-b", "/projects/b"))
      return Effect.void
    },
  })
  t.after(() => h.close())
  await assert.rejects(h.call("add", { url: "https://example.test/1" }), /caller|location|project/i)
  assert.equal(h.state.writes, 0)
})

test("foreign targets are rejected and moves or deletion retain only the old project's stale association", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  const linked = await h.call("add", { url: "https://example.test/1", sessionID: "ses_target" })
  h.sessions.set("ses_target", { ...session("ses_target", "project-b", "/private/elsewhere"), title: "PRIVATE TITLE" })
  const moved = await h.call("list", {})
  assert.equal(moved.links[0].sessionStatus, "moved")
  assert.ok(!JSON.stringify(moved).includes("PRIVATE"))
  assert.ok(!JSON.stringify(moved).includes("/private"))
  await assert.rejects(h.call("add", { url: "https://example.test/2", sessionID: "ses_target" }), /project|target/i)
  h.sessions.delete("ses_target")
  const missing = await h.call("list", {})
  assert.equal(missing.links[0].sessionStatus, "missing")
  await assert.rejects(h.call("add", { url: "https://example.test/2", sessionID: "ses_target" }), /missing|not found|exist/i)
  const removed = await h.call("remove", { id: linked.link.id })
  assert.equal(removed.removed, true)
  assert.equal(removed.sessionStatus, "missing")
})

test("inaccessible targets and storage faults fail explicitly instead of inventing absence", async (t) => {
  let inaccessible = false
  let fault
  const denial = new Tool.Error({ message: "native target inaccessible" })
  const h = await host(plugin, {
    sessionError: (id) => inaccessible && id === "ses_target" ? denial : undefined,
    storageError: (method) => { if (method === fault) throw new Error(`storage ${method} unavailable`) },
  })
  t.after(() => h.close())
  const linked = await h.call("add", { url: "https://example.test/1", sessionID: "ses_target" })
  inaccessible = true
  await assert.rejects(h.call("list", {}), /native target inaccessible/)
  await assert.rejects(h.call("remove", { id: linked.link.id }), /native target inaccessible/)
  assert.equal(h.entries().length, 1)
  inaccessible = false
  fault = "scan"
  await assert.rejects(h.call("list", {}), /storage scan unavailable/)
  fault = "remove"
  await assert.rejects(h.call("remove", { id: linked.link.id }), /storage remove unavailable/)
  fault = "set"
  await assert.rejects(h.call("add", { url: "https://example.test/2" }), /storage set unavailable/)
  assert.equal(h.entries().length, 1)
})

test("corrupt stored attribution is reported and never overwritten by a duplicate add", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  await h.call("add", { url: "https://example.test/1" })
  const row = h.entries()[0]
  h.put(row.key, { ...JSON.parse(row.value), projectID: "project-b" })
  await assert.rejects(h.call("list", {}), /stored|corrupt|attribution/i)
  await assert.rejects(h.call("add", { url: "https://example.test/1" }), /stored|corrupt|attribution/i)
  assert.equal(JSON.parse(h.entries()[0].value).projectID, "project-b")
})

test("global native project IDs stay isolated by their exact local directory", async (t) => {
  const disk = await fixture()
  const instances = []
  t.after(async () => {
    for (const instance of instances) await instance.close()
    await disk.close()
  })
  const a = await host(plugin, {
    database: disk.database, projectID: "global", directory: "/folders/a",
    sessions: new Map([["ses_caller", session("ses_caller", "global", "/folders/a")]]),
  })
  instances.push(a)
  await a.call("add", { url: "https://example.test/1" })
  const b = await host(plugin, {
    database: disk.database, projectID: "global", directory: "/folders/b",
    sessions: new Map([
      ["ses_caller", session("ses_caller", "global", "/folders/b")],
      ["ses_target", session("ses_target", "global", "/folders/a")],
    ]),
  })
  instances.push(b)
  assert.deepEqual((await b.call("list", {})).links, [])
  await assert.rejects(b.call("add", { url: "https://example.test/2", sessionID: "ses_target" }), /project|target/i)
})

test("the slash command uses the same registry without a model and admits an explicit receipt", async (t) => {
  const h = await host(plugin)
  t.after(() => h.close())
  await h.command('add {"url":"https://example.test/1","sessionID":"ses_target"}')
  assert.equal((await h.call("find", { url: "https://example.test/1" })).links[0].sessionID, "ses_target")
  assert.equal(h.state.synthetic.length, 1)
  assert.equal(h.state.synthetic[0].sessionID, "ses_caller")
  assert.equal(h.state.synthetic[0].resume, false)
  assert.equal(h.state.synthetic[0].delivery, "queue")
  assert.match(h.state.synthetic[0].text, /https:\/\/example.test\/1/)
  assert.ok(h.permissions.some((request) => request.action === "linked_work.add" && request.source === undefined))
  await h.command("list")
  assert.equal(h.state.synthetic.length, 2)
  await assert.rejects(h.command('add {"url":"https://example.test/2","callerSessionID":"ses_target"}'), /invalid|unexpected|property/i)
  await assert.rejects(h.command("run arbitrary"), /command|usage/i)
  assert.equal(h.entries().length, 1)
})

test("a command cannot keep an earlier agent's permission after that agent changes", async (t) => {
  const h = await host(plugin, {
    permission: (input, sessions) => {
      if (input.action === "read") {
        sessions.set("ses_caller", { ...sessions.get("ses_caller"), agent: "restricted" })
      }
      return Effect.void
    },
  })
  t.after(() => h.close())
  await assert.rejects(h.command('add {"url":"https://example.test/agent-change"}'), /agent|caller/i)
  assert.equal(h.entries().length, 0)
  assert.equal(h.state.synthetic.length, 0)
})

test("a caller moved during the final target permission wait cannot write its former project's association", async (t) => {
  let checks = 0
  const h = await host(plugin, {
    permission: (input, sessions) => {
      if (input.action === "read" && input.resources.includes("/worktrees/a")) {
        checks++
        if (checks === 2) sessions.set("ses_caller", session("ses_caller", "project-b", "/projects/b"))
      }
      return Effect.void
    },
  })
  t.after(() => h.close())
  h.sessions.set("ses_target", session("ses_target", "project-a", "/worktrees/a"))
  await assert.rejects(h.call("add", { url: "https://example.test/last-wait", sessionID: "ses_target" }), /caller|project|location/i)
  assert.equal(h.entries().length, 0)
})
