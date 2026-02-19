import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { probeOpenClawCLI, parseBindingsResponse, parseAgentsResponse, parseRoutingConfigResponse } from "./openclaw.ts";

describe("OpenClaw provider", () => {
  it("parseBindingsResponse handles valid JSON", () => {
    const json = JSON.stringify([
      {
        agentId: "main",
        match: { channel: "discord", peer: { kind: "channel", id: "123" } },
      },
    ]);
    const result = parseBindingsResponse(json);
    assert.equal(result.length, 1);
    assert.equal(result[0].agentId, "main");
    assert.equal(result[0].match.peer.id, "123");
  });

  it("parseBindingsResponse rejects malformed response", () => {
    assert.throws(
      () => parseBindingsResponse("not json"),
      { message: /OpenClaw CLI returned unexpected data/ },
    );
  });

  it("parseBindingsResponse rejects wrong shape", () => {
    assert.throws(
      () => parseBindingsResponse(JSON.stringify({ bad: true })),
      { message: /OpenClaw CLI returned unexpected data/ },
    );
  });

  it("parseBindingsResponse includes raw snippet in error", () => {
    assert.throws(
      () => parseBindingsResponse("not json"),
      { message: /Raw:/ },
    );
  });

  it("parseAgentsResponse handles valid JSON", () => {
    const json = JSON.stringify([{ id: "main" }, { id: "siren" }]);
    const result = parseAgentsResponse(json);
    assert.deepEqual(result, ["main", "siren"]);
  });

  it("parseAgentsResponse rejects malformed response", () => {
    assert.throws(
      () => parseAgentsResponse("not json"),
      { message: /OpenClaw CLI returned unexpected data/ },
    );
  });

  it("parseAgentsResponse rejects wrong shape", () => {
    assert.throws(
      () => parseAgentsResponse(JSON.stringify([{ name: "no id" }])),
      { message: /OpenClaw CLI returned unexpected data/ },
    );
  });

  it("probeOpenClawCLI returns true when openclaw is available", async (t) => {
    const result = await probeOpenClawCLI();
    if (!result) t.skip("openclaw CLI not installed");
    else assert.equal(result, true);
  });
});

describe("parseRoutingConfigResponse", () => {
  it("parses guild routing config with channels", () => {
    const json = JSON.stringify({
      requireMention: true,
      channels: {
        "111": { allow: true, requireMention: false },
        "222": { allow: true },
      },
    });
    const result = parseRoutingConfigResponse(json);
    assert.equal(result.requireMention, true);
    assert.equal(Object.keys(result.channels!).length, 2);
    assert.equal(result.channels!["111"].allow, true);
    assert.equal(result.channels!["111"].requireMention, false);
    assert.equal(result.channels!["222"].allow, true);
    assert.equal(result.channels!["222"].requireMention, undefined);
  });

  it("parses empty guild config", () => {
    const json = JSON.stringify({});
    const result = parseRoutingConfigResponse(json);
    assert.equal(result.channels, undefined);
    assert.equal(result.requireMention, undefined);
  });

  it("preserves unknown keys via passthrough", () => {
    const json = JSON.stringify({
      channels: { "111": { allow: true } },
      someOtherField: "preserved",
    });
    const result = parseRoutingConfigResponse(json);
    assert.equal((result as Record<string, unknown>).someOtherField, "preserved");
  });

  it("rejects malformed JSON", () => {
    assert.throws(
      () => parseRoutingConfigResponse("not json"),
      { message: /OpenClaw CLI returned unexpected data/ },
    );
  });

  it("rejects non-object response", () => {
    assert.throws(
      () => parseRoutingConfigResponse(JSON.stringify([])),
      { message: /OpenClaw CLI returned unexpected data/ },
    );
  });

  it("truncates long raw output in error message", () => {
    const longInput = "x".repeat(300);
    assert.throws(
      () => parseRoutingConfigResponse(longInput),
      (err: Error) => {
        // Raw snippet should be truncated to 200 chars
        const rawMatch = err.message.match(/Raw: (.+)/);
        return rawMatch !== null && rawMatch[1].length <= 200;
      },
    );
  });
});
