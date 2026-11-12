// Remote MCP endpoint: Streamable HTTP, stateless (JSON responses, no session id), one isolated
// MCPal ledger per demo key, real PayPal sandbox. Connect with
//   claude mcp add --transport http mcpal "https://mcpal.vercel.app/mcp?key=<demo key>"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "mcpal";
import {
  IP_CALLS_PER_HOUR,
  KEY_CALLS_PER_HOUR,
  SITE_URL,
  buildRemoteContext,
  clientIp,
  demoGuard,
  FORGOTTEN_MSG,
  disposeRemote,
  exportRemote,
  loadCreds,
  keyFrom,
  loadState,
  nsOf,
  refused,
  saveState,
  takeIp,
  takeKey,
  withLock,
  type RemoteState,
} from "@/lib/remote";
import type { ByoCreds } from "@/lib/byo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
};

function rpcError(status: number, message: string, id: unknown = null): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id }, { status, headers: CORS });
}

const NO_KEY = `MCPal needs a demo key: use ${SITE_URL}/mcp?key=<your key> or the header "Authorization: Bearer <your key>". Get a key at ${SITE_URL}/install.`;

export async function OPTIONS(): Promise<Response> {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(req: Request): Promise<Response> {
  // Stateless server: no server-initiated SSE stream. Browsers get a pointer to the install page.
  if ((req.headers.get("accept") ?? "").includes("text/html")) return Response.redirect(`${SITE_URL}/install`, 302);
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }), {
    status: 405,
    headers: { ...CORS, allow: "POST", "content-type": "application/json" },
  });
}

export async function DELETE(): Promise<Response> {
  return new Response(null, { status: 405, headers: { ...CORS, allow: "POST" } });
}

export async function POST(req: Request): Promise<Response> {
  const key = keyFrom(req);
  if (!key) return rpcError(401, NO_KEY);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(400, "Parse error: body must be JSON-RPC.");
  }
  const msgs = (Array.isArray(body) ? body : [body]) as { method?: string }[];
  const hasCall = msgs.some((m) => m?.method === "tools/call");
  const ns = nsOf(key);
  const ip = clientIp(req);

  const serve = async (state: RemoteState, creds?: ByoCreds): Promise<{ res: Response; next: RemoteState }> => {
    const b = buildRemoteContext(state, creds);
    try {
      const server = createMcpServer(b.ctx, {
        guard: async (name, args) => {
          const k = takeKey(state);
          if (!k.ok)
            return refused(name, args, "rate_limited", `This demo key reached ${KEY_CALLS_PER_HOUR} tool calls in the last hour. Try again in about ${k.retryInMin} min, or get a new key at ${SITE_URL}/install.`, "Wait, then call again.");
          const i = await takeIp(ip);
          if (!i.ok) return refused(name, args, "rate_limited", `This network reached ${IP_CALLS_PER_HOUR} tool calls in the last hour. Try again in about ${i.retryInMin} min.`, "Wait, then call again.");
          const g = demoGuard(name, args);
          return g ? refused(name, args, "demo_guard", g, "Fix the arguments or tell the user.") : undefined;
        },
      });
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      const res = await transport.handleRequest(req, { parsedBody: body });
      // The JSON response resolves after every tool handler has finished, so the ledger is final here.
      const next = { ...exportRemote(state, b), calls: state.calls };
      await server.close();
      return { res, next };
    } finally {
      disposeRemote(b);
    }
  };

  try {
    let res: Response;
    if (!hasCall) {
      // initialize, tools/list, ping, notifications: no state needed, nothing stored.
      res = (await serve(await loadEmpty(ns))).res;
    } else {
      // A key made with "Use your own sandbox" runs on the developer's own sandbox app; any other key on the shared one.
      const kc = await loadCreds(ns);
      if (kc.kind === "forgotten") return rpcError(403, FORGOTTEN_MSG);
      if (kc.kind === "shared" && (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)) return rpcError(503, "The hosted demo is missing its PayPal sandbox credentials.");
      const creds = kc.kind === "byo" ? kc.creds : undefined;
      res = await withLock(ns, async () => {
        const state = await loadState(ns);
        const out = await serve(state, creds);
        await saveState(out.next);
        return out.res;
      });
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    return rpcError(500, (err as Error).message || "Server error.");
  }
}

async function loadEmpty(ns: string): Promise<RemoteState> {
  return { v: 1, ns, createdAt: new Date().toISOString(), installId: "listing", ledgerId: "listing", refs: [], spend: [], log: [], approvals: [], calls: [] };
}
