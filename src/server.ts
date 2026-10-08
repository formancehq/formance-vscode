// Locating, downloading and installing numscript language server releases.
// This module does not depend on the vscode API so it can be unit tested.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const NUMSCRIPT_REPO = "formancehq/numscript";
const RELEASE_API_TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const STAGING_PREFIX = ".staging-";
const STALE_STAGING_MS = 60 * 60_000;

export interface GithubAsset {
  name: string;
  browser_download_url: string;
}

export interface GithubRelease {
  tag_name: string;
  assets: GithubAsset[];
}

export type ProgressCallback = (received: number, total?: number) => void;

const ARCHS: Partial<Record<NodeJS.Architecture, string>> = {
  x64: "x86_64",
  arm64: "arm64",
};

const PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  win32: "Windows",
  linux: "Linux",
  darwin: "Darwin",
};

// Release tags are used as directory names, so only accept plain version tags.
const TAG_PATTERN = /^v?\d+\.\d+\.\d+[\w.-]*$/;

export function executableName(platform = process.platform): string {
  return platform === "win32" ? "numscript.exe" : "numscript";
}

// Returns the goreleaser platform suffix (e.g. "Darwin_arm64"), or undefined
// when numscript does not publish binaries for this platform.
export function platformSuffix(
  arch = process.arch,
  platform = process.platform,
): string | undefined {
  const archName = ARCHS[arch];
  const platformName = PLATFORMS[platform];
  if (archName === undefined || platformName === undefined) {
    return undefined;
  }
  return `${platformName}_${archName}`;
}

export function findArchive(
  assets: GithubAsset[],
  suffix: string,
): GithubAsset | undefined {
  return assets.find(
    (a) =>
      a.name.endsWith(`_${suffix}.tar.gz`) || a.name.endsWith(`_${suffix}.zip`),
  );
}

// Parses a goreleaser checksums file ("<sha256>  <file name>" per line).
export function parseChecksums(text: string): Map<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)$/i.exec(line.trim());
    if (match) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export function installedExecutable(storageDir: string, tag: string): string {
  return path.join(storageDir, tag, executableName());
}

// Where versions before 0.1.0 installed the server.
export function legacyExecutable(storageDir: string): string {
  return path.join(storageDir, executableName());
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export function isInstalled(storageDir: string, tag: string): Promise<boolean> {
  return fileExists(installedExecutable(storageDir, tag));
}

export async function fetchLatestRelease(): Promise<GithubRelease> {
  const response = await fetch(
    `https://api.github.com/repos/${NUMSCRIPT_REPO}/releases/latest`,
    {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(RELEASE_API_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub returned HTTP ${response.status} for the latest numscript release`,
    );
  }

  const release = (await response.json()) as GithubRelease;
  if (!TAG_PATTERN.test(release.tag_name)) {
    throw new Error(`Unexpected numscript release tag '${release.tag_name}'`);
  }
  return release;
}

// Aborts the download when no data arrives for idleTimeoutMs.
export async function download(
  url: string,
  onProgress?: ProgressCallback,
  idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS,
): Promise<Buffer> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const armIdleTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        controller.abort(
          new Error(`Download of ${url} stalled for ${idleTimeoutMs} ms`),
        ),
      idleTimeoutMs,
    );
  };

  armIdleTimer();
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || response.body === null) {
      throw new Error(`Downloading ${url} failed with HTTP ${response.status}`);
    }

    const total = Number(response.headers.get("content-length")) || undefined;
    const chunks: Uint8Array[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      armIdleTimer();
      chunks.push(chunk);
      received += chunk.length;
      onProgress?.(received, total);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

// Extracts with the system tar: bsdtar on macOS and Windows reads both
// .tar.gz and .zip archives, GNU tar on Linux reads .tar.gz.
async function extract(archive: string, destination: string): Promise<void> {
  const tar =
    process.platform === "win32"
      ? path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "tar.exe",
        )
      : "tar";
  await promisify(execFile)(tar, ["-xf", archive, "-C", destination]);
}

// Downloads the release archive for the current platform, verifies its
// checksum and extracts it into <storageDir>/<tag>. Returns the executable path.
export async function installRelease(
  release: GithubRelease,
  storageDir: string,
  onProgress?: ProgressCallback,
): Promise<string> {
  const suffix = platformSuffix();
  if (suffix === undefined) {
    throw new Error(
      `numscript does not publish binaries for ${process.platform}-${process.arch}; ` +
        "build it from https://github.com/formancehq/numscript and set numscript.server-path",
    );
  }

  const archive = findArchive(release.assets, suffix);
  if (archive === undefined) {
    throw new Error(
      `numscript ${release.tag_name} has no ${suffix} archive (assets: ${release.assets
        .map((a) => a.name)
        .join(", ")})`,
    );
  }

  const checksumsAsset = release.assets.find((a) =>
    a.name.endsWith("checksums.txt"),
  );
  if (checksumsAsset === undefined) {
    throw new Error(`numscript ${release.tag_name} has no checksums file`);
  }

  const checksums = parseChecksums(
    (await download(checksumsAsset.browser_download_url)).toString("utf8"),
  );
  const expected = checksums.get(archive.name);
  if (expected === undefined) {
    throw new Error(`No checksum published for ${archive.name}`);
  }

  const data = await download(archive.browser_download_url, onProgress);
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) {
    throw new Error(
      `Checksum mismatch for ${archive.name}: expected ${expected}, got ${actual}`,
    );
  }

  // Extract into a private staging directory, then rename it into place, so
  // <storageDir>/<tag> only ever exists complete. Other VS Code windows share
  // the storage directory and may install the same release concurrently.
  await fs.mkdir(storageDir, { recursive: true });
  const staging = await fs.mkdtemp(path.join(storageDir, STAGING_PREFIX));
  try {
    const archivePath = path.join(staging, archive.name);
    await fs.writeFile(archivePath, data);
    await extract(archivePath, staging);
    await fs.rm(archivePath, { force: true });
    await fs.access(path.join(staging, executableName()));

    try {
      await fs.rename(staging, path.join(storageDir, release.tag_name));
    } catch (err) {
      // Another window installed it first.
      if (!(await isInstalled(storageDir, release.tag_name))) {
        throw err;
      }
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return installedExecutable(storageDir, release.tag_name);
}

// Removes everything in storageDir except the given release, including the
// binary that versions before 0.1.0 stored directly in storageDir. Staging
// directories are kept while recent, since another window may be using one.
// Best effort: a binary still in use on Windows cannot be deleted.
export async function pruneOtherVersions(
  storageDir: string,
  keepTag: string,
  now = Date.now(),
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(storageDir);
  } catch {
    return;
  }
  await Promise.allSettled(
    entries
      .filter((entry) => entry !== keepTag)
      .map(async (entry) => {
        const entryPath = path.join(storageDir, entry);
        if (entry.startsWith(STAGING_PREFIX)) {
          const { mtimeMs } = await fs.stat(entryPath);
          if (now - mtimeMs < STALE_STAGING_MS) {
            return;
          }
        }
        await fs.rm(entryPath, { recursive: true, force: true });
      }),
  );
}
