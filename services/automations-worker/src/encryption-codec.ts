import { METADATA_ENCODING_KEY, type Payload, type PayloadCodec } from "@temporalio/common";
import proto from "@temporalio/proto"; // CJS: named ESM import fails at runtime
const { Payload: PayloadProto } = proto.temporal.api.common.v1;
import { webcrypto } from "node:crypto";

// AES-256-GCM over the serialized Payload (P0.1). Wire format: 12-byte IV ‖
// ciphertext+tag. Payloads without our encoding (history written before this
// codec, or by clients that don't use it, e.g. CC's schedule args) pass
// through untouched, so turning this on never breaks in-flight workflows.
const ENCODING = "binary/encrypted";
const KEY_ID = "dek-1"; // ponytail: single key; on rotation keep old keys in a map keyed by this id

const enc = new TextEncoder();
const dec = new TextDecoder();

export class EncryptionCodec implements PayloadCodec {
  private constructor(private readonly key: webcrypto.CryptoKey) { }

  static async create(hex = process.env.TEMPORAL_PAYLOAD_DEK?.trim()): Promise<EncryptionCodec> {
    // Strict: Buffer.from(_, "hex") silently stops at the first non-hex char.
    if (!/^[0-9a-f]{64}$/i.test(hex ?? "")) throw new Error("TEMPORAL_PAYLOAD_DEK must be 32 bytes, hex (openssl rand -hex 32)");
    const raw = Buffer.from(hex!, "hex");
    return new EncryptionCodec(await webcrypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }

  async encode(payloads: Payload[]): Promise<Payload[]> {
    return Promise.all(payloads.map(async (p) => {
      const iv = webcrypto.getRandomValues(new Uint8Array(12));
      const plain = PayloadProto.encode(p).finish();
      const ct = new Uint8Array(await webcrypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, plain));
      const data = new Uint8Array(iv.length + ct.length);
      data.set(iv);
      data.set(ct, iv.length);
      return { metadata: { [METADATA_ENCODING_KEY]: enc.encode(ENCODING), "encryption-key-id": enc.encode(KEY_ID) }, data };
    }));
  }

  async decode(payloads: Payload[]): Promise<Payload[]> {
    return Promise.all(payloads.map(async (p) => {
      const encoding = p.metadata?.[METADATA_ENCODING_KEY];
      if (!encoding || dec.decode(encoding) !== ENCODING) return p;
      if (!p.data) throw new Error("encrypted payload has no data");
      const plain = await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: p.data.subarray(0, 12) }, this.key, p.data.subarray(12),
      );
      return PayloadProto.decode(new Uint8Array(plain));
    }));
  }
}
