/**
 * The pagenull MCP server against a mocked API, through a real MCP client (in-memory transport), plus one run
 * over stdio as an MCP client starts it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPagenullServer, TOOL_NAMES } from "../src/server.js";
import { sha256Hex } from "../src/verify.js";

const KEY = "pm_live_TESTKEY0123456789abcdefghijklmn";
const API = "https://api.example.test";
const PDF = Buffer.from("%PDF-1.7\nfake pdf body\n%%EOF");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

// A signing key like the server's, so receipts can be checked end to end.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as { x: string };
function receiptFor(body: Buffer) {
  const payload = Buffer.from(
    JSON.stringify({ v: 1, kid: "k1", render_id: "r-1", sha256: sha256Hex(body), timestamp: "2026-11-05T10:00:00Z", region: "hetzner-helsinki", renderer: "sha256:x", stored: false }),
  ).toString("base64url");
  return `v1.${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
}

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}
const seen: Seen[] = [];

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  seen.push({ method: init?.method ?? "GET", path: url.pathname, auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const file = (b: Buffer, type: string) =>
    new Response(new Uint8Array(b), {
      status: 200,
      headers: {
        "content-type": type,
        "pagenull-render-id": "r-1",
        "pagenull-receipt": receiptFor(b),
        "pagenull-retention": "none",
        "pagenull-region": "hetzner-helsinki",
        "pagenull-pages": "1",
        "pagenull-warnings": "content_overflow, canvas_lowres",
        "x-render-ms": "120",
        "x-quota-used": "7",
        "x-quota-limit": "100",
      },
    });
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  switch (url.pathname) {
    case "/v1/pdf":
      return body.url === "http://10.0.0.1/" ? json(422, { error: { code: "blocked_url", message: "URL blocked: address is not public", docs: "/docs/api#errors" } }) : file(PDF, "application/pdf");
    case "/v1/screenshot":
      return file(PNG, "image/png");
    case "/v1/templates":
      return json(200, { data: [{ id: "tpl_1", name: "Slip" }], builtIn: [{ id: "invoice", name: "Invoice" }] });
    case "/v1/templates/invoice/render":
      return file(PDF, "application/pdf");
    case "/v1/usage":
      return json(200, { period: "2026-11", plan: "free", used: 7, limit: 100, remaining: 93, ratePerMinute: 10 });
    case "/.well-known/pagenull-keys.json":
      return json(200, { keys: [{ kid: "k1", kty: "OKP", crv: "Ed25519", alg: "EdDSA", use: "sig", x: jwk.x }] });
    default:
      return json(404, { error: { code: "not_found", message: "No endpoint" } });
  }
}) as typeof fetch;

let client: Client;
let noKeyClient: Client;
let dir = "";
const results: string[] = [];

async function connect(apiKey?: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createPagenullServer({ apiKey, apiBase: API, fetch: fakeFetch });
  await server.connect(a);
  const c = new Client({ name: "test", version: "1" });
  await c.connect(b);
  return c;
}

async function callTool(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text?: string; data?: string; mimeType?: string; resource?: { blob: string; mimeType: string; uri: string } }[] };
  results.push(JSON.stringify(r));
  return r;
}
const facts = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse(r.content[0].text!);

beforeAll(async () => {
  client = await connect(KEY);
  noKeyClient = await connect(undefined);
  dir = mkdtempSync(path.join(tmpdir(), "pagenull-mcp-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("tools", () => {
  it("lists the six tools, each with a description", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const t of tools) expect(t.description!.length, t.name).toBeGreaterThan(30);
  });

  it("render_pdf: sends only what was set, with the key as a Bearer token, and returns the PDF as base64 with the facts", async () => {
    seen.length = 0;
    const r = await callTool(client, "render_pdf", { html: "<h1>Hi</h1>", format: "A4", margin: { top: "10mm" }, test: true, options: { scale: 0.9 } });
    expect(r.isError).toBeFalsy();
    expect(seen[0]).toEqual({ method: "POST", path: "/v1/pdf", auth: `Bearer ${KEY}`, body: { scale: 0.9, html: "<h1>Hi</h1>", format: "A4", margin: { top: "10mm" }, test: true } });
    const f = facts(r);
    expect(f).toMatchObject({ renderId: "r-1", contentType: "application/pdf", pages: 1, bytes: PDF.byteLength, retention: "none", region: "hetzner-helsinki", renderMs: 120, quota: { used: 7, limit: 100 } });
    expect(f.warnings).toEqual(["content_overflow", "canvas_lowres"]);
    expect(f.receipt).toMatch(/^v1\./);
    expect(f.sha256).toBe(sha256Hex(PDF));
    expect(r.content[1]).toMatchObject({ type: "resource", resource: { mimeType: "application/pdf", uri: "pagenull:render/r-1" } });
    expect(Buffer.from(r.content[1].resource!.blob, "base64")).toEqual(PDF);
  });

  it("render_pdf with save_to: writes the file, returns no base64, and won't overwrite unless asked", async () => {
    const target = path.join(dir, "out.pdf");
    const r = await callTool(client, "render_pdf", { html: "<p>x</p>", save_to: target });
    expect(r.content).toHaveLength(1);
    expect(facts(r).savedTo).toBe(path.resolve(target));
    expect(readFileSync(target)).toEqual(PDF);
    expect(JSON.stringify(r)).not.toContain(PDF.toString("base64"));
    const again = await callTool(client, "render_pdf", { html: "<p>x</p>", save_to: target });
    expect(again.isError).toBe(true);
    expect(again.content[0].text).toContain("already exists");
    expect((await callTool(client, "render_pdf", { html: "<p>x</p>", save_to: target, overwrite: true })).isError).toBeFalsy();
    const noDir = await callTool(client, "render_pdf", { html: "<p>x</p>", save_to: path.join(dir, "missing", "x.pdf") });
    expect(noDir.isError).toBe(true);
  });

  it("screenshot: returns image content", async () => {
    const r = await callTool(client, "screenshot", { url: "https://example.com", width: 800, height: 600 });
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(r.content[1].data!, "base64")).toEqual(PNG);
  });

  it("list_templates, render_template and get_usage call the matching endpoints", async () => {
    seen.length = 0;
    expect(facts(await callTool(client, "list_templates")).builtIn[0].id).toBe("invoice");
    const r = await callTool(client, "render_template", { id: "invoice", data: { number: "INV-1" }, test: true });
    expect(r.isError).toBeFalsy();
    expect(seen[1]).toMatchObject({ method: "POST", path: "/v1/templates/invoice/render", body: { data: { number: "INV-1" }, test: true } });
    expect(facts(await callTool(client, "get_usage"))).toMatchObject({ used: 7, limit: 100 });
  });

  it("passes the API's error code and message through, marked as an error", async () => {
    const r = await callTool(client, "render_pdf", { url: "http://10.0.0.1/" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text!)).toEqual({
      error: { status: 422, code: "blocked_url", message: "URL blocked: address is not public", docs: "https://pagenull.dev/docs/api#errors" },
    });
  });

  it("without PAGENULL_API_KEY: a clear error and no request", async () => {
    seen.length = 0;
    const r = await callTool(noKeyClient, "render_pdf", { html: "<p>x</p>" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text!).error.code).toBe("unauthorized");
    expect(seen).toHaveLength(0);
  });
});

describe("verify_receipt", () => {
  it("checks the signature with the published key (fetched without the API key) and the file", async () => {
    const receipt = receiptFor(PDF);
    const file = path.join(dir, "check.pdf");
    writeFileSync(file, PDF);
    seen.length = 0;
    const ok = facts(await callTool(noKeyClient, "verify_receipt", { receipt, file_path: file }));
    expect(ok).toMatchObject({ valid: true, fileMatches: true, payload: { render_id: "r-1", stored: false } });
    expect(seen[0]).toMatchObject({ path: "/.well-known/pagenull-keys.json", auth: null });
    expect(facts(await callTool(client, "verify_receipt", { receipt, pdf_base64: PDF.toString("base64") })).fileMatches).toBe(true);
    expect(facts(await callTool(client, "verify_receipt", { receipt, pdf_base64: Buffer.from("other").toString("base64") })).fileMatches).toBe(false);
    expect(facts(await callTool(client, "verify_receipt", { receipt })).fileMatches).toBeNull();
  });

  it("an edited receipt is not valid", async () => {
    const [v, p, s] = receiptFor(PDF).split(".");
    const forged = JSON.parse(Buffer.from(p, "base64url").toString());
    forged.region = "elsewhere";
    const r = facts(await callTool(client, "verify_receipt", { receipt: `${v}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${s}` }));
    expect(r).toMatchObject({ valid: false, reason: "The signature doesn't match" });
  });
});

describe("the key stays private", () => {
  it("never appears in any tool result", () => {
    expect(results.length).toBeGreaterThan(10);
    for (const r of results) expect(r).not.toContain(KEY);
  });

  it("the source never logs (stdout is the protocol channel)", () => {
    const src = path.resolve(__dirname, "../src");
    for (const f of readdirSync(src)) expect(readFileSync(path.join(src, f), "utf8"), f).not.toMatch(/console\.(log|info|warn|error|debug)/);
  });
});

describe("over stdio, as an MCP client starts it", () => {
  it("the built package starts with node, lists the tools and answers a call", async () => {
    const root = path.resolve(__dirname, "..");
    // What `npx @pagenull/mcp` runs: the compiled dist/index.js. Build it first.
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "tsconfig.build.json")], { stdio: "pipe" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist/index.js")],
      env: { ...(process.env as Record<string, string>), PAGENULL_API_KEY: "", PAGENULL_API_BASE: "http://127.0.0.1:9" },
      stderr: "pipe",
    });
    const c = new Client({ name: "stdio-test", version: "1" });
    await c.connect(transport);
    try {
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name)).toEqual([...TOOL_NAMES]);
      const r = (await c.callTool({ name: "get_usage", arguments: {} })) as { isError?: boolean; content: { text: string }[] };
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text).error.code).toBe("unauthorized");
    } finally {
      await c.close();
    }
  }, 60_000);
});
