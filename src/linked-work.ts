import { createHash } from "node:crypto"
import { Plugin, Tool } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"

const urlInput = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048))
const sessionInput = Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(256), Schema.isPattern(/^ses/))
const idInput = Schema.String.check(Schema.isPattern(/^lw_[0-9a-f]{64}_[0-9a-f]{64}$/))
const cursorInput = Schema.String.check(Schema.isMaxLength(1024))
const pagination = {
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(25))),
  cursor: Schema.optionalKey(cursorInput),
}

export const schemas = {
  add: Schema.Struct({ url: urlInput, sessionID: Schema.optionalKey(sessionInput) }),
  list: Schema.Struct(pagination),
  find: Schema.Struct({ url: urlInput, ...pagination }),
  remove: Schema.Struct({ id: idInput }),
}
type Operation = keyof typeof schemas
type Invocation = Pick<Tool.Context, "sessionID"> & Partial<Pick<Tool.Context, "agent" | "messageID" | "id">>
const statusSchema = Schema.Literals(["available", "moved", "missing"])
const linkSchema = Schema.Struct({ id: idInput, url: urlInput, sessionID: sessionInput, sessionStatus: statusSchema })
const pageSchema = Schema.Struct({
  links: Schema.Array(linkSchema).check(Schema.isMaxLength(25)),
  nextCursor: Schema.NullOr(cursorInput),
})
export const outputs = {
  add: Schema.Struct({ link: linkSchema }),
  list: pageSchema,
  find: pageSchema,
  remove: Schema.Struct({ id: idInput, removed: Schema.Boolean, sessionStatus: Schema.NullOr(statusSchema) }),
}
type Link = typeof linkSchema.Type
type Output = (typeof outputs)[Operation]["Type"]

const storedSchema = Schema.Struct({
  version: Schema.Literal(1),
  projectID: Schema.String,
  scope: Schema.String,
  url: urlInput,
  sessionID: sessionInput,
})
type Stored = typeof storedSchema.Type
const cursorSchema = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  query: Schema.String,
  after: idInput,
})

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const error = (message: string) => new Tool.Error({ message })

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown, label: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(input),
    catch: () => error(`Invalid ${label}. Check the documented fields, URL, id, cursor and limit.`),
  })
}

