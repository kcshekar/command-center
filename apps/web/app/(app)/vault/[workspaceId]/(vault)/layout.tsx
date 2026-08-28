import { WorkspaceGate } from "@/components/workspace-gate";

export default function VaultWorkspaceLayout({ children }: { children: React.ReactNode }) {
  return <WorkspaceGate>{children}</WorkspaceGate>;
}
