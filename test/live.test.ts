/**
 * Opt-in: the MCP server against the real pagenull API. Uses a free test render (watermarked, not counted).
 *   PAGENULL_MCP_LIVE=1 PAGENULL_API_KEY=… pnpm --filter @pagenull/mcp test
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configFromEnv } from "../src/api.js";
import { createPagenullServer } from "../src/server.js";

describe.runIf(process.env.PAGENULL_MCP_LIVE === "1")("live API", () => {
  it("render_pdf (test render) returns a real PDF whose receipt verifies with the published key", async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createPagenullServer(configFromEnv()).connect(a);
    const c = new Client({ name: "live-test", version: "1" });
    await c.connect(b);
    const r = (await c.callTool({ name: "render_pdf", arguments: { html: "<h1>MCP live test</h1>", test: true } })) as {
      isError?: boolean;
      content: { text?: string; resource?: { blob: string } }[];
    };
    expect(r.isError, r.content[0].text).toBeFalsy();
    const facts = JSON.parse(r.content[0].text!);
    const pdf = r.content[1].resource!.blob;
    expect(Buffer.from(pdf, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(facts.retention).toBe("none");
    const v = (await c.callTool({ name: "verify_receipt", arguments: { receipt: facts.receipt, pdf_base64: pdf } })) as { content: { text: string }[] };
    expect(JSON.parse(v.content[0].text)).toMatchObject({ valid: true, fileMatches: true });
    const u = (await c.callTool({ name: "get_usage", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    expect(u.isError).toBeFalsy();
    await c.close();
  }, 60_000);
});
