import assert from "node:assert/strict";
import test from "node:test";
import { ACT_INSTALLATION_DOCS, actInstallationFor } from "../server/act-installation.mjs";

test("suggests Homebrew on macOS", () => {
  const result = actInstallationFor("darwin", "arm64");
  assert.equal(result.os, "macOS");
  assert.equal(result.command, "brew install act");
  assert.equal(result.docsUrl, ACT_INSTALLATION_DOCS);
});

test("suggests WinGet on Windows", () => {
  const result = actInstallationFor("win32", "x64");
  assert.equal(result.os, "Windows");
  assert.equal(result.command, "winget install nektos.act");
});

test("uses the official installer on Linux", () => {
  const result = actInstallationFor("linux", "x64");
  assert.equal(result.os, "Linux");
  assert.match(result.command, /nektos\/act\/master\/install\.sh/);
  assert.match(result.mitigations.join(" "), /--act-path/);
});
