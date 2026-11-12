import Link from "next/link";
import { ThemeToggle } from "./ThemeToggle";

export const GITHUB_URL = "https://github.com/alexanderommel/mcpal";

export function Nav({
  current,
}: {
  current?: "judge" | "proof" | "benchmark" | "install" | "ledger" | "commerce";
}) {
  const links = (
    <>
      <Link
        href="/install"
        aria-current={current === "install" ? "page" : undefined}
      >
        Install
      </Link>
      <Link
        href="/judge"
        aria-current={current === "judge" ? "page" : undefined}
      >
        Judge console
      </Link>
      <Link
        href="/commerce"
        aria-current={current === "commerce" ? "page" : undefined}
      >
        Agent checkout
      </Link>
      <Link
        href="/ledger"
        aria-current={current === "ledger" ? "page" : undefined}
      >
        Ledger
      </Link>
      <Link
        href="/benchmark"
        aria-current={current === "benchmark" ? "page" : undefined}
      >
        Benchmark
      </Link>
      <Link
        href="/proof"
        aria-current={current === "proof" ? "page" : undefined}
      >
        Proof
      </Link>
      <a href={GITHUB_URL}>
        GitHub <span aria-hidden="true">↗</span>
      </a>
    </>
  );
  return (
    <header className="wrap nav">
      <Link href="/" className="brand" aria-label="MCPal home">
        <svg
          className="brand-symbol"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 8h7l10 16h7M4 24h7L21 8h7"
            stroke="currentColor"
            strokeWidth="2"
          />
          <circle cx="4" cy="8" r="2" fill="currentColor" />
          <circle cx="28" cy="24" r="2" fill="currentColor" />
        </svg>
        MC<b>Pal</b>
        <span className="brand-dot" aria-hidden="true" />
      </Link>
      <nav className="desktop-nav" aria-label="Main navigation">
        {links}
      </nav>
      <div className="nav-controls">
        <ThemeToggle />
        <details className="mobile-nav">
          <summary>
            Menu <span aria-hidden="true">+</span>
          </summary>
          <nav aria-label="Mobile navigation">{links}</nav>
        </details>
      </div>
    </header>
  );
}

/** The one environment line, shown once in the site footer on every page. */
export const ENV_SENTENCE =
  "Built on PayPal Orders v2, Payments v2, Payouts, Invoicing, Subscriptions and Webhooks. This hackathon demo is connected to PayPal's sandbox.";

export function SiteFooter() {
  return (
    <footer className="wrap site-env">
      <p>{ENV_SENTENCE}</p>
    </footer>
  );
}
