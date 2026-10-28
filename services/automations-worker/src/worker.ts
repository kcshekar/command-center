import "dotenv/config";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/index.js";
import { startCallbackServer } from "./callback-server.js";
import { getTemporalDataConverter } from "./temporal-data-converter.js";

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "personal";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";

  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    // .ts under tsx (src/), .js once built (dist/, `pnpm start`)
    workflowsPath: new URL(`./workflows/index.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).pathname,
    activities,
    dataConverter: await getTemporalDataConverter(),
    // P0.3: Ollama is one model on one box; cap the burst when schedules overlap.
    maxTaskQueueActivitiesPerSecond: 2,
    maxConcurrentActivityTaskExecutions: 4,
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
