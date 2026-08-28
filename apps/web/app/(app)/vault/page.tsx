import { WorkspacePicker } from "@/components/workspace-picker";

export default function VaultWorkspacesPage() {
  return (
    <WorkspacePicker
      title="Password Vault"
      description="Same workspaces as Secrets — pick one to see its stored credentials."
      basePath="/vault"
    />
  );
}
