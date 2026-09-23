// @effect-diagnostics nodeBuiltinImport:off
// The launcher is a shell script, so the test builds a checkout on disk and runs it.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const launcher = NodePath.join(import.meta.dirname, "bin", "wl");
const checkouts: string[] = [];

/** A checkout with the launcher in place, a lockfile, and whatever was installed. */
function checkout(installed: string | null): string {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wl-launcher-"));
  checkouts.push(root);
  const bin = NodePath.join(root, "scripts", "workflowleaf", "bin");
  NodeFS.mkdirSync(bin, { recursive: true });
  NodeFS.copyFileSync(launcher, NodePath.join(bin, "wl"));
  NodeFS.writeFileSync(NodePath.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  if (installed !== null) {
    NodeFS.mkdirSync(NodePath.join(root, "node_modules", ".pnpm"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "node_modules", ".pnpm", "lock.yaml"), installed);
  }
  // Stands in for the CLI, so a launcher that gets past its checks says so.
  const cli = NodePath.join(root, "packages", "workflowleaf-runtime", "src");
  NodeFS.mkdirSync(cli, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(cli, "bin.ts"), "console.log('cli ran');\n");
  return root;
}

function run(root: string) {
  return NodeChildProcess.spawnSync(
    "sh",
    [NodePath.join(root, "scripts", "workflowleaf", "bin", "wl")],
    {
      encoding: "utf8",
    },
  );
}

afterEach(() => {
  for (const root of checkouts.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("the wl launcher", () => {
  it("names the fix when the checkout was never installed", () => {
    const result = run(checkout(null));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no dependencies installed");
    expect(result.stderr).toContain("pnpm install --frozen-lockfile");
  });

  it("names the fix when the lockfile moved since the install", () => {
    const result = run(checkout("lockfileVersion: '8.0'\n"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("changed since its dependencies were installed");
  });

  it("runs the CLI when the install matches the lockfile", () => {
    const result = run(checkout("lockfileVersion: '9.0'\n"));
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("cli ran");
  });
});

/** Runs git quietly in a directory, failing the test on error. */
function git(cwd: string, ...args: string[]): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A checkout on `main` cloned from a bare origin, installed and current, plus a
 * second clone that can move origin/main ahead of it.
 */
function trackedCheckout() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wl-update-"));
  checkouts.push(root);
  const origin = NodePath.join(root, "origin.git");
  git(root, "init", "-q", "--bare", "-b", "main", origin);

  const seed = checkout("lockfileVersion: '9.0'\n");
  NodeFS.writeFileSync(NodePath.join(seed, ".gitignore"), "node_modules/\n");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "fixture@example.com");
  git(seed, "config", "user.name", "Fixture");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "seed");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");

  const other = NodePath.join(root, "other");
  git(root, "clone", "-q", origin, other);
  git(other, "config", "user.email", "fixture@example.com");
  git(other, "config", "user.name", "Fixture");
  const advance = (file: string, content: string) => {
    NodeFS.writeFileSync(NodePath.join(other, file), content);
    git(other, "add", ".");
    git(other, "commit", "-qm", `change ${file}`);
    git(other, "push", "-q", "origin", "main");
    return git(other, "rev-parse", "HEAD");
  };
  return { checkout: seed, advance };
}

function runWith(root: string, env: Record<string, string> = {}) {
  return NodeChildProcess.spawnSync(
    "sh",
    [NodePath.join(root, "scripts", "workflowleaf", "bin", "wl")],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

describe("the wl launcher keeps its checkout current", () => {
  it("fast-forwards a clean main to origin/main, so a merged fix reaches wl without a pull", () => {
    const { checkout: root, advance } = trackedCheckout();
    const merged = advance("merged.md", "a merged fix\n");

    const result = runWith(root);
    expect(result.stdout).toContain("cli ran");
    expect(result.stderr).toContain("wl: updated");
    expect(git(root, "rev-parse", "HEAD")).toBe(merged);
  });

  it("leaves a checkout with local edits alone, and says why", () => {
    const { checkout: root, advance } = trackedCheckout();
    advance("merged.md", "a merged fix\n");
    const before = git(root, "rev-parse", "HEAD");
    NodeFS.appendFileSync(NodePath.join(root, ".gitignore"), "local edit\n");

    const result = runWith(root);
    expect(result.stdout).toContain("cli ran");
    expect(result.stderr).toContain("has local edits; not updating");
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("installs dependencies when the update moved the lockfile", () => {
    const { checkout: root, advance } = trackedCheckout();
    advance("pnpm-lock.yaml", "lockfileVersion: '9.1'\n");
    // Stands in for pnpm: an install leaves pnpm's copy of the lockfile behind.
    const bin = NodePath.join(root, "..", "fake-bin");
    NodeFS.mkdirSync(bin, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(bin, "pnpm"),
      "#!/bin/sh\ncp pnpm-lock.yaml node_modules/.pnpm/lock.yaml\n",
      { mode: 0o755 },
    );

    const result = runWith(root, { PATH: `${bin}:${process.env.PATH ?? ""}` });
    expect(result.stderr).toContain("installing them");
    expect(result.stdout).toContain("cli ran");
  });

  it("does nothing with WL_NO_UPDATE set", () => {
    const { checkout: root, advance } = trackedCheckout();
    advance("merged.md", "a merged fix\n");
    const before = git(root, "rev-parse", "HEAD");

    const result = runWith(root, { WL_NO_UPDATE: "1" });
    expect(result.stdout).toContain("cli ran");
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });
});
