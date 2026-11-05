#!/usr/bin/env node
/**
 * pagenull MCP server over stdio, for Claude Desktop, Claude Code, Cursor, VS Code and other MCP clients.
 *   PAGENULL_API_KEY   your API key (required for everything except verify_receipt)
 *   PAGENULL_API_BASE  optional, default https://api.pagenull.dev
 * stdout carries the protocol only; this process logs nothing, and never the key.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv } from "./api.js";
import { createPagenullServer } from "./server.js";

const server = createPagenullServer(configFromEnv());
await server.connect(new StdioServerTransport());
