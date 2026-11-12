// Order permalink (UCP order_confirmation.permalink_url) for the demo merchant.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Nav } from "@/components/Nav";
import { getOrder, UcpError } from "@/lib/commerce/ucp";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Order — Coffee Club Supply (MCPal demo)", robots: { index: false } };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let o: any;
  try {
    o = (await getOrder(id)).body;
  } catch (err) {
    if (err instanceof UcpError && err.status === 404) notFound();
    throw err;
  }
  const st = o["dev.mcpal.settlement"];
  const money = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toFixed(2)}`;
  return (
    <>
      <Nav current="commerce" />
      <main className="wrap" id="main-content">
        <div style={{ padding: "28px 0 4px" }}>
          <div className="eyebrow">Coffee Club Supply · PayPal sandbox</div>
          <h1 className="page-h1">{o.label}</h1>
          <p className="small mono">
            order {o.id} · checkout {o.checkout_id}
          </p>
        </div>
        <div className="scroll">
          <table className="tbl">
            <tbody>
              {o.line_items.map((l: any) => (
                <tr key={l.id}>
                  <td>{l.item.title}</td>
                  <td className="mono">x{l.quantity.total}</td>
                  <td className="mono">{money(l.totals.find((t: any) => t.type === "total").amount)}</td>
                </tr>
              ))}
              {o.totals.map((t: any) => (
                <tr key={t.type}>
                  <th>{t.display_text ?? t.type}</th>
                  <td />
                  <td className="mono">{money(t.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {st ? (
          <>
            <h2 className="h-sm">Settled on PayPal by MCPal</h2>
            <p className="small">
              mode {st.mode} · MCPal orderRef <code>{st.mcpal_order_ref}</code> · state {st.state}
            </p>
            <div className="scroll">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>MCPal verb</th>
                    <th>State</th>
                    <th>PayPal ids</th>
                  </tr>
                </thead>
                <tbody>
                  {st.events.map((e: any, i: number) => (
                    <tr key={i}>
                      <td className="mono">{e.at}</td>
                      <td className="mono">{e.verb}</td>
                      <td>
                        <span className={e.ok ? "pill" : "pill bad"}>{e.state}</span>
                      </td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {Object.entries(e.paypal ?? {}).map(([k, v]) => (
                          <div key={k}>
                            {k}: {Array.isArray(v) ? v.join(", ") : String(v)}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </main>
    </>
  );
}
