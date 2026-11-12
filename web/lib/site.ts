// Public endpoints of the hosted MCPal demo. Shared by the landing and /install.
export const SITE_URL = "https://mcpal.app";
export const MCP_BASE = `${SITE_URL}/mcp`;
export const REPO_URL = "https://github.com/alexanderommel/mcpal";

export function mcpUrl(key: string): string {
  return key ? `${MCP_BASE}?key=${encodeURIComponent(key)}` : `${MCP_BASE}?key=<your-demo-key>`;
}

/** Base64 of a UTF-8 string, in the browser or on the server. */
function b64(s: string): string {
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(s)));
  return Buffer.from(s, "utf8").toString("base64");
}

// Cursor install deeplink, per https://cursor.com/docs/context/mcp/install-links:
//   cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$BASE64_ENCODED_CONFIG
// where config is the server object from mcp.json (here a remote server: { "url": ... }), JSON-stringified then base64-encoded.
export function cursorLink(key: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=mcpal&config=${encodeURIComponent(b64(JSON.stringify({ url: mcpUrl(key) })))}`;
}

// VS Code install link, per https://code.visualstudio.com/api/extension-guides/ai/mcp:
//   vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, ...config }))}
// (vscode-insiders: for Insiders). The link opens the server's details so the user reviews it before installing.
export function vscodeLink(key: string, insiders = false): string {
  return `${insiders ? "vscode-insiders" : "vscode"}:mcp/install?${encodeURIComponent(JSON.stringify({ name: "mcpal", type: "http", url: mcpUrl(key) }))}`;
}

export function claudeCodeCmd(key: string): string {
  return `claude mcp add --transport http mcpal "${mcpUrl(key)}"`;
}
