/**
 * Minimal safetensors reader (F32 tensors only — heads.safetensors is fp32).
 */

import { readFileSync } from "node:fs";

export function readSafetensors(path: string): Map<string, Float32Array> {
  const buf = readFileSync(path);
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString());
  const out = new Map<string, Float32Array>();
  let off = 8 + headerLen;
  for (const [name, info] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    const { data_offsets, dtype } = info as { data_offsets: number[]; dtype: string };
    if (dtype !== "F32") throw new Error(`unsupported dtype ${dtype} for ${name}`);
    const [start, end] = data_offsets;
    const slice = buf.subarray(off + start, off + end);
    out.set(name, new Float32Array(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength)));
  }
  return out;
}
