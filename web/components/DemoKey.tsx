"use client";
// Each visitor gets a random demo key, kept in this browser. The hosted MCP server gives every key
// its own ledger, approvals and rate limit, so two judges never see each other's orders.
import { useEffect, useState } from "react";

export const DEMO_KEY_STORAGE = "mcpal_demo_key";
const EVENT = "mcpal-demo-key";
const KEY_RE = /^dk_[a-z0-9]{24}$/;

function generate(): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return "dk_" + Array.from(bytes, (b) => abc[b % abc.length]).join("");
}

let memoryKey = "";

function readOrCreate(): string {
  let k = "";
  try {
    k = localStorage.getItem(DEMO_KEY_STORAGE) ?? "";
  } catch {
    /* storage blocked */
  }
  if (!KEY_RE.test(k)) k = KEY_RE.test(memoryKey) ? memoryKey : generate();
  memoryKey = k;
  try {
    localStorage.setItem(DEMO_KEY_STORAGE, k);
  } catch {
    /* storage blocked: the key lives for this page view only */
  }
  return k;
}

/** The visitor's demo key ("" before mount). */
export function useDemoKey(): string {
  const [key, setKey] = useState("");
  useEffect(() => {
    setKey(readOrCreate());
    const on = () => setKey(readOrCreate());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return key;
}

/** Replace the key with a fresh one (a new, empty ledger). */
export function resetDemoKey(): void {
  memoryKey = generate();
  try {
    localStorage.setItem(DEMO_KEY_STORAGE, memoryKey);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Switch this browser to a key the server minted (e.g. one bound to the visitor's own sandbox app). */
export function setDemoKey(k: string): void {
  if (!KEY_RE.test(k)) return;
  memoryKey = k;
  try {
    localStorage.setItem(DEMO_KEY_STORAGE, k);
  } catch {
    /* storage blocked: the key lives for this page view only */
  }
  window.dispatchEvent(new Event(EVENT));
}
