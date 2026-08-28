"use client";

import { useEffect, useState } from "react";
import { sessionsApi, type SessionSummary } from "@/lib/sessions-api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [confirming, setConfirming] = useState(false);

  function load() {
    sessionsApi.list().then(setSessions);
  }

  useEffect(load, []);

  async function handleRevokeOthers() {
    setRevoking(true);
    try {
      const { revoked } = await sessionsApi.revokeOthers();
      toast.success(revoked > 0 ? `Signed out of ${revoked} other session(s)` : "No other sessions to sign out of");
      load();
    } finally {
      setRevoking(false);
      setConfirming(false);
    }
  }

  const otherCount = sessions?.filter((s) => !s.isCurrent).length ?? 0;

  return (
    <div className="mx-auto flex max-w-2xl flex-1 flex-col gap-6 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg tracking-tight">Active sessions</CardTitle>
          <CardDescription>Every device currently signed in to your account.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>Signed in</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions?.map((s) => (
                <TableRow key={s.token}>
                  <TableCell className="font-mono text-xs">{s.token}…</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{new Date(s.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{s.isCurrent && <Badge variant="secondary">This device</Badge>}</TableCell>
                </TableRow>
              ))}
              {sessions?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-sm text-muted-foreground">
                    No active sessions
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          {!confirming ? (
            <Button variant="destructive" disabled={otherCount === 0} onClick={() => setConfirming(true)} className="self-start">
              Sign out of all other sessions
            </Button>
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/50 p-3">
              <p className="text-sm">
                This will immediately sign out {otherCount} other session{otherCount === 1 ? "" : "s"}. This device stays
                signed in.
              </p>
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" disabled={revoking} onClick={handleRevokeOthers}>
                  {revoking ? "Signing out…" : "Confirm sign out"}
                </Button>
                <Button variant="outline" size="sm" disabled={revoking} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
