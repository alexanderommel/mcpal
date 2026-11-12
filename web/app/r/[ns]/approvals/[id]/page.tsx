import { Nav } from "@/components/Nav";
import Approve from "./Approve";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approve a payment — MCPal", robots: { index: false } };

export default async function ApprovalPage({ params }: { params: Promise<{ ns: string; id: string }> }) {
  const { ns, id } = await params;
  return (
    <>
      <Nav />
      <main className="wrap" style={{ maxWidth: 640 }}>
        <section>
          <h2>Human approval</h2>
          <p className="sub">
            Your agent asked MCPal to move money above a policy limit, or to pay someone never paid before. Nothing was sent to PayPal. Approve it here, then ask the
            agent to call the same tool again.
          </p>
          <Approve ns={ns} id={id} />
        </section>
      </main>
    </>
  );
}
