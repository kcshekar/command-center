import { KeyRound, Lock, BookOpen, Wallet, BellRing, Bot, Key, Zap } from "lucide-react";

// Single source of truth for both the sidebar and the command palette so
// adding a section never means updating two lists.
//
// All automation surfaces (Jobs, Interviews, Price Watcher, Learning, TTD,
// Profile Drafts) sit behind the Automations landing at /automations. Each
// still has a direct URL — the command palette / bookmark bar can reach them
// without an extra click; the sidebar just stays tidy.
export const NAV_ITEMS = [
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/vault", label: "Password Vault", icon: Lock },
  { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
  { href: "/finance", label: "Finance", icon: Wallet },
  { href: "/reminders", label: "Reminders", icon: BellRing },
  { href: "/notifications", label: "Notifications", icon: Bot },
  { href: "/tokens", label: "Service Tokens", icon: Key },
  { href: "/automations", label: "Automations", icon: Zap },
];
