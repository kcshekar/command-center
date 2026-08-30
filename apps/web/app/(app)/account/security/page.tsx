"use client";

import { useState, type FormEvent } from "react";
import { useAuth, ApiError } from "@/lib/auth-context";
import { mfaApi } from "@/lib/mfa-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function SecurityPage() {
  const { user } = useAuth();
  const [enabled, setEnabled] = useState(user?.mfaEnabled ?? false);

  // --- Enable flow: setup -> confirm code -> show backup codes once ---
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startSetup() {
    setError(null);
    const result = await mfaApi.setup();
    setSetup(result);
  }

  async function confirmSetup(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { backupCodes } = await mfaApi.enable(confirmCode);
      setBackupCodes(backupCodes);
      setEnabled(true);
      setSetup(null);
      setConfirmCode("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Invalid code");
    } finally {
      setBusy(false);
    }
  }

  // --- Disable flow ---
  const [disablePassword, setDisablePassword] = useState("");

  async function disable(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await mfaApi.disable(disablePassword);
      setEnabled(false);
      setDisablePassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to disable");
    } finally {
      setBusy(false);
    }
  }

  if (backupCodes) {
    return (
      <div className="mx-auto flex max-w-lg flex-1 flex-col gap-4 p-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg tracking-tight">Save your backup codes</CardTitle>
            <CardDescription>
              Each code works once, if you lose access to your authenticator app. They&apos;re shown only this once.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm">
              {backupCodes.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </div>
            <Button onClick={() => setBackupCodes(null)} className="self-start">
              I&apos;ve saved these
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-lg flex-1 flex-col gap-6 p-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg tracking-tight">Two-factor authentication</CardTitle>
          <CardDescription>Require an authenticator app code (or a backup code) at login, in addition to your password.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {enabled && !setup && (
            <form onSubmit={disable} className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Two-factor authentication is enabled.</p>
              <div className="flex flex-col gap-2">
                <Label htmlFor="disable-password">Enter your password to disable it</Label>
                <Input
                  id="disable-password"
                  type="password"
                  required
                  value={disablePassword}
                  onChange={(e) => setDisablePassword(e.target.value)}
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" variant="destructive" disabled={busy} className="self-start">
                {busy ? "Disabling…" : "Disable two-factor authentication"}
              </Button>
            </form>
          )}

          {!enabled && !setup && (
            <Button onClick={startSetup} className="self-start">
              Set up two-factor authentication
            </Button>
          )}

          {setup && (
            <form onSubmit={confirmSetup} className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Add this to your authenticator app (Google Authenticator, 1Password, etc.), then enter the 6-digit code it shows.
              </p>
              <div className="rounded-md border p-3 font-mono text-xs break-all">{setup.secret}</div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="confirm-code">6-digit code</Label>
                <Input id="confirm-code" autoFocus required value={confirmCode} onChange={(e) => setConfirmCode(e.target.value.trim())} />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button type="submit" disabled={busy}>
                  {busy ? "Verifying…" : "Confirm and enable"}
                </Button>
                <Button type="button" variant="outline" onClick={() => setSetup(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
