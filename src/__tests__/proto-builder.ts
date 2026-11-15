// Tiny protobuf encoder for building Antigravity-shaped fixtures in tests.

export type Field =
  | { n: number; varint: number }
  | { n: number; bytes: Uint8Array }
  | { n: number; str: string }
  | { n: number; msg: Field[] };

function varint(value: number): number[] {
  const out: number[] = [];
  let v = BigInt(value);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

export function encode(fields: Field[]): Uint8Array {
  const out: number[] = [];
  for (const field of fields) {
    if ("varint" in field) {
      out.push(...varint((field.n << 3) | 0), ...varint(field.varint));
      continue;
    }
    const payload =
      "bytes" in field
        ? field.bytes
        : "str" in field
        ? new TextEncoder().encode(field.str)
        : encode(field.msg);
    out.push(...varint((field.n << 3) | 2), ...varint(payload.length), ...payload);
  }
  return new Uint8Array(out);
}

export function packed(values: number[]): Uint8Array {
  return new Uint8Array(values.flatMap(varint));
}

export function timestamp(ms: number): Field[] {
  return [
    { n: 1, varint: Math.floor(ms / 1000) },
    { n: 2, varint: (ms % 1000) * 1_000_000 },
  ];
}

export interface UsageSpec {
  modelId?: number;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  thinking?: number;
  visible?: number;
  responseId?: string;
}

export function usage(spec: UsageSpec): Field[] {
  const fields: Field[] = [];
  if (spec.modelId) fields.push({ n: 1, varint: spec.modelId });
  if (spec.input) fields.push({ n: 2, varint: spec.input });
  if (spec.output) fields.push({ n: 3, varint: spec.output });
  if (spec.cacheWrite) fields.push({ n: 4, varint: spec.cacheWrite });
  if (spec.cacheRead) fields.push({ n: 5, varint: spec.cacheRead });
  fields.push({ n: 6, varint: 24 });
  if (spec.thinking) fields.push({ n: 9, varint: spec.thinking });
  if (spec.visible) fields.push({ n: 10, varint: spec.visible });
  if (spec.responseId) fields.push({ n: 11, str: spec.responseId });
  return fields;
}
