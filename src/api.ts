/**
 * A thin client for the public pagenull API (https://pagenull.dev/docs/api). Every MCP tool is one call here.
 * The key is only ever put in the Authorization header: never logged, never returned in a result.
 */

export const DEFAULT_API_BASE = "https://api.pagenull.dev";

export interface ApiConfig {
  /** The user's own key (PAGENULL_API_KEY). Optional: verify_receipt works without one. */
  apiKey?: string;
  /** PAGENULL_API_BASE, default https://api.pagenull.dev. */
  apiBase: string;
  /** For tests. */
  fetch?: typeof fetch;
}

/** An error the API answered with: its status, code and message, passed to the agent as they are. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const apiBase = (env.PAGENULL_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/+$/, "");
  return { apiKey: env.PAGENULL_API_KEY?.trim() || undefined, apiBase };
}

export async function call(cfg: ApiConfig, method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<ApiResponse> {
  if (auth && !cfg.apiKey) {
    throw new ApiError(401, "unauthorized", "PAGENULL_API_KEY isn't set. Add your key to this MCP server's environment (get one at https://pagenull.dev/signup).");
  }
  const headers: Record<string, string> = { "user-agent": "pagenull-mcp" };
  if (auth && cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await (cfg.fetch ?? fetch)(`${cfg.apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(0, "network_error", `Couldn't reach ${cfg.apiBase}: ${(e as Error).message}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    let code = "http_error";
    let message = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(buf.toString("utf8")) as { error?: { code?: string; message?: string } };
      if (j.error?.code) code = j.error.code;
      if (j.error?.message) message = j.error.message;
    } catch {}
    throw new ApiError(res.status, code, message);
  }
  return { status: res.status, headers: res.headers, body: buf };
}
