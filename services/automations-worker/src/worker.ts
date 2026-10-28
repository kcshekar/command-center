import "dotenv/config";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities/index.js";
import { startCallbackServer } from "./callback-server.js";
import { getTemporalDataConverter } from "./temporal-data-converter.js";
import { TASK_QUEUES } from "./workflows/task-queues.js";

async function main() {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "personal";
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? "personal-automations";

  const connection = await NativeConnection.connect({ address });
  const dataConverter = await getTemporalDataConverter();

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    // .ts under tsx (src/), .js once built (dist/, `pnpm start`)
    workflowsPath: new URL(`./workflows/index.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).pathname,
    activities,
    dataConverter,
    // P0.3: Ollama is one model on one box; cap the burst when schedules overlap.
    maxTaskQueueActivitiesPerSecond: 2,
    maxConcurrentActivityTaskExecutions: 4,
  });

  // P1.0c: activity-only workers, one per external API (routing lives in
  // workflows/task-queues.ts). Same process, so the Ollama mutex still covers all.
  const apiWorker = (queue: string, limits: { maxTaskQueueActivitiesPerSecond?: number; maxConcurrentActivityTaskExecutions?: number }) =>
    Worker.create({ connection, namespace, taskQueue: queue, activities, dataConverter, ...limits });
  const apiWorkers = await Promise.all([
    apiWorker(TASK_QUEUES.google, { maxTaskQueueActivitiesPerSecond: 1, maxConcurrentActivityTaskExecutions: 2 }), // Google is strict
    apiWorker(TASK_QUEUES.jobs, { maxTaskQueueActivitiesPerSecond: 2, maxConcurrentActivityTaskExecutions: 2 }),
    apiWorker(TASK_QUEUES.ollama, { maxConcurrentActivityTaskExecutions: 1 }),
  ]);

  // Callback server: CC posts approval decisions here.
  await startCallbackServer();

  console.log(`worker ready. namespace=${namespace} queues=${[taskQueue, ...Object.values(TASK_QUEUES)].join(",")} address=${address}`);
  // If any worker dies, fail the process so pm2 restarts the whole set.
  await Promise.all([worker, ...apiWorkers].map((w) => w.run()));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
