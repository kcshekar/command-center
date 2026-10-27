"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useAuth } from "@/lib/auth-context";
import { AREA_LABEL, groupNav, useNavItems, type NavItem } from "@/lib/nav-items";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { NotificationBell } from "@/components/notification-bell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Command, LogOut, Menu, Monitor, ShieldCheck, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Breadcrumb } from "@/components/breadcrumb";

function NavLinks({ items, pathname, onNavigate }: { items: NavItem[]; pathname: string; onNavigate?: () => void }) {
  return (
    <nav className="flex-1 overflow-y-auto px-2 pb-2">
      {groupNav(items).map((g) => (
        <div key={g.area ?? "top"} className="space-y-1 pb-2">
          {g.area && (
            <div className="px-2 pt-3 pb-1 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              {AREA_LABEL[g.area]}
            </div>
          )}
          {g.items.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                )}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const navItems = useNavItems();
  const current = navItems.find((i) => pathname.startsWith(i.href));

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // Route changes (nav-link clicks included) should close the drawer rather
  // than leaving it open over the newly-loaded page.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!user) return null;

  return (
    <div className="flex flex-1 min-h-0">
      <aside className="hidden md:flex w-56 shrink-0 border-r border-sidebar-border bg-sidebar flex-col">
        <div className="px-4 py-4 text-sm font-heading font-semibold tracking-tight text-sidebar-foreground">Command Center</div>
        <NavLinks items={navItems} pathname={pathname} />
        <div className="px-2 py-3 text-xs text-muted-foreground">Role: {user.role}</div>
      </aside>

      <DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 md:hidden data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
          <DialogPrimitive.Popup className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[80%] flex-col border-r border-sidebar-border bg-sidebar outline-none md:hidden data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left">
            <div className="px-4 py-4 text-sm font-heading font-semibold tracking-tight text-sidebar-foreground">Command Center</div>
            <NavLinks items={navItems} pathname={pathname} onNavigate={() => setMobileNavOpen(false)} />
            <div className="px-2 py-3 text-xs text-muted-foreground">Role: {user.role}</div>
          </DialogPrimitive.Popup>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <div className="flex flex-1 min-w-0 flex-col">
        <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Button variant="outline" size="icon" className="shrink-0 md:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open menu">
              <Menu className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-muted-foreground gap-2"
              onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
            >
              <Command className="size-3.5" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden sm:inline ml-2 rounded border bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
            </Button>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <NotificationBell />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>Account</DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => router.push("/account/security")}>
                  <ShieldCheck className="size-4" />
                  Security
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => router.push("/account/sessions")}>
                  <Monitor className="size-4" />
                  Sessions
                </DropdownMenuItem>
                {(user.role === "owner" || user.role === "admin") && (
                  <DropdownMenuItem onClick={() => router.push("/account/audit-log")}>
                    <ScrollText className="size-4" />
                    Audit Log
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => logout().then(() => router.push("/login"))}>
                  <LogOut className="size-4" />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 min-h-0 overflow-auto p-4 sm:p-6">
          {(current?.fromCatalog || current?.href === "/agent-automations") && (
            <div className="mb-3">
              <Breadcrumb items={[
                { label: "Automations", href: "/automations" },
                { label: current.label },
              ]} />
            </div>
          )}
          <div key={pathname} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
            {children}
          </div>
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}
