import { WorkspacePicker } from "@/components/workspace-picker";

export default function SecretsWorkspacesPage() {
  return (
    <WorkspacePicker
      title="Secrets"
      description="Independent, zero-knowledge workspaces — each with its own password."
      basePath="/secrets"
    />
  );
}
