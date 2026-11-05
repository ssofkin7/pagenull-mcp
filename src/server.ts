import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, call, type ApiConfig, type ApiResponse } from "./api.js";
import { fetchKeys, sha256Hex, verifyReceipt } from "./verify.js";

/**
 * The pagenull MCP server. Each tool is one call to the public API (https://pagenull.dev/docs/api).
 * Files come back as base64 in the tool result, or are written to `save_to` on this machine; pagenull keeps
 * no copy either way.
 */

export const SERVER_INFO = { name: "pagenull", version: "0.1.0" };

/** The tools, in the order they're registered. The docs page lists the same names (a test checks). */
export const TOOL_NAMES = ["render_pdf", "screenshot", "list_templates", "render_template", "verify_receipt", "get_usage"] as const;

const length = z.string().describe('A length with a unit, e.g. "12mm", "0.5in", "1cm", "24px".');
const saveTo = z
  .string()
  .optional()
  .describe("Write the file to this path on this machine instead of returning it as base64. The folder must exist. Use it for large files.");
const overwrite = z.boolean().optional().describe("Replace the file at save_to if it already exists. Default false.");
const test = z.boolean().optional().describe("Test render: watermarked, free, not counted against the quota.");
const filename = z.string().optional().describe("File name for the Content-Disposition header.");
const options = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Any other option from https://pagenull.dev/docs/api (e.g. waitFor, timeoutMs, scale, headerHtml). Checked by the API.");

/** What every render returns besides the file: ids, receipt, warnings and quota, as the API sent them. */
function renderFacts(res: ApiResponse) {
  const h = (n: string) => res.headers.get(n);
  const num = (n: string) => (h(n) === null ? undefined : Number(h(n)));
  return {
    renderId: h("pagenull-render-id"),
    contentType: (h("content-type") ?? "").split(";")[0],
    pages: num("pagenull-pages"),
    bytes: res.body.byteLength,
    sha256: sha256Hex(res.body),
    receipt: h("pagenull-receipt"),
    retention: h("pagenull-retention"),
    region: h("pagenull-region"),
    warnings: (h("pagenull-warnings") ?? "").split(",").map((w) => w.trim()).filter(Boolean),
    renderMs: num("x-render-ms"),
    quota: h("x-quota-used") === null ? undefined : { used: num("x-quota-used"), limit: num("x-quota-limit") },
  };
}

const text = (value: unknown): CallToolResult["content"][number] => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });

/** The API's own error, passed on so the agent can fix the request and retry. */
function errorResult(e: unknown): CallToolResult {
  if (e instanceof ApiError) {
    return {
      isError: true,
      content: [text({ error: { status: e.status, code: e.code, message: e.message, docs: "https://pagenull.dev/docs/api#errors" } })],
    };
  }
  return { isError: true, content: [text({ error: { code: "mcp_error", message: (e as Error).message } })] };
}

async function fileResult(res: ApiResponse, saveToPath?: string, replace = false): Promise<CallToolResult> {
  const facts = renderFacts(res);
  if (saveToPath) {
    const target = path.resolve(saveToPath);
    if (!existsSync(path.dirname(target))) throw new Error(`The folder ${path.dirname(target)} doesn't exist.`);
    if (!replace && existsSync(target)) throw new Error(`${target} already exists. Pass overwrite: true to replace it.`);
    await writeFile(target, res.body);
    return { content: [text({ ...facts, savedTo: target, note: "Written to disk; not returned as base64. pagenull kept no copy." })] };
  }
  const data = res.body.toString("base64");
  const media: CallToolResult["content"][number] = facts.contentType.startsWith("image/")
    ? { type: "image", data, mimeType: facts.contentType }
    : {
        type: "resource",
        resource: { uri: `pagenull:render/${facts.renderId ?? "output"}`, mimeType: facts.contentType || "application/pdf", blob: data },
      };
  return { content: [text({ ...facts, note: "The file is in this result as base64; pagenull kept no copy." }), media] };
}