function normalizeURL(input: string): string {
  const authority = /^https?:\/\/([^/?#]+)/i.exec(input)?.[1]
  if (!authority || authority.includes("@") || /[\\\u0000-\u0020\u007f\uD800-\uDFFF]/u.test(input) || /%(?![\da-f]{2})/i.test(input)) {
    throw new Error("Expected a full HTTP(S) URL without credentials, whitespace or malformed escapes")
  }
  const url = new URL(input)
  if (!url.hostname || url.username || url.password || Buffer.byteLength(input) > 2048 || Buffer.byteLength(url.href) > 2048) {
    throw new Error("URL is invalid or exceeds 2048 UTF-8 bytes after normalization")
  }
  return url.href
}

function url(input: string) {
  return Effect.try({ try: () => normalizeURL(input), catch: () => error("Invalid URL; use a full HTTP(S) URL without credentials, up to 2048 UTF-8 bytes.") })
}

function missing(value: unknown, sessionID: string) {
  return typeof value === "object" && value !== null && "_tag" in value &&
    (value._tag === "Session.NotFoundError" || value._tag === "SessionNotFoundError") &&
    "sessionID" in value && value.sessionID === sessionID
}

export function parseCommand(text: string) {
  return Effect.gen(function* () {
    if (Buffer.byteLength(text) > 8192) return yield* error("Linked-work command exceeds its text limit")
    const match = /^\s*(add|list|find|remove)(?:\s+([\s\S]*))?\s*$/.exec(text)
    if (!text.trim()) return { name: "list" as const, input: {} }
    if (!match) return yield* error('Usage: /linked-work add|list|find|remove followed by a JSON object')
    const name = match[1] as Operation
    const input: unknown = yield* Effect.try({
      try: () => JSON.parse(match[2]?.trim() || "{}"),
      catch: () => error("Invalid linked-work command JSON"),
    })
    return { name, input }
  })
}

export function createRegistry(ctx: Plugin.Context) {
  const directory = ctx.location.directory
  const projectID = ctx.location.project.id
  const scope = hash(JSON.stringify([projectID, ctx.location.workspaceID ?? null, projectID === "global" ? directory : null]))
  const prefix = `v1/projects/${encodeURIComponent(projectID)}/${scope}/links/`
  const linkID = (record: Pick<Stored, "url" | "sessionID">) => `lw_${hash(record.url)}_${hash(record.sessionID)}`
  const key = (id: string) => `${prefix}${id.slice(3, 67)}/${id.slice(68)}`
  const nativeFailure = (failure: unknown) => failure instanceof Tool.Error
    ? failure
    : new Tool.Error({ message: "Native session lookup failed; linked-work could not verify ownership", error: failure })

  const native = (id: Session.ID) => ctx.session.get({ sessionID: id }).pipe(
    Effect.catch((failure) => missing(failure, id) ? Effect.succeed(undefined) : Effect.fail(failure)),
    Effect.flatMap((value) => value === undefined || value.id === id
      ? Effect.succeed(value)
      : Effect.fail(error("Native session attribution does not match the requested session"))),
    Effect.mapError(nativeFailure),
  )
  const inProject = (target: Session.Info) => target.projectID === projectID &&
    target.location.workspaceID === ctx.location.workspaceID &&
    (projectID !== "global" || target.location.directory === directory)

  const verifyCaller = (invocation: Invocation, original?: Session.Info) => Effect.gen(function* () {
    const caller = yield* native(invocation.sessionID)
    if (!caller) return yield* error("Caller session is missing")
    if (!inProject(caller) || caller.location.directory !== directory) {
      return yield* error("Caller project or location changed; invoke linked-work from the current session location")
    }
    if ((invocation.agent !== undefined && caller.agent !== undefined && invocation.agent !== caller.agent) ||
      (original !== undefined && caller.agent !== original.agent)) {
      return yield* error("Caller agent attribution changed; invoke linked-work again with the current agent")
    }
    return caller
  })

  const permission = (invocation: Invocation, caller: Session.Info, action: string, resources: string[]) => Effect.gen(function* () {
    yield* verifyCaller(invocation, caller)
    yield* ctx.permission.assert({
      sessionID: invocation.sessionID,
      ...(invocation.agent ?? caller.agent ? { agent: invocation.agent ?? caller.agent } : {}),
      ...(invocation.messageID !== undefined && invocation.id !== undefined ? {
        source: { type: "tool" as const, messageID: invocation.messageID, id: invocation.id },
      } : {}),
      action,
      resources,
    })
    yield* verifyCaller(invocation, caller)
  })

  const targetStatus = (id: string, invocation: Invocation, caller: Session.Info) => Effect.gen(function* () {
    const target = yield* native(Session.ID.make(id))
    if (!target) return "missing" as const
    if (!inProject(target)) return "moved" as const
    if (target.location.directory !== directory) {
      yield* permission(invocation, caller, "read", [target.location.directory])
      const current = yield* native(target.id)
      if (!current) return "missing" as const
      if (!inProject(current)) return "moved" as const
      if (current.location.directory !== target.location.directory) return yield* error("Target location changed during its read permission check; retry")
    }
    return "available" as const
  })

  const stored = (input: unknown, storageKey: string) => Effect.gen(function* () {
    const record = yield* decode(storedSchema, input, "stored association")
    const canonical = yield* url(record.url)
    if (record.projectID !== projectID || record.scope !== scope || record.url !== canonical || key(linkID(record)) !== storageKey) {
      return yield* error("Stored association attribution is corrupt; the record was not changed")
    }
    return record
  })

  const show = (record: Stored, invocation: Invocation, caller: Session.Info) => Effect.gen(function* () {
    const sessionStatus = yield* targetStatus(record.sessionID, invocation, caller)
    return { id: linkID(record), url: record.url, sessionID: record.sessionID, sessionStatus }
  })

  const page = (input: typeof schemas.list.Type, canonical: string | undefined, invocation: Invocation, caller: Session.Info) => Effect.gen(function* () {
    const query = canonical === undefined ? "*" : hash(canonical)
    const scanPrefix = canonical === undefined ? prefix : `${prefix}${query}/`
    const cursor = input.cursor === undefined ? undefined : yield* Effect.gen(function* () {
      if (!/^[A-Za-z0-9_-]+$/.test(input.cursor!)) return yield* error("Invalid linked-work cursor")
      const decoded: unknown = yield* Effect.try({
        try: () => JSON.parse(Buffer.from(input.cursor!, "base64url").toString("utf8")),
        catch: () => error("Invalid linked-work cursor"),
      })
      const value = yield* decode(cursorSchema, decoded, "cursor")
      if (value.scope !== scope || value.query !== query || !key(value.after).startsWith(scanPrefix)) {
        return yield* error("Cursor belongs to another project or query")
      }
      return key(value.after)
    })
    const limit = input.limit ?? 10
    const result = yield* ctx.storage.scan({ prefix: scanPrefix, limit, ...(cursor === undefined ? {} : { after: cursor }) })
    if (result.entries.length > limit) return yield* error("Storage returned an oversized association page")
    const links: Link[] = []
    let previous = cursor
    for (const entry of result.entries) {
      if (!entry.key.startsWith(scanPrefix) || (previous !== undefined && entry.key <= previous)) return yield* error("Storage returned an invalid association page")
      const record = yield* stored(entry.value, entry.key)
      if (canonical !== undefined && record.url !== canonical) return yield* error("Stored URL does not match its lookup key")
      links.push(yield* show(record, invocation, caller))
      previous = entry.key
    }
    let nextCursor: string | null = null
    if (result.next !== undefined) {
      if (result.entries.length === 0 || result.next !== previous) return yield* error("Storage returned an invalid continuation cursor")
      const last = links.at(-1)!
      nextCursor = Buffer.from(JSON.stringify({ version: 1, scope, query, after: last.id })).toString("base64url")
    }
    return { links, nextCursor }
  })

  const run = (operation: Operation, raw: unknown, invocation: Invocation): Effect.Effect<Output, Tool.Error> => Effect.gen(function* () {
    const input = yield* decode(schemas[operation], raw, `${operation} input`)
    const canonical = "url" in input ? yield* url(input.url) : undefined
    const caller = yield* verifyCaller(invocation)
    yield* permission(invocation, caller, `linked_work.${operation}`, [canonical ?? ("id" in input ? input.id : `project:${projectID}`)])
    yield* permission(invocation, caller, "read", [directory])
    yield* verifyCaller(invocation, caller)

    if (operation === "add" && "url" in input && canonical !== undefined) {
      const sessionID = yield* decode(sessionInput, "sessionID" in input ? input.sessionID ?? caller.id : caller.id, "target session id")
      const status = yield* targetStatus(sessionID, invocation, caller)
      if (status !== "available") return yield* error(status === "missing" ? "Target session is missing" : "Target session is outside the current project")
      const record: Stored = { version: 1, projectID, scope, url: canonical, sessionID }
      const storageKey = key(linkID(record))
      const existing = yield* ctx.storage.get(storageKey)
      if (existing !== undefined) yield* stored(existing, storageKey)
      yield* verifyCaller(invocation, caller)
      if ((yield* targetStatus(sessionID, invocation, caller)) !== "available") return yield* error("Target project or availability changed; retry")
      yield* verifyCaller(invocation, caller)
      // Identical concurrent adds write identical bytes; no shared index or mutable metadata can be lost.
      if (existing === undefined) yield* ctx.storage.set(storageKey, record)
      const link = yield* show(record, invocation, caller)
      yield* verifyCaller(invocation, caller)
      return { link }
    }

    if (operation === "remove" && "id" in input) {
      const storageKey = key(input.id)
      const existing = yield* ctx.storage.get(storageKey)
      if (existing === undefined) {
        yield* verifyCaller(invocation, caller)
        return { id: input.id, removed: false, sessionStatus: null }
      }
      const record = yield* stored(existing, storageKey)
      const sessionStatus = yield* targetStatus(record.sessionID, invocation, caller)
      yield* verifyCaller(invocation, caller)
      yield* ctx.storage.remove(storageKey)
      yield* verifyCaller(invocation, caller)
      return { id: input.id, removed: true, sessionStatus }
    }

    const result = yield* page({
      ...("limit" in input ? { limit: input.limit } : {}),
      ...("cursor" in input ? { cursor: input.cursor } : {}),
    }, canonical, invocation, caller)
    yield* verifyCaller(invocation, caller)
    return result
  })

  return { run, verifyCaller }
}
