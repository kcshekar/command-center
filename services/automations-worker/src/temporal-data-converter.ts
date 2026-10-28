import type { DataConverter } from "@temporalio/common";
import { EncryptionCodec } from "./encryption-codec.js";

// Shared by the Worker and every Client in this process that talks to the
// same workflows (callback-server). Default payload converter, encrypted codec.
export async function getTemporalDataConverter(): Promise<DataConverter> {
  return { payloadCodecs: [await EncryptionCodec.create()] };
}
