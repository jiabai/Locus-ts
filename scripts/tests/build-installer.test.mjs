import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertBundledWindowsVcRuntimeDlls,
  bundleWindowsVcRuntimeDlls,
  copyDenoFromArchive,
  copyYtdlpAsset,
  defaultDenoArchiveUrl,
  defaultYtdlpAssetUrl,
  normalizeUnixPythonLaunchers,
  parseArgs,
  requireBundledDeno,
  requiredDenoBinary,
  requiredYtdlpBinary,
  verifyFileSha256,
  WINDOWS_VC_RUNTIME_DLLS,
  ytdlpSha256,
} from "../build-installer.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const buildInstallerPath = join(testDir, "..", "build-installer.mjs");
const projectManifestPath = join(testDir, "..", "..", "pyproject.toml");
const repoRoot = join(testDir, "..", "..");

async function tempRoot(name) {
  return mkdtemp(join(tmpdir(), `app-${name}-`));
}

for (const minor of ["11", "13"]) {
  test(`normalizes the python3.${minor} filename into independent executable launchers`, async () => {
    const fixtures = join(repoRoot, "build", "installer-launcher-tests");
    await mkdir(fixtures, { recursive: true });
    const root = await mkdtemp(join(fixtures, "runtime-"));
    const bin = join(root, "bin");
    await mkdir(bin);
    const python = spawnSync(process.platform === "win32" ? "python" : "python3", ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(python.status, 0, python.stderr);
    const versionedName = `python3.${minor}`;
    const versioned = join(bin, versionedName);
    await copyFile(python.stdout.trim(), versioned);
    await chmod(versioned, 0o755);
    if (process.platform !== "win32") {
      await symlink(versionedName, join(bin, "python"));
      await symlink(versionedName, join(bin, "python3"));
    }

    await normalizeUnixPythonLaunchers(root);
    await normalizeUnixPythonLaunchers(root);

    const original = readFileSync(versioned);
    for (const name of ["python", "python3"]) {
      const launcher = join(bin, name);
      const metadata = await lstat(launcher);
      assert.equal(metadata.isSymbolicLink(), false);
      assert.equal(metadata.isFile(), true);
      assert.equal(metadata.nlink, 1);
      assert.deepEqual(readFileSync(launcher), original);
      if (process.platform !== "win32") assert.notEqual(metadata.mode & 0o111, 0);
    }
    assert.deepEqual(readFileSync(versioned), original);
  });
}

async function createFakeDenoArchive(binaryName) {
  const root = await tempRoot("deno-archive");
  const source = join(root, "source");
  const archive = join(root, "deno.tar");
  await mkdir(source, { recursive: true });
  const binary = join(source, binaryName);
  await writeFile(binary, "#!/usr/bin/env sh\nprintf 'deno fake\\n'\n");
  await chmod(binary, 0o755);

  // 相对归档路径同时兼容 Git Bash 的 GNU tar 与系统自带的 bsdtar。
  const result = spawnSync("tar", ["-cf", "deno.tar", "-C", "source", binaryName], {
    cwd: root,
    stdio: "pipe",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `create fake deno archive: ${result.stderr.toString()}`,
  );
  return { root, archive };
}

test("maps supported targets to bundled Deno binary names", () => {
  assert.equal(requiredDenoBinary("windows-x64"), "deno.exe");
  assert.equal(requiredDenoBinary("macos-arm64"), "deno");
  assert.throws(() => requiredDenoBinary("macos-x64"), /Unsupported target/);
});

test("builds official Deno release archive URLs per target", () => {
  assert.equal(
    defaultDenoArchiveUrl("windows-x64", "v2.9.1"),
    "https://github.com/denoland/deno/releases/download/v2.9.1/deno-x86_64-pc-windows-msvc.zip",
  );
  assert.equal(
    defaultDenoArchiveUrl("macos-arm64", "v2.9.1"),
    "https://github.com/denoland/deno/releases/download/v2.9.1/deno-aarch64-apple-darwin.zip",
  );
});

test("maps supported targets to the bundled yt-dlp asset and pins its digest", () => {
  assert.equal(requiredYtdlpBinary("windows-x64"), "yt-dlp.exe");
  assert.equal(requiredYtdlpBinary("macos-arm64"), "yt-dlp_macos");
  assert.throws(() => requiredYtdlpBinary("macos-x64"), /Unsupported target/);
  assert.equal(ytdlpSha256("windows-x64"), "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d");
  assert.equal(ytdlpSha256("macos-arm64"), "0f922c15ccc0b83eefa1c8bc9104e434318c4bf16e408e1ee93b7745a6efe0aa");
  assert.throws(() => ytdlpSha256("macos-x64"), /Unsupported target/);
});

test("builds official yt-dlp release asset URLs per target", () => {
  assert.equal(
    defaultYtdlpAssetUrl("windows-x64"),
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe",
  );
  assert.equal(
    defaultYtdlpAssetUrl("macos-arm64"),
    "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_macos",
  );
});

test("verifies a file digest before a bundled asset is accepted", async () => {
  const root = await tempRoot("ytdlp-digest");
  try {
    const file = join(root, "yt-dlp.exe");
    await writeFile(file, "not the official binary");
    const expected = createHash("sha256").update("not the official binary").digest("hex");

    assert.doesNotThrow(() => verifyFileSha256(file, expected, "fixture"));
    assert.throws(
      () => verifyFileSha256(file, "0".repeat(64), "fixture"),
      /fixture SHA-256 mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copyYtdlpAsset rejects a local source whose digest does not match", async () => {
  const root = await tempRoot("ytdlp-copy");
  try {
    const source = join(root, "source", "yt-dlp.exe");
    const destination = join(root, "bin");
    const buildRoot = join(root, "build");
    await mkdir(dirname(source), { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(source, "fake yt-dlp");

    await assert.rejects(
      copyYtdlpAsset({ target: "windows-x64", ytdlpUrl: source }, destination, buildRoot),
      /yt-dlp \(windows-x64\) SHA-256 mismatch/,
    );
    assert.equal(existsSync(join(destination, "yt-dlp.exe")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseArgs accepts Deno archive and version overrides", () => {
  const options = parseArgs([
    "--target",
    "macos-arm64",
    "--deno-archive-url",
    "file:///tmp/deno.zip",
    "--deno-version",
    "v2.9.1",
  ]);

  assert.equal(options.target, "macos-arm64");
  assert.equal(options.denoArchiveUrl, "file:///tmp/deno.zip");
  assert.equal(options.denoVersion, "v2.9.1");
});

test("parseArgs accepts a yt-dlp asset URL override", () => {
  const options = parseArgs(["--target", "windows-x64", "--ytdlp-url", "file:///tmp/yt-dlp.exe"]);

  assert.equal(options.ytdlpUrl, "file:///tmp/yt-dlp.exe");
  assert.equal(parseArgs(["--target", "windows-x64"]).ytdlpUrl, "");
});

test("installer downloads and verifies yt-dlp before assembling the TypeScript worker", () => {
  const buildScript = readFileSync(buildInstallerPath, "utf8");

  assert.match(buildScript, /await copyYtdlpAsset\(options, binRoot, buildRoot\)/);
  assert.match(buildScript, /requireBundledYtdlp\(binRoot, options\.target\)/);
  assert.ok(
    buildScript.indexOf("await copyYtdlpAsset(options, binRoot, buildRoot)") <
      buildScript.indexOf("const workerTsDependencies"),
  );
});

test("installer build installs and imports the bundled ONNX runtime before Tauri packaging", () => {
  const buildScript = readFileSync(buildInstallerPath, "utf8");
  const manifest = readFileSync(projectManifestPath, "utf8");

  assert.match(manifest, /"funasr-onnx==0\.4\.2"/);
  assert.match(manifest, /"onnxruntime>=1\.17\.0"/);
  assert.match(
    buildScript,
    /\["export", "--no-dev", "--no-hashes", "--format", "requirements-txt", "--output-file", requirementsPath\]/,
  );
  assert.match(
    buildScript,
    /\["-m", "pip", "install", "--only-binary=llvmlite,cryptography", "-r", requirementsPath\]/,
  );
  assert.match(
    buildScript,
    /import funasr_onnx, modelscope, onnxruntime, yt_dlp; import worker_core/,
  );
  assert.ok(
    buildScript.indexOf("Python runtime smoke test") < buildScript.indexOf("Build Tauri installer"),
  );
});

test("installer bundles the version-12 source and diagnostic worker modules without private artifacts", () => {
  const buildScript = readFileSync(buildInstallerPath, "utf8");
  const contract = JSON.parse(
    readFileSync(join(repoRoot, "contracts", "desktop-worker-contract.json"), "utf8"),
  );

  assert.equal(contract.contractVersion, 12);
  assert.equal(contract.events.workerDiagnosticPrefix, "APP_DIAGNOSTIC ");
  assert.match(
    buildScript,
    /copyDirectoryContents\(join\(repoRoot, "worker", "worker_core"\), join\(destination, "worker_core"\)\)/,
  );
  assert.equal(
    existsSync(join(repoRoot, "worker", "worker_core", "dissection_agent.py")),
    true,
  );
  for (const module of [
    "summary_agent.py", "topic_agent.py", "ai_runtime.py", "ai_prompts.py",
    "transcript_chunks.py", "dissection_report.py", "ai_artifacts.py",
    "note_title.py", "note_title_metadata.py",
    "source_text.py", "web_page_contract.py", "web_page_storage.py",
  ]) {
    assert.equal(existsSync(join(repoRoot, "worker", "worker_core", module)), true);
  }
  assert.equal(existsSync(join(repoRoot, "worker", "worker_core", "insightflow")), false);
  assert.equal(
    existsSync(join(repoRoot, "worker", "worker_core", "pipeline_runtime", "dissection.py")),
    true,
  );
  assert.equal(
    existsSync(join(repoRoot, "worker", "worker_core", "diagnostic_events.py")),
    true,
  );
  assert.doesNotMatch(buildScript, /APP_LLM_API_KEY\s*=|dissection\.json["']\s*,\s*["']/);
});

test("requireBundledDeno fails clearly when skip-download resources lack Deno", async () => {
  const root = await tempRoot("deno-required");
  try {
    await mkdir(root, { recursive: true });

    assert.throws(
      () => requireBundledDeno(root, "macos-arm64"),
      /Could not find bundled Deno runtime/,
    );

    await writeFile(join(root, "deno"), "");
    assert.doesNotThrow(() => requireBundledDeno(root, "macos-arm64"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copyDenoFromArchive extracts Deno into resources bin", async () => {
  const { root, archive } = await createFakeDenoArchive("deno");
  const destination = join(root, "resources-bin");

  try {
    await copyDenoFromArchive(archive, destination, "macos-arm64");

    const copied = join(destination, "deno");
    assert.equal(existsSync(copied), true);
    assert.deepEqual(
      readFileSync(copied),
      readFileSync(join(root, "source", "deno")),
    );
    if (process.platform !== "win32") {
      const mode = (await stat(copied)).mode;
      assert.notEqual(mode & 0o111, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundles VC++ runtime DLLs app-local into the python root", async () => {
  const root = await tempRoot("vc-runtime-bundle");
  try {
    const systemRoot = join(root, "System");
    const pythonRoot = join(root, "python");
    const system32 = join(systemRoot, "System32");
    await mkdir(system32, { recursive: true });
    await mkdir(pythonRoot, { recursive: true });
    for (const dllName of WINDOWS_VC_RUNTIME_DLLS) {
      await writeFile(join(system32, dllName), `fake-${dllName}`);
    }

    const copied = await bundleWindowsVcRuntimeDlls(pythonRoot, systemRoot);

    assert.deepEqual(copied, WINDOWS_VC_RUNTIME_DLLS);
    for (const dllName of WINDOWS_VC_RUNTIME_DLLS) {
      assert.equal(readFileSync(join(pythonRoot, dllName), "utf8"), `fake-${dllName}`);
    }
    assert.doesNotThrow(() => assertBundledWindowsVcRuntimeDlls(pythonRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps an existing bundled vcruntime140.dll without overwriting it", async () => {
  const root = await tempRoot("vc-runtime-keep");
  try {
    const systemRoot = join(root, "System");
    const pythonRoot = join(root, "python");
    const system32 = join(systemRoot, "System32");
    await mkdir(system32, { recursive: true });
    await mkdir(pythonRoot, { recursive: true });
    for (const dllName of WINDOWS_VC_RUNTIME_DLLS) {
      await writeFile(join(system32, dllName), `fake-${dllName}`);
    }
    await writeFile(join(pythonRoot, "vcruntime140.dll"), "bundled-by-python");

    const copied = await bundleWindowsVcRuntimeDlls(pythonRoot, systemRoot);

    assert.deepEqual(copied, ["msvcp140.dll", "vcruntime140_1.dll"]);
    assert.equal(readFileSync(join(pythonRoot, "vcruntime140.dll"), "utf8"), "bundled-by-python");
    assert.equal(readFileSync(join(pythonRoot, "msvcp140.dll"), "utf8"), "fake-msvcp140.dll");
    assert.equal(readFileSync(join(pythonRoot, "vcruntime140_1.dll"), "utf8"), "fake-vcruntime140_1.dll");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails clearly when a required VC++ runtime DLL is missing from the system", async () => {
  const root = await tempRoot("vc-runtime-missing");
  try {
    const systemRoot = join(root, "System");
    const pythonRoot = join(root, "python");
    const system32 = join(systemRoot, "System32");
    await mkdir(system32, { recursive: true });
    await mkdir(pythonRoot, { recursive: true });
    await writeFile(join(system32, "msvcp140.dll"), "fake-msvcp140.dll");
    await writeFile(join(system32, "vcruntime140_1.dll"), "fake-vcruntime140_1.dll");

    await assert.rejects(
      bundleWindowsVcRuntimeDlls(pythonRoot, systemRoot),
      /Could not find VC\+\+ runtime DLL.*vcruntime140\.dll/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asserts bundled VC++ runtime DLL presence", async () => {
  const root = await tempRoot("vc-runtime-assert");
  try {
    const pythonRoot = join(root, "python");
    await mkdir(pythonRoot, { recursive: true });

    assert.throws(() => assertBundledWindowsVcRuntimeDlls(pythonRoot), /Could not find bundled VC\+\+ runtime DLLs/);

    for (const dllName of WINDOWS_VC_RUNTIME_DLLS) {
      await writeFile(join(pythonRoot, dllName), "fake");
    }
    assert.doesNotThrow(() => assertBundledWindowsVcRuntimeDlls(pythonRoot));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer bundles VC++ runtime DLLs before the Python runtime smoke test", () => {
  const buildScript = readFileSync(buildInstallerPath, "utf8");

  assert.match(buildScript, /bundleWindowsVcRuntimeDlls\(pythonRoot\)/);
  assert.ok(
    buildScript.indexOf("bundleWindowsVcRuntimeDlls(pythonRoot)") <
      buildScript.indexOf("Python runtime smoke test"),
  );
  assert.match(buildScript, /options\.target === "windows-x64"/);
});
