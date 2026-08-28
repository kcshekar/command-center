"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";

// Gates a specific workspace's screens behind ITS master password. Unlocking
// a different workspace, or reloading the page, always requires re-entering
// the password — the key never persists anywhere.
export function WorkspaceGate({ children }: { children: ReactNode }) {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const pathname = usePathname();
  const basePath = pathname.startsWith("/vault") ? "/vault" : "/secrets";
  const { activeWorkspaceId, unlocked, unlock } = useWorkspace();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (unlocked && activeWorkspaceId === workspaceId) return <>{children}</>;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await unlock(workspaceId, password);
      if (!result.ok) setError(result.error ?? "Failed to unlock");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-lg tracking-tight">Unlock workspace</CardTitle>
          <CardDescription>
            The password derives the decryption key in this browser only — it is never sent to the server.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="workspace-password">Password</Label>
              <Input
                id="workspace-password"
                type="password"
                autoComplete="off"
                required
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Unlocking…" : "Unlock"}
            </Button>
            <div className="flex justify-between text-sm">
              <Link href={`/secrets/${workspaceId}/recover`} className="text-muted-foreground hover:text-foreground">
                Forgot password?
              </Link>
              <Link href={basePath} className="flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <ArrowLeft className="size-3.5" /> All workspaces
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
