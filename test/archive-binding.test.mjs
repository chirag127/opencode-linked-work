import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cp, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { create, Header } from "tar"
import { compareArchive } from "../scripts/archive-binding.mjs"

async function fixture(t) {
  const root = await mkdtemp(join(process.env.OPENCODE_TEST_TMP ?? tmpdir(), "linked-work-binding-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, "package")
  const installed = join(root, "installed")
  await mkdir(join(source, "dist"), { recursive: true })
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "opencode-linked-work", version: "0.1.0" }))
  await writeFile(join(source, "README.md"), "Synthetic package\n")
  await writeFile(join(source, "dist/index.js"), "export default 17\n")
  const artifact = join(root, "plugin.tgz")
  await create({ cwd: root, file: artifact, gzip: true, portable: true }, ["package"])
  await cp(source, installed, { recursive: true })
  return {
    root, source, installed, artifact,
    compare: () => compareArchive({ artifact, installedPackage: installed, name: "opencode-linked-work", version: "0.1.0" }),
  }
}

test("archive binding compares every archived byte with the installed package", async (t) => {
  const f = await fixture(t)
  await mkdir(join(f.installed, "node_modules", "separate-dependency"), { recursive: true })
  await writeFile(join(f.installed, "node_modules", "separate-dependency", "index.js"), "not a package-owned file")
  const result = await f.compare()
  assert.equal(result.method, "installed-tarball-byte-comparison")
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.status, "passed")
  assert.deepEqual(result.package, { name: "opencode-linked-work", version: "0.1.0" })
  assert.equal(result.installedPackage, f.installed)
  assert.equal(result.artifact.path, f.artifact)
  assert.equal(result.artifact.sha256, createHash("sha256").update(await readFile(f.artifact)).digest("hex"))
  assert.deepEqual(result.files.map((file) => file.path), ["README.md", "dist/index.js", "package.json"])
  const js = result.files.find((file) => file.path === "dist/index.js")
  assert.equal(js.size, 18)
  assert.equal(js.sha256, createHash("sha256").update("export default 17\n").digest("hex"))
})

test("archive binding rejects a same-version installed package with different bytes", async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.installed, "dist/index.js"), "export default 18\n")
  await assert.rejects(f.compare(), /bytes|differ|mismatch/i)
})

test("archive binding rejects both extra and missing owned installed files", async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.installed, "extra.js"), "unexpected")
  await assert.rejects(f.compare(), /files|set|unexpected/i)
  await rm(join(f.installed, "extra.js"))
  await rm(join(f.installed, "README.md"))
  await assert.rejects(f.compare(), /files|set|missing/i)
})

test("archive binding rejects an archive with different package identity", async (t) => {
  const f = await fixture(t)
  await assert.rejects(compareArchive({ artifact: f.artifact, installedPackage: f.installed, name: "other-plugin", version: "0.1.0" }), /identity|name|package/i)
})

test("archive binding rejects duplicate archive paths", async (t) => {
  const f = await fixture(t)
  await create({ cwd: f.root, file: f.artifact, gzip: true, portable: true }, ["package", "package/README.md"])
  await assert.rejects(f.compare(), /duplicate|link/i)
})

test("archive binding rejects archived symbolic links and path traversal without extracting", async (t) => {
  const f = await fixture(t)
  for (const input of [
    { path: "package/alias", type: "SymbolicLink", linkpath: "dist/index.js", size: 0 },
    { path: "package/../outside", type: "File", size: 0 },
  ]) {
    const block = Buffer.alloc(512)
    new Header(input).encode(block)
    await writeFile(f.artifact, Buffer.concat([block, Buffer.alloc(1024)]))
    await assert.rejects(f.compare(), /link|path/i)
  }
})

test("archive binding rejects installed hard links in the owned file set", async (t) => {
  const f = await fixture(t)
  await rm(join(f.installed, "dist/index.js"))
  await link(join(f.source, "dist/index.js"), join(f.installed, "dist/index.js"))
  await assert.rejects(f.compare(), /link/i)
})

async function writeRawArchive(f, extras = [], replacement) {
  const blocks = []
  for (const path of ["package.json", "README.md", "dist/index.js"]) {
    const content = await readFile(join(f.source, path))
    const header = Buffer.alloc(512)
    new Header({ path: path === "dist/index.js" && replacement ? replacement : `package/${path}`, type: "File", size: content.length }).encode(header)
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512))
  }
  for (const input of extras) {
    const header = Buffer.alloc(512)
    new Header(input).encode(header)
    blocks.push(header)
  }
  await writeFile(f.artifact, Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

test("archive binding rejects ignored sparse members alongside otherwise matching package files", async (t) => {
  const f = await fixture(t)
  for (const path of ["package/../outside", "package/README.md"]) {
    await writeRawArchive(f, [{ path, type: "SparseFile", size: 0 }])
    await assert.rejects(f.compare(), /ignored|unsupported|path|duplicate/i)
  }
})

test("archive binding rejects backslashes in header paths before platform normalization", async (t) => {
  const f = await fixture(t)
  await writeRawArchive(f, [], "package/dist\\index.js")
  await assert.rejects(f.compare(), /path|separator/i)
})
