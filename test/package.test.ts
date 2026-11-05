/**
 * The package as it would be published (FEEDBACK-26): npm fields, the MIT licence, the MCP registry's server.json,
 * and exactly which files the tarball holds.
 */
import { describe, expect, it } from "vitest";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";

// ajv-formats is CommonJS with a default export; require() types it cleanly under NodeNext.
const addFormats = createRequire(import.meta.url)("ajv-formats") as (ajv: Ajv2020) => Ajv2020;
import { SERVER_INFO } from "../src/server.js";

const ROOT = path.resolve(__dirname, "..");
const REPO = path.resolve(ROOT, "../..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const server = JSON.parse(readFileSync(path.join(ROOT, "server.json"), "utf8"));

describe("package.json", () => {
  it("has what npm and the MCP registry need", () => {
    expect(pkg).toMatchObject({
      name: "@pagenull/mcp",
      version: "0.1.0",
      mcpName: "dev.pagenull/mcp",
      license: "MIT",
      homepage: "https://pagenull.dev/docs/ai-agents",
      bin: { "pagenull-mcp": "dist/index.js" },
      engines: { node: ">=18" },
      publishConfig: { access: "public" },
    });
    expect(pkg.description.length).toBeGreaterThan(40);
    expect(pkg.keywords).toEqual(expect.arrayContaining(["mcp", "pdf", "html-to-pdf"]));
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    // The repository is private: nothing links to it.
    expect(pkg.repository).toBeUndefined();
    expect(JSON.stringify(pkg)).not.toMatch(/github\.com/);
  });

  it("the version is the same everywhere", () => {
    expect(SERVER_INFO.version).toBe(pkg.version);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });
});

describe("licence", () => {
  it("MIT, copyright 2026 Stefan Sofkin, for this package only", () => {
    const text = readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    expect(text).toMatch(/^MIT License/);
    expect(text).toContain("Copyright (c) 2026 Stefan Sofkin");
    for (const p of ["LICENSE", "LICENSE.md", "apps/web/LICENSE", "packages/renderer/LICENSE"]) expect(existsSync(path.join(REPO, p)), p).toBe(false);
    for (const p of ["apps/web/package.json", "packages/renderer/package.json"]) {
      expect(JSON.parse(readFileSync(path.join(REPO, p), "utf8")).license ?? null, p).not.toBe("MIT");
    }
  });
});

describe("server.json for the official MCP registry", () => {
  it("is valid against the registry's schema (2025-12-11)", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(path.join(ROOT, "test/fixtures/server.schema.2025-12-11.json"), "utf8"));
    delete schema.$schema;
    const valid = ajv.validate(schema, server);
    expect(ajv.errorsText(), "server.json").toBe("No errors");
    expect(valid).toBe(true);
    expect(server.$schema).toBe("https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  });

  it("matches the npm package: name = mcpName, identifier = package name, the key is a secret", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({ registryType: "npm", identifier: pkg.name, transport: { type: "stdio" } });
    expect(server.packages[0].environmentVariables.find((v: { name: string }) => v.name === "PAGENULL_API_KEY")).toMatchObject({ isRequired: true, isSecret: true });
    expect(JSON.stringify(server)).not.toMatch(/github\.com/);
  });
});

describe("what npm publish would upload", () => {
  it("only the built code, the README, the licence and package.json: no tests, sources, maps or secrets", () => {
    execFileSync(process.execPath, [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", path.join(ROOT, "tsconfig.build.json")], { stdio: "pipe" });
    const out = execSync("npm pack --dry-run --json --ignore-scripts", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const files = (JSON.parse(out)[0].files as { path: string }[]).map((f) => f.path.replace(/\\/g, "/")).sort();
    expect(files).toEqual(
      [
        "LICENSE",
        "README.md",
        "dist/api.d.ts",
        "dist/api.js",
        "dist/index.d.ts",
        "dist/index.js",
        "dist/server.d.ts",
        "dist/server.js",
        "dist/verify.d.ts",
        "dist/verify.js",
        "package.json",
      ].sort(),
    );
    for (const f of files) expect(f).not.toMatch(/\.map$|test|\.env|\.ts$(?<!\.d\.ts$)|server\.json/);
    expect(readFileSync(path.join(ROOT, "dist/index.js"), "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  }, 60_000);
});
