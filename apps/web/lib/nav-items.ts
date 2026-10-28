"use client";

import { useEffect, useState } from "react";
import {
  Bell, BellRing, BookOpen, Bot, Brain, Briefcase, Car, CheckCircle2, Circle, Gift, GraduationCap, Inbox, Key, KeyRound, Lock, Plane, ShoppingCart,
  MessageSquare, Settings2, Smartphone, Sun, Tag, Terminal, UserCircle, Users, Wallet, Zap,
} from "lucide-react";
import { automationsApi, type CatalogRow } from "@/lib/automations-api";

// Single source of truth for the sidebar, the command palette and the
// breadcrumb. Fixed pages live in STATIC_ITEMS; every automation page comes
// from automation_catalog (ui_route/ui_label/icon/area, migration 0043), so a
// new automation shows up by inserting a catalog row — no edits here.

export type NavArea = "money" | "career" | "knowledge" | "life" | "system";
type Icon = React.ComponentType<{ className?: string }>;

export interface NavItem {
  href: string;
  label: string;
  icon: Icon;
  area: NavArea | null;   // null = top of the sidebar, ungrouped
  fromCatalog?: boolean;  // automation page → breadcrumb links back to /automations
}

export const AREA_LABEL: Record<NavArea, string> = {
  money: "Money",
  career: "Career",
  knowledge: "Knowledge",
  life: "Life",
  system: "System",
};
export const AREA_ORDER: NavArea[] = ["money", "career", "knowledge", "life", "system"];

const STATIC_ITEMS: NavItem[] = [
  { href: "/today", label: "Today", icon: Sun, area: null },
  { href: "/inbox", label: "Inbox", icon: Inbox, area: null },
  { href: "/automations", label: "Automations", icon: Zap, area: null },
  { href: "/finance", label: "Finance", icon: Wallet, area: "money" },
  { href: "/brain", label: "Brain", icon: Brain, area: "knowledge" },
  { href: "/knowledge", label: "Command Vault", icon: Terminal, area: "knowledge" },
  { href: "/reminders", label: "Reminders", icon: BellRing, area: "life" },
  { href: "/secrets", label: "Secrets", icon: KeyRound, area: "system" },
  { href: "/vault", label: "Password Vault", icon: Lock, area: "system" },
  { href: "/notifications", label: "Notifications", icon: Bot, area: "system" },
  { href: "/tokens", label: "Service Tokens", icon: Key, area: "system" },
  { href: "/agent-automations", label: "Control room", icon: Settings2, area: "system" },
];

// Catalog `icon` values → components. Unknown names fall back to a dot so a
// new catalog row never breaks the shell.
const ICONS: Record<string, Icon> = {
  briefcase: Briefcase,
  "message-square": MessageSquare,
  "user-circle": UserCircle,
  "graduation-cap": GraduationCap,
  tag: Tag,
  users: Users,
  bell: Bell,
  "book-open": BookOpen,
  gift: Gift,
  smartphone: Smartphone,
  "check-circle": CheckCircle2,
  "shopping-cart": ShoppingCart,
  car: Car,
  plane: Plane,
};

export function catalogNavItems(rows: CatalogRow[]): NavItem[] {
  return rows
    .filter((r) => r.uiRoute && r.uiLabel)
    .map((r) => ({
      href: r.uiRoute!,
      label: r.uiLabel!,
      icon: (r.icon && ICONS[r.icon]) || Circle,
      // mail/platform automations have no page of their own; if one ever
      // gets a route, park it under System rather than dropping it.
      area: r.area === "mail" || r.area === "platform" ? "system" : r.area,
      fromCatalog: true,
    }));
}

// ponytail: module-level cache, one catalog fetch per page load; switch to
// a shared query cache if more components need catalog data.
let cache: Promise<CatalogRow[]> | null = null;
function loadCatalog(): Promise<CatalogRow[]> {
  cache ??= automationsApi.catalog().catch(() => {
    cache = null; // retry on next mount instead of caching the failure
    return [];
  });
  return cache;
}

/** Static pages + catalog pages, in sidebar order. Static items render immediately. */
export function useNavItems(): NavItem[] {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  useEffect(() => {
    let live = true;
    loadCatalog().then((r) => live && setRows(r));
    return () => { live = false; };
  }, []);
  const items = [...STATIC_ITEMS, ...catalogNavItems(rows)];
  const rank = (a: NavArea | null) => (a === null ? -1 : AREA_ORDER.indexOf(a));
  return items.sort((a, b) => rank(a.area) - rank(b.area));
}

/** Groups for the sidebar: ungrouped first, then each area in AREA_ORDER. */
export function groupNav(items: NavItem[]): Array<{ area: NavArea | null; items: NavItem[] }> {
  const groups: Array<{ area: NavArea | null; items: NavItem[] }> = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.area === item.area) last.items.push(item);
    else groups.push({ area: item.area, items: [item] });
  }
  return groups;
}
