"use client";

import { useEffect, useState } from "react";
import { auditApi, type AuditEntry } from "@/lib/audit-api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  useEffect(() => {
    auditApi.list().then((rows) => {
      setEntries(rows);
      setHasMore(rows.length === PAGE_SIZE);
      setLoading(false);
    });
  }, []);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const rows = await auditApi.list(entries[entries.length - 1]?.id);
      setEntries((prev) => [...prev, ...rows]);
      setHasMore(rows.length === PAGE_SIZE);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-1 flex-col gap-4 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg tracking-tight">Audit log</CardTitle>
          <CardDescription>Every recorded action across this organization, most recent first.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Resource</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                    {new Date(e.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm">{e.actor_email}</TableCell>
                  <TableCell className="font-mono text-sm">{e.action}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {e.resource_type}
                    {e.resource_id ? `:${e.resource_id.slice(0, 8)}` : ""}
                  </TableCell>
                </TableRow>
              ))}
              {!loading && entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                    No activity recorded yet
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {hasMore && entries.length > 0 && (
            <Button variant="outline" onClick={loadMore} disabled={loadingMore} className="self-start">
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
