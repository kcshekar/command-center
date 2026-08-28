"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { NAV_ITEMS } from "@/lib/nav-items";
import { CommandPalette } from "@/components/command-palette";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Command, LogOut, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }
  if (!user) return null;

  return (
    <div className="flex flex-1 min-h-0">
      <aside className="w-56 shrink-0 border-r border-sidebar-border bg-sidebar flex flex-col">
        <div className="px-4 py-4 text-sm font-semibold tracking-tight text-sidebar-foreground">Command Center</div>
        <nav className="flex-1 px-2 space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
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
        </nav>
        <div className="px-2 py-3 text-xs text-muted-foreground">Role: {user.role}</div>
      </aside>

      <div className="flex flex-1 min-w-0 flex-col">
        <header className="flex items-center justify-between border-b px-4 py-2.5">
          <Button
            variant="outline"
            size="sm"
            className="text-muted-foreground gap-2"
            onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          >
            <Command className="size-3.5" />
            Search
            <kbd className="ml-2 rounded border bg-muted px-1.5 py-0.5 text-[10px]">⌘K</kbd>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>Account</DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => router.push("/account/sessions")}>
                <Monitor className="size-4" />
                Sessions
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => logout().then(() => router.push("/login"))}>
                <LogOut className="size-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <main className="flex-1 min-h-0 overflow-auto p-6">{children}</main>
      </div>

      <CommandPalette />
    </div>
  );
}
