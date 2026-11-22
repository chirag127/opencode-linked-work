import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { Parser } from "tar"

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")

export async function compareArchive({ artifact, installedPackage, name, version }) {
  const archivePath = resolve(artifact)
  const installed = resolve(installedPackage)
  const bytes = await readFile(archivePath)
  const archive = await readArchive(bytes)
  const manifest = JSON.parse(archive.get("package.json")?.toString("utf8") ?? "null")
  assert.ok(manifest?.name === name && manifest?.version === version, "Archive package identity differs")
  const expected = [...archive.keys()].sort()
  const actual = await installedFiles(installed)
  assert.deepEqual(actual.sort(), expected, "Installed owned file set differs from archive files")
  const files = []
  for (const path of expected) {
    const original = archive.get(path)
    const content = await readFile(join(installed, path))
    assert.ok(original.equals(content), `Installed bytes differ from archive: ${path}`)
    files.push({ path, size: original.length, sha256: sha(original) })
  }
  assert.equal(sha(await readFile(archivePath)), sha(bytes), "Archive changed during comparison")
  return {
    schemaVersion: 1,
    status: "passed",
    package: { name, version },
    artifact: { path: archivePath, sha256: sha(bytes) },
    installedPackage: installed,
    files,
    method: "installed-tarball-byte-comparison",
  }
}

function readArchive(bytes) {
  return new Promise((resolveEntries, reject) => {
    const files = new Map()
    const seen = new Set()
    const parser = new Parser({ strict: true })
    parser.on("error", reject)
    parser.on("ignoredEntry", () => {
      const error = new Error("Archive contains an ignored or unsupported entry")
      parser.abort(error)
      reject(error)
    })
    parser.on("entry", (entry) => {
      try {
        assert.ok(entry.type === "File" || entry.type === "Directory", "Archive contains a link or unsupported entry")
        // ReadEntry normalizes Windows separators; the header keeps the archive's original path.
        assert.ok(typeof entry.header.path === "string" && !entry.header.path.includes("\\"), "Archive header path contains an invalid separator")
        const full = entry.type === "Directory" ? entry.path.replace(/\/$/, "") : entry.path
        assert.ok(full === "package" || full.startsWith("package/"), "Archive path must start with package/")
        assert.ok(!/[\\\u0000:]/.test(full), "Archive contains an invalid path")
        const parts = full.split("/")
        assert.ok(parts.every((part) => part !== "" && part !== "." && part !== ".."), "Archive contains an unsafe path")
        assert.ok(parts[1] !== "node_modules", "Archive may not bundle root node_modules")
        assert.ok(!seen.has(full), "Archive contains a duplicate path")
        seen.add(full)
        if (entry.type === "Directory") {
          entry.resume()
          return
        }
        assert.ok(parts.length > 1, "Archive package root must be a directory")
        const chunks = []
        entry.on("error", reject)
        entry.on("data", (chunk) => chunks.push(chunk))
        entry.on("end", () => files.set(parts.slice(1).join("/"), Buffer.concat(chunks)))
      } catch (error) {
        parser.abort(error)
        reject(error)
      }
    })
    parser.on("end", () => resolveEntries(files))
    parser.end(bytes)
  })
}

async function installedFiles(root, relative = "") {
  const directory = join(root, relative)
  const info = await lstat(directory)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), "Installed package directory is a link or not a directory")
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (relative === "" && entry.name === "node_modules") continue
    const path = relative ? `${relative}/${entry.name}` : entry.name
    const stat = await lstat(join(root, path))
    assert.ok(!stat.isSymbolicLink(), `Installed owned path is a link: ${path}`)
    if (stat.isDirectory()) files.push(...await installedFiles(root, path))
    else {
      assert.ok(stat.isFile() && stat.nlink === 1, `Installed owned path is a link or not a regular file: ${path}`)
      files.push(path)
    }
  }
  return files
}
