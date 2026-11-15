// Minimal protobuf wire-format reader. Antigravity stores its metadata as
// schema-less protobuf blobs, so fields are read by number.

export type ProtoValue = bigint | Uint8Array;

export interface ProtoField {
  number: number;
  wireType: number;
  value: ProtoValue;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function readVarint(buf: Uint8Array, offset: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  for (let i = offset; i < buf.length; i++) {
    const byte = buf[i];
    result |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) return [result, i + 1];
    shift += 7n;
    if (shift > 63n) break;
  }
  throw new Error("truncated or oversized varint");
}

export function decodeMessage(buf: Uint8Array): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const [key, afterKey] = readVarint(buf, offset);
    offset = afterKey;
    const number = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (number === 0) throw new Error("invalid field number 0");

    switch (wireType) {
      case 0: {
        const [value, next] = readVarint(buf, offset);
        fields.push({ number, wireType, value });
        offset = next;
        break;
      }
      case 1:
        if (offset + 8 > buf.length) throw new Error("truncated fixed64");
        fields.push({ number, wireType, value: buf.subarray(offset, offset + 8) });
        offset += 8;
        break;
      case 2: {
        const [length, next] = readVarint(buf, offset);
        const end = next + Number(length);
        if (end > buf.length) throw new Error("truncated length-delimited field");
        fields.push({ number, wireType, value: buf.subarray(next, end) });
        offset = end;
        break;
      }
      case 5:
        if (offset + 4 > buf.length) throw new Error("truncated fixed32");
        fields.push({ number, wireType, value: buf.subarray(offset, offset + 4) });
        offset += 4;
        break;
      default:
        throw new Error(`unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

/** Decodes a blob, returning an empty message instead of throwing on malformed input. */
export function tryDecode(buf: Uint8Array | null | undefined): ProtoField[] {
  if (!buf || buf.length === 0) return [];
  try {
    return decodeMessage(buf);
  } catch {
    return [];
  }
}

export function getVarint(fields: ProtoField[], number: number): number | undefined {
  for (const field of fields) {
    if (field.number === number && field.wireType === 0) {
      return Number(field.value as bigint);
    }
  }
  return undefined;
}

export function getBytes(fields: ProtoField[], number: number): Uint8Array | undefined {
  for (const field of fields) {
    if (field.number === number && field.wireType === 2) {
      return field.value as Uint8Array;
    }
  }
  return undefined;
}

export function getAllBytes(fields: ProtoField[], number: number): Uint8Array[] {
  return fields
    .filter((field) => field.number === number && field.wireType === 2)
    .map((field) => field.value as Uint8Array);
}

export function getMessage(fields: ProtoField[], number: number): ProtoField[] | undefined {
  const bytes = getBytes(fields, number);
  return bytes ? tryDecode(bytes) : undefined;
}

export function getString(fields: ProtoField[], number: number): string | undefined {
  const bytes = getBytes(fields, number);
  if (!bytes || bytes.length === 0) return undefined;
  try {
    const text = textDecoder.decode(bytes).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a repeated varint field that may be packed (wire type 2) or unpacked (wire type 0). */
export function getPackedVarints(fields: ProtoField[], number: number): number[] {
  const values: number[] = [];
  for (const field of fields) {
    if (field.number !== number) continue;
    if (field.wireType === 0) {
      values.push(Number(field.value as bigint));
    } else if (field.wireType === 2) {
      const buf = field.value as Uint8Array;
      let offset = 0;
      try {
        while (offset < buf.length) {
          const [value, next] = readVarint(buf, offset);
          values.push(Number(value));
          offset = next;
        }
      } catch {
        // Ignore a malformed tail.
      }
    }
  }
  return values;
}

/** Reads a google.protobuf.Timestamp message (seconds = 1, nanos = 2) as epoch milliseconds. */
export function getTimestampMs(fields: ProtoField[] | undefined): number | undefined {
  if (!fields) return undefined;
  const seconds = getVarint(fields, 1);
  if (!seconds || seconds <= 0) return undefined;
  const nanos = Math.min(getVarint(fields, 2) ?? 0, 999_999_999);
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}
