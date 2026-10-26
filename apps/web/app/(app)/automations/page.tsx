"use client";

import Link from "next/link";
import {
  Briefcase, GraduationCap, MessageSquare, Settings2, Tag, UserCircle, Users, Zap,
} from "lucide-react";

// A single landing page for every user-facing automation UI. The sidebar no
// longer carries one entry per automation; this grid is the hub.
// `/agent-automations` stays as the admin "Control room" tile at the end.

interface Tile {
  href: string;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  catalog?: string;             // the a1./a2./... id so the user can line it up with the catalog
  accent?: string;              // tailwind text color for the icon
}

const TILES: Tile[] = [
  {
    href: "/jobs", label: "Jobs", icon: Briefcase, catalog: "a2.jobs", accent: "text-emerald-600",
    description: "Daily job feed from Adzuna, scored against your profile, with inline Prep + Tailor triggers.",
  },
  {
    href: "/interviews", label: "Interviews", icon: MessageSquare, catalog: "a3 · a4 · a9", accent: "text-indigo-600",
    description: "Interview sessions with per-round tracker, prep notes, tailored resume + cover letter.",
  },
  {
    href: "/price-watcher", label: "Price Watcher", icon: Tag, catalog: "a6.price", accent: "text-amber-600",
    description: "Track product prices via Keepa, verdict + Slack alert when a target is hit.",
  },
  {
    href: "/learning", label: "Learning Digest", icon: GraduationCap, catalog: "a8.learning", accent: "text-sky-600",
    description: "Weekly digest of releases from the repos you follow, prioritised must/skim/skip.",
  },
  {
    href: "/pilgrim", label: "TTD / Pilgrim Pack", icon: Users, catalog: "a10.ttd", accent: "text-rose-600",
    description: "Encrypted pilgrim pack + darshan windows; reminders when booking opens.",
  },
  {
    href: "/profile-drafts", label: "Profile Drafts", icon: UserCircle, catalog: "a7.profile", accent: "text-violet-600",
    description: "Monthly LinkedIn / README / resume drafts refreshed from your recent activity.",
  },
];

const CONTROL_TILE: Tile = {
  href: "/agent-automations", label: "Control room", icon: Settings2, accent: "text-primary",
  description: "Schedules, catalog toggles, connected accounts, BYOK API keys. Admin surface.",
};

export default function AutomationsLanding() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-heading font-semibold tracking-tight">
          <Zap className="size-5 text-primary" /> Automations
        </h1>
        <p className="text-sm text-muted-foreground">
          Each tile opens a dedicated page. For schedules, connected accounts, and keys, use the Control room tile at the bottom.
        </p>
      </div>

      <div className="pt-2">
        <TileCard tile={CONTROL_TILE} wide />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((t) => <TileCard key={t.href} tile={t} />)}
      </div>
    </div>
  );
}

function TileCard({ tile, wide }: { tile: Tile; wide?: boolean }) {
  const Icon = tile.icon;
  return (
    <Link
      href={tile.href}
      className="group flex flex-col gap-2 rounded-2xl border bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={`size-5 ${tile.accent ?? "text-primary"}`} />
          <h2 className="text-base font-semibold">{tile.label}</h2>
        </div>
        {tile.catalog && (
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {tile.catalog}
          </code>
        )}
      </div>
      <p className={`text-sm text-muted-foreground ${wide ? "" : "line-clamp-3"}`}>{tile.description}</p>
      <div className="mt-auto pt-2 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
        Open →
      </div>
    </Link>
  );
}
