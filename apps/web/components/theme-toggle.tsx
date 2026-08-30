"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

const OPTIONS = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
] as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  // Avoids a hydration mismatch: the server has no way to know the viewer's
  // stored preference, so the real state only renders after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border bg-secondary p-0.5">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          type="button"
          aria-label={opt.label}
          onClick={() => setTheme(opt.value)}
          className={cn(
            "flex items-center justify-center rounded-md p-1.5 text-muted-foreground transition-colors",
            mounted && theme === opt.value ? "bg-primary text-primary-foreground" : "hover:text-foreground"
          )}
        >
          <opt.icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}
