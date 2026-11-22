import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import semver from "semver"
import { compareArchive } from "./archive-binding.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const evidence = resolve(process.env.OPENCODE_LINKED_WORK_EVIDENCE ?? join(root, "artifacts"))
const artifacts = join(root, "artifacts")
const npm = process.env.npm_execpath
assert.ok(npm, "Run this check with npm run test:pack")
await mkdir(evidence, { recursive: true })
await mkdir(artifacts, { recursive: true })
const runEvidence = await mkdtemp(join(evidence, "pack-"))

const commands = []
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const sources = [
  "package.json", "package-lock.json", "tsconfig.json", ".gitignore", "LICENSE", "README.md", "AGENTS.md", "CLAUDE.md",
  "src/index.ts", "src/linked-work.ts", "test/host.mjs", "test/linked-work.test.mjs", "scripts/test-pack.mjs",
  "scripts/archive-binding.mjs", "test/archive-binding.test.mjs",
]
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async (path) => [path, sha(await readFile(join(root, path)))])))
const initial = await hashes()
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
const receipt = { status: "running", started: new Date().toISOString(), node: process.version, sourceHashes: initial, commands }
let consumer

function run(label, args, cwd = root, env = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: { ...process.env, npm_config_ignore_scripts: "true", ...env },
    encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
  })
  commands.push({ label, command: [process.execPath, ...args], cwd, exitCode: result.status, signal: result.signal })
  return { ...result, label }
}

