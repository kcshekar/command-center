import { KeyRound, Lock, BookOpen, Wallet, BellRing, Bot, Key, Zap, Tag, Users, GraduationCap } from "lucide-react";

// Single source of truth for both the sidebar and the command palette so
// adding a section never means updating two lists.
export const NAV_ITEMS = [
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/vault", label: "Password Vault", icon: Lock },
  { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
  { href: "/finance", label: "Finance", icon: Wallet },
  { href: "/reminders", label: "Reminders", icon: BellRing },
  { href: "/notifications", label: "Notifications", icon: Bot },
  { href: "/tokens", label: "Service Tokens", icon: Key },
  { href: "/agent-automations", label: "Automations", icon: Zap },
  { href: "/price-watcher", label: "Price Watcher", icon: Tag },
  { href: "/pilgrim", label: "TTD / Pilgrim Pack", icon: Users },
  { href: "/learning", label: "Learning Digest", icon: GraduationCap },
];