/** Removes undefined fields, so the API sees only what the agent set. */
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function createPagenullServer(cfg: ApiConfig): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "render_pdf",
    {
      title: "Render a PDF",
      description:
        "Turn HTML or a public URL into a PDF with pagenull. Send exactly one of html or url. Returns the PDF (base64, or written to save_to), " +
        "its signed receipt, warnings and quota. Nothing is stored by pagenull.",
      inputSchema: {
        html: z.string().optional().describe("The HTML document to render (up to 5 MB)."),
        url: z.string().optional().describe("A public http(s) URL to load. Private and internal addresses are refused."),
        format: z.enum(["A4", "Letter", "Legal", "A3", "A5", "Tabloid"]).optional().describe("Paper size. Default A4."),
        landscape: z.boolean().optional(),
        margin: z.object({ top: length.optional(), right: length.optional(), bottom: length.optional(), left: length.optional() }).optional(),
        printBackground: z.boolean().optional().describe("Print background colours and images. Default true."),
        pageNumbers: z.union([z.boolean(), z.string()]).optional().describe('true for "Page {page} of {pages}", or your own text with {page} and {pages}.'),
        test,
        filename,
        options,
        save_to: saveTo,
        overwrite,
      },
    },
    async ({ save_to, overwrite: replace, options: extra, ...fields }) => {
      try {
        const res = await call(cfg, "POST", "/v1/pdf", { ...(extra ?? {}), ...clean(fields) });
        return await fileResult(res, save_to, replace);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Take a screenshot",
      description: "Render HTML or a public URL to a PNG or JPEG image. Send exactly one of html or url. Returns the image (or writes it to save_to). Nothing is stored by pagenull.",
      inputSchema: {
        html: z.string().optional(),
        url: z.string().optional(),
        width: z.number().int().optional().describe("Viewport width in CSS px (100–4000). Default 1280."),
        height: z.number().int().optional().describe("Viewport height in CSS px (100–4000). Default 800."),
        fullPage: z.boolean().optional().describe("Capture the whole scrollable page."),
        type: z.enum(["png", "jpeg"]).optional(),
        quality: z.number().int().optional().describe("JPEG quality, 1–100."),
        deviceScaleFactor: z.number().optional().describe("1–3. Use 2 for sharp images."),
        test,
        options,
        save_to: saveTo,
        overwrite,
      },
    },
    async ({ save_to, overwrite: replace, options: extra, ...fields }) => {
      try {
        const res = await call(cfg, "POST", "/v1/screenshot", { ...(extra ?? {}), ...clean(fields) });
        return await fileResult(res, save_to, replace);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description: "List your saved templates (ids and names) and the built-in ones (invoice, receipt, certificate, report).",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const res = await call(cfg, "GET", "/v1/templates");
        return { content: [text(JSON.parse(res.body.toString("utf8")))] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "render_template",
    {
      title: "Render a template",
      description: "Render a saved or built-in template with JSON data into a PDF. Returns it like render_pdf.",
      inputSchema: {
        id: z.string().describe('A template id from list_templates, e.g. "tpl_…" or "invoice".'),
        data: z.record(z.string(), z.unknown()).optional().describe("The values the template uses."),
        options: z.record(z.string(), z.unknown()).optional().describe("Page options that override the template's own (format, margin, …)."),
        test,
        filename,
        save_to: saveTo,
        overwrite,
      },
    },
    async ({ id, save_to, overwrite: replace, ...fields }) => {
      try {
        const res = await call(cfg, "POST", `/v1/templates/${encodeURIComponent(id)}/render`, clean(fields));
        return await fileResult(res, save_to, replace);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "verify_receipt",
    {
      title: "Verify a receipt",
      description:
        "Check a pagenull receipt's Ed25519 signature with pagenull's published key, and optionally that a file is the exact output it describes. " +
        "Give the file as file_path, pdf_base64 or its sha256. The file never leaves this machine.",
      inputSchema: {
        receipt: z.string().describe("The pagenull-receipt value (v1.…)."),
        file_path: z.string().optional().describe("A file on this machine to check against the receipt."),
        pdf_base64: z.string().optional().describe("The file as base64, if it isn't on disk."),
        sha256: z.string().optional().describe("The file's SHA-256 (hex), if you already have it."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ receipt, file_path, pdf_base64, sha256 }) => {
      try {
        let hash = sha256 ?? null;
        if (file_path) {
          const p = path.resolve(file_path);
          if (!(await stat(p)).isFile()) throw new Error(`${p} isn't a file`);
          hash = sha256Hex(await readFile(p));
        } else if (pdf_base64) {
          hash = sha256Hex(Buffer.from(pdf_base64, "base64"));
        }
        const result = verifyReceipt(receipt, await fetchKeys(cfg), hash);
        return { content: [text(result)] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "get_usage",
    {
      title: "Get usage",
      description: "This month's render count, limit, what's left and the rate limit for your plan.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const res = await call(cfg, "GET", "/v1/usage");
        return { content: [text(JSON.parse(res.body.toString("utf8")))] };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}
