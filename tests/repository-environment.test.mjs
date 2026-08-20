import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repositorySlugFromRemote, resolveDockerHost } from "../server/repository-environment.mjs";

test("parses HTTPS and SSH GitHub origin URLs", () => {
  assert.equal(repositorySlugFromRemote("https://github.com/owner/repository.git"), "owner/repository");
  assert.equal(repositorySlugFromRemote("git@github.com:owner/repository.git"), "owner/repository");
  assert.equal(repositorySlugFromRemote("https://gitlab.com/owner/repository.git"), undefined);
});

test("resolves the active Docker context endpoint", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "actui-docker-"));
  const docker = path.join(directory, "docker");
  try {
    await writeFile(docker, "#!/bin/sh\nprintf '%s\\n' 'unix:///Users/test/.orbstack/run/docker.sock'\n");
    await chmod(docker, 0o755);
    const previous = process.env.DOCKER_HOST;
    delete process.env.DOCKER_HOST;
    try {
      assert.equal(await resolveDockerHost(docker), "unix:///Users/test/.orbstack/run/docker.sock");
    } finally {
      if (previous === undefined) delete process.env.DOCKER_HOST;
      else process.env.DOCKER_HOST = previous;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
