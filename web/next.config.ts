import type { NextConfig } from "next";
import { join } from "node:path";

const config: NextConfig = {
  // MCPal (the library in the repo root) and its native SQLite driver run as plain Node modules.
  serverExternalPackages: ["mcpal", "better-sqlite3", "@modelcontextprotocol/sdk"],
  // The app imports ../dist and ../docs, so trace files from the repo root.
  outputFileTracingRoot: join(__dirname, ".."),
  outputFileTracingIncludes: {
    "/api/policy/compile": ["../dist/policy-ai.js", "../dist/policy.js", "../dist/money.js", "../package.json", "../node_modules/zod/**/*"],
    "/api/policy/check": ["../dist/policy-ai.js", "../dist/policy.js", "../dist/money.js", "../package.json", "../node_modules/zod/**/*"],
    "/api/run": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/mcp": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/api/remote/log": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/api/remote/approval": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/ucp/v1/checkout-sessions": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/ucp/v1/checkout-sessions/[id]": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/ucp/v1/checkout-sessions/[id]/complete": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/ucp/v1/checkout-sessions/[id]/cancel": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/ucp/v1/orders/[id]": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/ucp/v1/orders/[id]/[action]": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/api/commerce/log": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/api/commerce/run": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/commerce/orders/[id]": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/commerce": ["../docs/ucp-conformance.json", "../docs/agentic-commerce-proof.json"],
    "/acp/checkout_sessions": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/acp/checkout_sessions/[id]": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/acp/checkout_sessions/[id]/complete": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/acp/checkout_sessions/[id]/cancel": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/api/ucp/discovery": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
    "/r/[ns]/paypal/return": ["../dist/**/*", "../mcpal.policy.json", "../node_modules/better-sqlite3/**/*", "../node_modules/bindings/**/*", "../node_modules/file-uri-to-path/**/*"],
  },
  outputFileTracingExcludes: {
    "*": ["../bench/**/*", "../test/**/*", "../web/node_modules/mcpal/web/**/*"],
  },
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/.well-known/ucp", destination: "/api/ucp/discovery" }];
  },
};

export default config;
