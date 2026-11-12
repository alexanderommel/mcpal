"use client";
// Install MCPal into your own agent. Every snippet is pre-filled with this browser's demo key.
// Sources checked 2026-11-12:
// - Cursor deeplink: https://cursor.com/docs/context/mcp/install-links
// - VS Code install link: https://code.visualstudio.com/api/extension-guides/ai/mcp
// - claude.ai custom connectors: https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp
import Link from "next/link";
import { useState } from "react";
import { resetDemoKey, useDemoKey } from "./DemoKey";
import {
  MCP_BASE,
  REPO_URL,
  claudeCodeCmd,
  cursorLink,
  mcpUrl,
  vscodeLink,
} from "@/lib/site";

export function CopyButton({
  text,
  label = "Copy",
}: {
  text: string;
  label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small ghost copy"
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is selectable */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function CodeBox({ code }: { code: string }) {
  return (
    <div className="codebox">
      <pre className="mono">{code}</pre>
      <CopyButton text={code} />
    </div>
  );
}

function KeyLine({ k }: { k: string }) {
  return (
    <p className="small keyline">
      Your demo key: <code>{k || "…"}</code> (kept in this browser; it is your
      own ledger).{" "}
      <button type="button" className="linkish" onClick={resetDemoKey}>
        New key
      </button>
    </p>
  );
}

/** Compact install row for the landing hero. */
export function InstallCompact() {
  const k = useDemoKey();
  return (
    <div className="install-compact">
      <div className="compact-code-label">
        <span className="eyebrow-s">ADD TO CLAUDE CODE</span>
        <span className="small">Remote · No local setup</span>
      </div>
      <CodeBox code={claudeCodeCmd(k)} />
      <div className="btns">
        <a
          className="btn"
          href={k ? cursorLink(k) : undefined}
          aria-disabled={!k}
        >
          Add to Cursor <span aria-hidden="true">↗</span>
        </a>
        <a
          className="btn ghost"
          href={k ? vscodeLink(k) : undefined}
          aria-disabled={!k}
        >
          Install in VS Code <span aria-hidden="true">↗</span>
        </a>
        <Link className="compact-more" href="/install">
          More clients →
        </Link>
      </div>
      <Link className="judge-text-link" href="/judge">
        Try it in the judge console <span aria-hidden="true">→</span>
      </Link>
      <details className="compact-session">
        <summary>Your session</summary>
        <KeyLine k={k} />
      </details>
    </div>
  );
}

const TABS = [
  "Claude Code",
  "Cursor",
  "VS Code",
  "claude.ai",
  "ChatGPT / other",
  "JSON config",
  "Local from source",
] as const;
type Tab = (typeof TABS)[number];

export function Install() {
  const k = useDemoKey();
  const [tab, setTab] = useState<Tab>("Claude Code");
  const url = mcpUrl(k);
  const jsonUrl = JSON.stringify({ mcpServers: { mcpal: { url } } }, null, 2);
  const jsonTyped = JSON.stringify(
    { mcpServers: { mcpal: { type: "http", url } } },
    null,
    2,
  );
  const jsonHeader = JSON.stringify(
    {
      mcpServers: {
        mcpal: {
          type: "http",
          url: MCP_BASE,
          headers: { Authorization: `Bearer ${k || "<your-demo-key>"}` },
        },
      },
    },
    null,
    2,
  );
  const local = `git clone ${REPO_URL}.git && cd mcpal && npm install
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node dist/server.js          # stdio
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... node dist/server.js --http   # Streamable HTTP on :8787/mcp`;
  const localJson = JSON.stringify(
    {
      mcpServers: {
        mcpal: {
          command: "node",
          args: ["/path/to/mcpal/dist/server.js"],
          env: { PAYPAL_CLIENT_ID: "...", PAYPAL_CLIENT_SECRET: "..." },
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="install">
      <div className="tabs" role="tablist" aria-label="Choose your MCP client">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            id={`client-${TABS.indexOf(t)}`}
            aria-controls="install-client-panel"
            className={`tab${tab === t ? " on" : ""}`}
            onClick={() => setTab(t)}
            onKeyDown={(e) => {
              const offset = ["ArrowRight", "ArrowDown"].includes(e.key)
                ? 1
                : ["ArrowLeft", "ArrowUp"].includes(e.key)
                  ? -1
                  : 0;
              if (!offset && e.key !== "Home" && e.key !== "End") return;
              e.preventDefault();
              const i =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? TABS.length - 1
                    : (TABS.indexOf(t) + offset + TABS.length) % TABS.length;
              setTab(TABS[i]);
              document.getElementById(`client-${i}`)?.focus();
            }}
          >
            {t}
          </button>
        ))}
      </div>
      <div
        className="tabpanel"
        role="tabpanel"
        id="install-client-panel"
        aria-labelledby={`client-${TABS.indexOf(tab)}`}
        tabIndex={0}
      >
        <div className="install-panel-heading">
          <span className="eyebrow-s">
            REMOTE MCP /{" "}
            {tab === "Local from source" ? "SELF-HOSTED" : "STREAMABLE HTTP"}
          </span>
          <h2>{tab}</h2>
        </div>
        {tab === "Claude Code" && (
          <>
            <p>
              Run this in a terminal, then start <code>claude</code> and ask it
              to take a deposit.
            </p>
            <CodeBox code={claudeCodeCmd(k)} />
            <p className="small">
              Check it with <code>claude mcp list</code>. Non-interactive:{" "}
              <code>
                claude -p &quot;Take a $40 deposit on a $120 order from the card
                on file and hold the rest&quot;
              </code>
              .
            </p>
          </>
        )}
        {tab === "Cursor" && (
          <>
            <p>One click opens Cursor and asks you to confirm the server.</p>
            <p>
              <a className="btn" href={k ? cursorLink(k) : undefined}>
                Add to Cursor
              </a>
            </p>
            <p className="small">
              Or paste this into <code>~/.cursor/mcp.json</code>:
            </p>
            <CodeBox code={jsonUrl} />
            <p className="small">Deeplink:</p>
            <CodeBox code={cursorLink(k)} />
          </>
        )}
        {tab === "VS Code" && (
          <>
            <p>
              Opens the MCP server details in VS Code (Copilot agent mode) so
              you can review and install.
            </p>
            <div className="btns">
              <a className="btn" href={k ? vscodeLink(k) : undefined}>
                Install in VS Code
              </a>
              <a
                className="btn ghost"
                href={k ? vscodeLink(k, true) : undefined}
              >
                VS Code Insiders
              </a>
            </div>
            <p className="small">
              Or add it to <code>.vscode/mcp.json</code> under{" "}
              <code>servers</code>:
            </p>
            <CodeBox
              code={JSON.stringify(
                { servers: { mcpal: { type: "http", url } } },
                null,
                2,
              )}
            />
          </>
        )}
        {tab === "claude.ai" && (
          <>
            <ol className="steps">
              <li>
                Pro / Max: open <b>Customize → Connectors</b>, click{" "}
                <b>+ Add</b>, then <b>Add custom connector</b>. (Team /
                Enterprise owners:{" "}
                <b>Organization settings → Connectors → Add → Custom → Web</b>.)
              </li>
              <li>
                Name it <b>MCPal</b> and paste this URL, then <b>Continue</b>:
              </li>
            </ol>
            <CodeBox code={url} />
            <ol className="steps" start={3}>
              <li>
                Authentication: <b>No sign in</b> (the key is in the URL). Click{" "}
                <b>Add</b>.
              </li>
              <li>
                In a chat, click <b>+ → Connectors</b> and switch MCPal on.
              </li>
            </ol>
          </>
        )}
        {tab === "ChatGPT / other" && (
          <>
            <p>
              Use an MCP-capable client that accepts a remote Streamable HTTP
              server. Client availability and account requirements vary.
            </p>
            <CodeBox code={url} />
            <p className="small">
              Name: <b>MCPal</b>. Authentication is carried by your demo key in
              the URL. For clients supporting headers, use the JSON config tab.
            </p>
          </>
        )}
        {tab === "JSON config" && (
          <>
            <p>
              For clients that take a remote server URL (Cursor, Windsurf,
              Claude Desktop with remote support, most agent SDKs):
            </p>
            <CodeBox code={jsonUrl} />
            <p className="small">
              Clients that need the transport spelled out:
            </p>
            <CodeBox code={jsonTyped} />
            <p className="small">Key in a header instead of the URL:</p>
            <CodeBox code={jsonHeader} />
          </>
        )}
        {tab === "Local from source" && (
          <>
            <p>
              Run MCPal yourself with your own PayPal app credentials
              (developer.paypal.com). Node 22.
            </p>
            <CodeBox code={local} />
            <p className="small">As a stdio server in any MCP client config:</p>
            <CodeBox code={localJson} />
          </>
        )}
        <ol className="install-next-steps" aria-label="Connection checklist">
          <li>
            <span>01</span>
            <div>
              <b>Add the server</b>
              <p>
                Use the snippet or the install button in your chosen client.
              </p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <b>Check the connection</b>
              <p>Confirm MCPal is enabled and its eight verbs are available.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <b>Give it an intent</b>
              <p>
                “Take a $40 deposit on a $120 order and hold the rest until
                delivery.”
              </p>
            </div>
          </li>
        </ol>
      </div>
      <KeyLine k={k} />
    </div>
  );
}

export function Limits() {
  return (
    <ul className="limits">
      <li>
        Bring your own PayPal sandbox app above, or use the shared one.
      </li>
      <li>
        Each demo key is its own isolated ledger, idempotency scope and
        approvals.
      </li>
      <li>30 tool calls per hour per key, 60 per hour per IP.</li>
      <li>Amounts up to $500, USD only.</li>
      <li>
        Payouts only to PayPal sandbox addresses (…@personal.example.com).
      </li>
      <li>
        10 connect attempts per hour per IP for &ldquo;Use your own
        sandbox&rdquo;.
      </li>
      <li>
        <code>card_on_file</code> charges PayPal&apos;s published test card.
      </li>
      <li>
        When a rule needs a human, the tool returns an approval link on
        mcpal.vercel.app; open it in the browser that holds your key.
      </li>
    </ul>
  );
}
