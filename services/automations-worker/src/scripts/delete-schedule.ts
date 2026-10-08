import "dotenv/config";
import { Client, Connection } from "@temporalio/client";

async function main() {
  const scheduleId = process.argv[2];
  if (!scheduleId) {
    console.error("Usage: pnpm schedules:delete -- <schedule-id>");
    process.exit(1);
  }

  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "personal";

  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace });

  try {
    const handle = client.schedule.getHandle(scheduleId);
    await handle.delete();
    console.log(`Successfully deleted schedule '${scheduleId}' in namespace '${namespace}'.`);
  } catch (err: any) {
    console.error(`Failed to delete schedule '${scheduleId}':`, err?.message ?? err);
    process.exit(1);
  } finally {
    await connection.close();
  }
}

main();
