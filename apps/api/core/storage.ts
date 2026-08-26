import { Storage } from "@google-cloud/storage";

// GCS_SERVICE_ACCOUNT_KEY: base64-encoded service-account JSON (one env var,
// easier to pass around in dev/containers than a mounted key file).
const credentials = process.env.GCS_SERVICE_ACCOUNT_KEY
  ? JSON.parse(Buffer.from(process.env.GCS_SERVICE_ACCOUNT_KEY, "base64").toString("utf-8"))
  : undefined;

const storage = new Storage(credentials ? { credentials } : undefined);
const bucket = () => storage.bucket(process.env.GCS_BUCKET_NAME!);

const SIGNED_URL_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function getUploadUrl(objectKey: string, contentType: string): Promise<string> {
  const [url] = await bucket()
    .file(objectKey)
    .getSignedUrl({ version: "v4", action: "write", expires: Date.now() + SIGNED_URL_TTL_MS, contentType });
  return url;
}

export async function getDownloadUrl(objectKey: string): Promise<string> {
  const [url] = await bucket()
    .file(objectKey)
    .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + SIGNED_URL_TTL_MS });
  return url;
}

export async function deleteObject(objectKey: string): Promise<void> {
  await bucket().file(objectKey).delete({ ignoreNotFound: true });
}
