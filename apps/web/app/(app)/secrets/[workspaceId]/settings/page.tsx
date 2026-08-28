"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useWorkspace } from "@/lib/workspace-context";
import { workspaceApi } from "@/lib/workspace-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { ArrowLeft, ShieldAlert } from "lucide-react";

export default function WorkspaceSettingsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const { changePassword } = useWorkspace();
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  useEffect(() => {
    workspaceApi.list().then((all) => {
      const match = all.find((w) => w.id === workspaceId);
      if (match) setWorkspaceName(match.name);
    });
  }, [workspaceId]);

  // --- Change password ---
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changeError, setChangeError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setChangeError(null);
    if (newPassword.length < 8) {
      setChangeError("New password must be at least 8 characters");
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangeError("New passwords do not match");
      return;
    }
    setChanging(true);
    try {
      const result = await changePassword(workspaceId, currentPassword, newPassword);
      if (!result.ok) {
        setChangeError(result.error ?? "Failed to change password");
        return;
      }
      toast.success("Password changed");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setChanging(false);
    }
  }

  // --- Destructive reset ---
  const [confirmName, setConfirmName] = useState("");
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function handleReset() {
    if (!workspaceName || confirmName !== workspaceName) return;
    setResetting(true);
    setResetError(null);
    try {
      await workspaceApi.reset(workspaceId, confirmName);
      router.push("/secrets");
    } catch (e: any) {
      setResetError(e?.message ?? "Failed to reset workspace");
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-1 flex-col gap-6 p-4">
      <Link href={`/secrets/${workspaceId}`} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Back to workspace
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg tracking-tight">Change password</CardTitle>
          <CardDescription>Only re-wraps the workspace key — your existing secrets are untouched.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="settings-new-password">New password</Label>
              <Input
                id="settings-new-password"
                type="password"
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="settings-confirm-password">Confirm new password</Label>
              <Input
                id="settings-confirm-password"
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
            {changeError && <p className="text-sm text-destructive">{changeError}</p>}
            <Button type="submit" disabled={changing}>
              {changing ? "Changing…" : "Change password"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg tracking-tight text-destructive">
            <ShieldAlert className="size-4" />
            Danger zone
          </CardTitle>
          <CardDescription>
            Permanently deletes this workspace and every project/environment/secret inside it. There is no undo — use
            this only if you&apos;ve lost both the password and the recovery key.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Label htmlFor="confirm-name">
            Type <span className="font-mono font-semibold">{workspaceName ?? "…"}</span> to confirm
          </Label>
          <Input id="confirm-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} disabled={!workspaceName} />
          {resetError && <p className="text-sm text-destructive">{resetError}</p>}
          <Button
            variant="destructive"
            disabled={!workspaceName || confirmName !== workspaceName || resetting}
            onClick={handleReset}
          >
            {resetting ? "Deleting…" : "Permanently delete this workspace"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
