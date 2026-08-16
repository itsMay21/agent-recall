// Attachment stripping. Base64 image/binary payloads (Pi, Codex, Claude, Gemini all inline them)
// are replaced by a payload-free envelope: content-type + byte size + sha256. The bytes are never
// stored inline; this is what keeps the index and raw sidecar from exploding. See docs/SCHEMA.md.

import { createHash } from "node:crypto";
import type { AttachmentEnvelope, InputAttachment } from "./types.js";

/** Convert an adapter's attachment (possibly carrying base64) into a stored envelope. */
export function toEnvelope(att: InputAttachment): AttachmentEnvelope {
  if (att.base64) {
    const buf = Buffer.from(att.base64, "base64");
    return {
      kind: att.kind,
      ...(att.contentType ? { content_type: att.contentType } : {}),
      bytes: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  }
  return {
    kind: att.kind,
    ...(att.contentType ? { content_type: att.contentType } : {}),
    bytes: att.bytes ?? 0,
    sha256: att.sha256 ?? "",
  };
}

export function toEnvelopes(atts: InputAttachment[] | undefined): AttachmentEnvelope[] | undefined {
  if (!atts || atts.length === 0) return undefined;
  return atts.map(toEnvelope);
}
