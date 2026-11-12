"use client";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const update = () => {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("mcpal-theme-v3");
      } catch {}
      const isDark = saved ? saved === "dark" : true;
      setDark(isDark);
      if (saved) document.documentElement.dataset.theme = saved;
    };
    update();
  }, []);
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to ${dark ? "light" : "dark"} mode`}
      onClick={() => {
        const next = !dark;
        setDark(next);
        document.documentElement.dataset.theme = next ? "dark" : "light";
        try {
          localStorage.setItem("mcpal-theme-v3", next ? "dark" : "light");
        } catch {}
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {dark ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
          </>
        ) : (
          <path d="M20.9 13.2A9 9 0 0 1 10.8 3.1a9 9 0 1 0 10.1 10.1Z" />
        )}
      </svg>
    </button>
  );
}
