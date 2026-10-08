import "dotenv/config";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/index.js";
import { startCallbackServer } from "./callback-server.js";

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "personal";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";

  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: new URL("./workflows/index.ts", import.meta.url).pathname,
    activities,
  });

  // Callback server: CC posts approval decisions here.
  await startCallbackServer();

  console.log(`worker ready. namespace=${namespace} queue=${taskQueue} address=${address}`);
  await worker.run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