async function checked(label, args, cwd, env) {
  const result = run(label, args, cwd, env)
  await writeFile(join(runEvidence, `pack-${label}.log`), `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}\n` : ""}`)
  assert.equal(result.status, 0, `${label} failed; see pack-${label}.log`)
  return result.stdout
}

try {
  const args = process.argv.slice(2)
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--resume"), "Usage: npm run test:pack [-- --resume <result.json>]")
  const previousBytes = args.length === 0 ? undefined : await readFile(resolve(args[1]))
  const previous = previousBytes === undefined ? undefined : JSON.parse(previousBytes)
  const inheritedBytes = previous?.reused ? await readFile(previous.reused.path) : undefined
  if (inheritedBytes) assert.equal(sha(inheritedBytes), previous.reused.sha256, "Inherited verification receipt changed")
  const inherited = inheritedBytes === undefined ? undefined : JSON.parse(inheritedBytes)
  const paths = ["LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "dist/linked-work.d.ts", "dist/linked-work.js", "package.json"].sort()
  const filename = `${manifest.name}-${manifest.version}.tgz`
  if (previous) {
    assert.equal(previous.status, "failed", "Only a completed failed verification can be resumed")
    assert.equal(previous.node, process.version, "Node changed since the retained checks")
    const verificationFiles = ["scripts/test-pack.mjs", "scripts/archive-binding.mjs", "test/archive-binding.test.mjs"]
    for (const [path, hash] of Object.entries(initial)) {
      // Only verification code may change when reusing a tested archive and its installed registry suite.
      if (!verificationFiles.includes(path)) assert.equal(hash, previous.sourceHashes[path], `Source changed since retained checks: ${path}`)
    }
    for (const label of ["build", "archive", "install", "behavior"]) {
      assert.ok([previous, inherited].some((record) => record?.commands.some((command) => command.label === label && command.exitCode === 0)), `No completed ${label} evidence to resume`)
    }
    if (inherited) {
      assert.deepEqual(previous.artifact, inherited.artifact, "Inherited archive identity differs")
      assert.deepEqual(previous.consumer, inherited.consumer, "Inherited installed consumer differs")
      for (const path of Object.keys(initial)) {
        if (!verificationFiles.includes(path)) assert.equal(previous.sourceHashes[path], inherited.sourceHashes[path], `Inherited product input differs: ${path}`)
      }
    }
    consumer = previous.consumer.path
    assert.equal(previous.consumer.retained, true)
    for (const name of ["manifest", "lockfile"]) {
      assert.equal(sha(await readFile(previous.consumer[name].path)), previous.consumer[name].sha256, `Retained consumer ${name} changed`)
    }
    for (const name of ["host.mjs", "linked-work.test.mjs"]) {
      assert.equal(sha(await readFile(join(consumer, "test", name))), initial[`test/${name}`], `Retained consumer test changed: ${name}`)
    }
    receipt.artifact = previous.artifact
    receipt.consumer = previous.consumer
    receipt.reused = {
      path: resolve(args[1]), sha256: sha(previousBytes), checks: ["build", "archive", "install", "behavior"],
      changedVerificationFiles: verificationFiles.filter((path) => initial[path] !== previous.sourceHashes[path]),
    }
  } else {
    await checked("build", [npm, "run", "build"])
    const packOutput = JSON.parse(await checked("archive", [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", artifacts]))
    // npm 12 keys pack results by package name; earlier npm versions return an array.
    const packages = Array.isArray(packOutput) ? packOutput : Object.values(packOutput)
    assert.equal(packages.length, 1, "Expected exactly one packed package")
    const packed = packages[0]
    assert.equal(packed.name, manifest.name)
    assert.equal(packed.version, manifest.version)
    assert.equal(packed.filename, filename)
    assert.deepEqual(packed.files.map((file) => file.path).sort(), paths)
    const archive = join(artifacts, filename)
    const archiveBytes = await readFile(archive)
    const archiveHash = sha(archiveBytes)
    const retainedArchive = join(evidence, `${manifest.name}-${manifest.version}-${archiveHash.slice(0, 16)}.tgz`)
    if (retainedArchive !== archive) await copyFile(archive, retainedArchive)
    receipt.artifact = { path: archive, retainedPath: retainedArchive, bytes: archiveBytes.length, sha256: archiveHash, integrity: packed.integrity, files: paths }

    consumer = await mkdtemp(join(runEvidence, "consumer-"))
    receipt.consumer = { path: consumer, retained: true }
    await mkdir(join(consumer, "test"))
    await mkdir(join(consumer, "fixtures"))
    await mkdir(join(consumer, "artifacts"))
    await copyFile(archive, join(consumer, "artifacts", filename))
    await writeFile(join(consumer, "package.json"), JSON.stringify({
      name: "linked-work-packed-consumer", private: true, type: "module",
      dependencies: { [manifest.name]: `file:artifacts/${filename}`, ...manifest.dependencies },
      devDependencies: manifest.devDependencies,
    }, null, 2))
    await checked("install", [npm, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], consumer)
  }
  const archiveHash = receipt.artifact.sha256
  const retainedArchive = receipt.artifact.retainedPath
  assert.equal(sha(await readFile(retainedArchive)), archiveHash, "Retained archive changed")
  const lock = JSON.parse(await readFile(join(consumer, "package-lock.json"), "utf8"))
  receipt.consumer.manifest = { path: join(consumer, "package.json"), sha256: sha(await readFile(join(consumer, "package.json"))) }
  receipt.consumer.lockfile = { path: join(consumer, "package-lock.json"), sha256: sha(await readFile(join(consumer, "package-lock.json"))) }
  const minimumNode = "22.19.0"
  const incompatible = Object.entries(lock.packages).filter(([, pkg]) => pkg.engines?.node && !semver.satisfies(minimumNode, pkg.engines.node))
  assert.deepEqual(incompatible, [], "An installed dependency requires a higher Node floor")
  receipt.minimumNode = { declared: manifest.engines.node, dependencyRangesAccept: minimumNode, executedAtMinimum: false }
  receipt.dependencyVersions = Object.fromEntries(Object.entries(lock.packages).map(([path, pkg]) => [path, pkg.version ?? null]))

  const installed = join(consumer, "node_modules", manifest.name)
  const binding = await compareArchive({ artifact: retainedArchive, installedPackage: installed, name: manifest.name, version: manifest.version })
  assert.equal(binding.artifact.sha256, archiveHash)
  assert.equal(sha(await readFile(join(consumer, "artifacts", filename))), archiveHash)
  assert.deepEqual(binding.files.map((file) => file.path), paths)
  for (const file of binding.files) {
    assert.equal(file.sha256, sha(await readFile(join(root, file.path))), `Archive ${file.path} differs from the build input`)
  }
  receipt.installedHashes = Object.fromEntries(binding.files.map((file) => [file.path, file.sha256]))
  if (!previous) {
    for (const name of ["host.mjs", "linked-work.test.mjs"]) await copyFile(join(root, "test", name), join(consumer, "test", name))
    await checked("behavior", ["--test", "test/linked-work.test.mjs"], consumer, {
      LINKED_WORK_PACKAGE: manifest.name, OPENCODE_TEST_TMP: join(consumer, "fixtures"),
    })
  }
  await writeFile(join(consumer, "consumer.mts"), [
    'import plugin from "opencode-linked-work"',
    'import type { Plugin } from "@opencode/plugin/effect"',
    'const definition: Plugin.Plugin = plugin',
    'export { definition }',
    "",
  ].join("\n"))
  const compilerRoot = join(consumer, "node_modules/typescript")
  const compiler = JSON.parse(await readFile(join(compilerRoot, "package.json"), "utf8"))
  const compilerBin = compiler.bin.tsc ?? compiler.bin.tsc6
  assert.equal(typeof compilerBin, "string", "Installed TypeScript package must declare its compiler executable")
  if (previous?.commands.some((command) => command.label === "declarations" && command.exitCode === 0)) {
    receipt.reused.checks.push("declarations")
  } else {
    await checked("declarations", [
      join(compilerRoot, compilerBin), "--noEmit", "--strict", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--target", "ES2023", "--skipLibCheck", "--types", "node", "consumer.mts",
    ], consumer)
  }
  await writeFile(join(consumer, "public-contract.mjs"), [
    'import assert from "node:assert/strict"',
    'import { writeFile } from "node:fs/promises"',
    'import { resolve } from "node:path"',
    'import { Host } from "@opencode/plugin/host"',
    'import { Schema } from "effect"',
    'import { host } from "./test/host.mjs"',
    'const entries = Host.resolve({ directory: resolve("node_modules/opencode-linked-work") })',
    'assert.ok(entries.server, "Published package has a server entrypoint")',
    'const { default: plugin } = await Host.load(entries.server)',
    'const h = await host(plugin)',
    'try {',
    '  const tools = [...h.tools].map(([id, definition]) => {',
    '    assert.ok(definition.output, `Missing output contract for ${id}`)',
    '    return { id, name: definition.name, options: definition.options, description: definition.description, input: Schema.toJsonSchemaDocument(definition.input), output: Schema.toJsonSchemaDocument(definition.output) }',
    '  })',
    '  await writeFile("public-contract.json", JSON.stringify({ pluginID: plugin.id, tools, commands: [...h.commands.keys()] }, null, 2) + "\\n")',
    '} finally { await h.close() }',
    '',
  ].join("\n"))
  await checked("contract", ["public-contract.mjs"], consumer)
  const contract = await readFile(join(consumer, "public-contract.json"))
  await writeFile(join(runEvidence, "public-contract.json"), contract)
  receipt.publicContract = { path: join(consumer, "public-contract.json"), sha256: sha(contract) }
  assert.deepEqual(await hashes(), initial, "Package source changed while verification was running")
  assert.deepEqual(await compareArchive({ artifact: retainedArchive, installedPackage: installed, name: manifest.name, version: manifest.version }), binding, "Installed artifact changed during its checks")
  const bindingBytes = JSON.stringify(binding, null, 2) + "\n"
  const bindingPath = join(runEvidence, "installed-binding.json")
  await writeFile(bindingPath, bindingBytes)
  receipt.binding = { path: bindingPath, sha256: sha(bindingBytes) }
  await writeFile(join(runEvidence, "source-manifest.json"), JSON.stringify(initial, null, 2) + "\n")
  receipt.status = "passed"
} catch (error) {
  receipt.status = "failed"
  receipt.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  if (consumer) receipt.consumerCleanup = "retained for exact-graph installation handoff; behavioral fixtures close their own resources"
  receipt.finished = new Date().toISOString()
  const resultPath = join(runEvidence, "result.json")
  await writeFile(resultPath, JSON.stringify(receipt, null, 2) + "\n")
  console.log(JSON.stringify({ status: receipt.status, receipt: resultPath, artifact: receipt.artifact, binding: receipt.binding, consumer: receipt.consumer, error: receipt.error }, null, 2))
}
