import * as assert from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  download,
  executableName,
  findArchive,
  GithubRelease,
  installRelease,
  parseChecksums,
  platformSuffix,
  pruneOtherVersions,
} from "../server";

// Asset names of the numscript v0.1.1 release.
const assets = [
  "numscript_0.1.1_checksums.txt",
  "numscript_0.1.1_Darwin_arm64.tar.gz",
  "numscript_0.1.1_Darwin_x86_64.tar.gz",
  "numscript_0.1.1_Linux_arm64.tar.gz",
  "numscript_0.1.1_Linux_x86_64.tar.gz",
  "numscript_0.1.1_Windows_arm64.zip",
  "numscript_0.1.1_Windows_x86_64.zip",
].map((name) => ({
  name,
  browser_download_url: `https://example.test/${name}`,
}));

suite("server", () => {
  test("platformSuffix maps node platforms to release names", () => {
    assert.strictEqual(platformSuffix("arm64", "darwin"), "Darwin_arm64");
    assert.strictEqual(platformSuffix("x64", "linux"), "Linux_x86_64");
    assert.strictEqual(platformSuffix("x64", "win32"), "Windows_x86_64");
    assert.strictEqual(platformSuffix("ia32", "linux"), undefined);
    assert.strictEqual(platformSuffix("x64", "freebsd"), undefined);
  });

  test("executableName adds .exe on Windows only", () => {
    assert.strictEqual(executableName("win32"), "numscript.exe");
    assert.strictEqual(executableName("linux"), "numscript");
  });

  test("findArchive picks the archive for the platform", () => {
    assert.strictEqual(
      findArchive(assets, "Linux_x86_64")?.name,
      "numscript_0.1.1_Linux_x86_64.tar.gz",
    );
    assert.strictEqual(
      findArchive(assets, "Windows_arm64")?.name,
      "numscript_0.1.1_Windows_arm64.zip",
    );
    assert.strictEqual(findArchive(assets, "Plan9_x86_64"), undefined);
  });

  test("parseChecksums reads goreleaser checksum files", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    const checksums = parseChecksums(
      `${a}  numscript_0.1.1_Darwin_arm64.tar.gz\r\n${b} *numscript_0.1.1_Windows_x86_64.zip\n\nnot a checksum\n`,
    );
    assert.strictEqual(checksums.size, 2);
    assert.strictEqual(checksums.get("numscript_0.1.1_Darwin_arm64.tar.gz"), a);
    assert.strictEqual(
      checksums.get("numscript_0.1.1_Windows_x86_64.zip"),
      b.toLowerCase(),
    );
  });

  test("download aborts a stalled transfer", async () => {
    // Sends part of the body, then never finishes.
    const stalled = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
    });
    await new Promise<void>((resolve) =>
      stalled.listen(0, "127.0.0.1", resolve),
    );
    const { port } = stalled.address() as AddressInfo;
    try {
      await assert.rejects(
        download(`http://127.0.0.1:${port}/archive`, undefined, 200),
        /stalled/,
      );
    } finally {
      stalled.closeAllConnections();
      stalled.close();
    }
  });

  test("pruneOtherVersions keeps only the given release", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "numscript-test-"));
    try {
      await fs.mkdir(path.join(dir, "v0.1.0"));
      await fs.mkdir(path.join(dir, "v0.1.1"));
      await fs.writeFile(path.join(dir, "numscript"), "legacy binary");

      await pruneOtherVersions(dir, "v0.1.1");

      assert.deepStrictEqual(await fs.readdir(dir), ["v0.1.1"]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("pruneOtherVersions keeps staging directories until stale", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "numscript-test-"));
    try {
      await fs.mkdir(path.join(dir, ".staging-abc"));

      await pruneOtherVersions(dir, "v0.1.1");
      assert.deepStrictEqual(await fs.readdir(dir), [".staging-abc"]);

      await pruneOtherVersions(dir, "v0.1.1", Date.now() + 2 * 60 * 60_000);
      assert.deepStrictEqual(await fs.readdir(dir), []);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  suite("installRelease", () => {
    let work: string;
    let releaseServer: http.Server;
    let release: GithubRelease;
    let archiveName: string;
    const files = new Map<string, Buffer>();

    suiteSetup(async function () {
      // Windows releases are zip archives; the tar.gz fixture covers the
      // install flow on the platforms CI runs on.
      if (process.platform === "win32") {
        this.skip();
      }
      work = await fs.mkdtemp(path.join(os.tmpdir(), "numscript-install-"));
      const content = path.join(work, "content");
      await fs.mkdir(content);
      await fs.writeFile(path.join(content, executableName()), "#!/bin/sh\n");
      archiveName = `numscript_9.9.9_${platformSuffix()}.tar.gz`;
      const archivePath = path.join(work, archiveName);
      await promisify(execFile)("tar", [
        "-czf",
        archivePath,
        "-C",
        content,
        ".",
      ]);
      const archive = await fs.readFile(archivePath);
      files.set(archiveName, archive);
      files.set(
        "numscript_9.9.9_checksums.txt",
        Buffer.from(
          `${createHash("sha256").update(archive).digest("hex")}  ${archiveName}\n`,
        ),
      );

      releaseServer = http.createServer((req, res) => {
        const body = files.get(path.basename(req.url ?? ""));
        res.writeHead(body ? 200 : 404).end(body);
      });
      await new Promise<void>((resolve) =>
        releaseServer.listen(0, "127.0.0.1", resolve),
      );
      const { port } = releaseServer.address() as AddressInfo;
      release = {
        tag_name: "v9.9.9",
        assets: [...files.keys()].map((name) => ({
          name,
          browser_download_url: `http://127.0.0.1:${port}/${name}`,
        })),
      };
    });

    suiteTeardown(async () => {
      releaseServer?.close();
      if (work) {
        await fs.rm(work, { recursive: true, force: true });
      }
    });

    test("concurrent installs of the same release both succeed", async () => {
      const storage = await fs.mkdtemp(path.join(work, "storage-"));
      const [a, b] = await Promise.all([
        installRelease(release, storage),
        installRelease(release, storage),
      ]);

      const expected = path.join(storage, "v9.9.9", executableName());
      assert.strictEqual(a, expected);
      assert.strictEqual(b, expected);
      // No staging directory is left behind.
      assert.deepStrictEqual(await fs.readdir(storage), ["v9.9.9"]);
    });

    test("rejects an archive that does not match its checksum", async () => {
      const storage = await fs.mkdtemp(path.join(work, "storage-"));
      const original = files.get(archiveName)!;
      files.set(archiveName, Buffer.concat([original, Buffer.from("x")]));
      try {
        await assert.rejects(installRelease(release, storage), /Checksum/);
        assert.deepStrictEqual(await fs.readdir(storage), []);
      } finally {
        files.set(archiveName, original);
      }
    });
  });
});
