import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveConfigPath, resolveSnapshotPath, resolveSnapshotOptions } from "./types.ts";

describe("resolveConfigPath", () => {
  it("uses -c flag when provided", () => {
    assert.equal(resolveConfigPath({ config: "/tmp/my.yaml" }), "/tmp/my.yaml");
  });

  it("falls back to CWD/disclaw.yaml", () => {
    const result = resolveConfigPath({});
    assert.ok(result.endsWith("disclaw.yaml"));
  });

  it("uses DISCLAW_CONFIG env var when no -c flag", () => {
    const prev = process.env.DISCLAW_CONFIG;
    try {
      process.env.DISCLAW_CONFIG = "/env/path.yaml";
      assert.equal(resolveConfigPath({}), "/env/path.yaml");
    } finally {
      process.env.DISCLAW_CONFIG = prev;
    }
  });
});

describe("resolveSnapshotPath", () => {
  it("derives from config basename", () => {
    assert.equal(resolveSnapshotPath("/app/disclaw.yaml"), "/app/disclaw-snapshot.json");
  });

  it("slugifies dots in basename", () => {
    assert.equal(resolveSnapshotPath("/app/my.prod.yaml"), "/app/my-prod-snapshot.json");
  });
});

describe("resolveSnapshotOptions", () => {
  it("disables with --no-snapshot", () => {
    const result = resolveSnapshotOptions({ noSnapshot: true, configPath: "x.yaml" });
    assert.equal(result.enabled, false);
  });

  it("uses custom path from --snapshot", () => {
    const result = resolveSnapshotOptions({ snapshot: "/tmp/s.json", configPath: "x.yaml" });
    assert.equal(result.enabled, true);
    assert.equal(result.path, "/tmp/s.json");
  });

  it("derives default path from config", () => {
    const result = resolveSnapshotOptions({ configPath: "/app/disclaw.yaml" });
    assert.equal(result.enabled, true);
    assert.equal(result.path, "/app/disclaw-snapshot.json");
  });

  it("disables via DISCLAW_SNAPSHOT=off", () => {
    const prev = process.env.DISCLAW_SNAPSHOT;
    try {
      process.env.DISCLAW_SNAPSHOT = "off";
      const result = resolveSnapshotOptions({ configPath: "/app/disclaw.yaml" });
      assert.equal(result.enabled, false);
    } finally {
      process.env.DISCLAW_SNAPSHOT = prev;
    }
  });

  it("uses DISCLAW_SNAPSHOT env var as custom path", () => {
    const prev = process.env.DISCLAW_SNAPSHOT;
    try {
      process.env.DISCLAW_SNAPSHOT = "/env/snap.json";
      const result = resolveSnapshotOptions({ configPath: "/app/disclaw.yaml" });
      assert.equal(result.enabled, true);
      assert.equal(result.path, "/env/snap.json");
    } finally {
      process.env.DISCLAW_SNAPSHOT = prev;
    }
  });
});
