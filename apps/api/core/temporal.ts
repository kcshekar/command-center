import { Client, Connection } from "@temporalio/client";

// Lazy singleton. CC only talks to Temporal from the automations dashboard
// routes, so we don't want to delay boot (and we don't want to crash CC when
// Temporal is briefly unreachable) by connecting on module load.

let clientPromise: Promise<Client> | null = null;

function missingEnv(): string | null {
  if (!process.env.TEMPORAL_ADDRESS) return "TEMPORAL_ADDRESS";
  if (!process.env.TEMPORAL_NAMESPACE) return "TEMPORAL_NAMESPACE";
  return null;
}

async function connect(): Promise<Client> {
  const missing = missingEnv();
  if (missing) throw new Error(`${missing} not set — automations dashboard requires Temporal connection details`);
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS! });
  return new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE! });
}

export async function temporalClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      // Reset so a transient failure doesn't poison every future call.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}
