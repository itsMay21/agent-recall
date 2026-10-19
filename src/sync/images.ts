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

/** Strip typed image blocks wherever vendors nest them, including tool args/results. */
export function stripInlineAttachments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripInlineAttachments);
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  if (row["type"] === "image") {
    const source = row["source"] as Record<string, unknown> | undefined;
    const data = source?.["data"] ?? row["data"];
    if (typeof data === "string") {
      const mime = source?.["media_type"] ?? row["mimeType"];
      return toEnvelope({
        kind: "image",
        base64: data,
        ...(typeof mime === "string" ? { contentType: mime } : {}),
      });
    }
  }
  if (row["type"] === "image_url" || row["type"] === "input_image") {
    const imageUrl = row["image_url"];
    const url =
      typeof imageUrl === "string"
        ? imageUrl
        : imageUrl && typeof imageUrl === "object"
          ? (imageUrl as Record<string, unknown>)["url"]
          : undefined;
    if (typeof url === "string" && url.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
      if (match) return toEnvelope({ kind: "image", contentType: match[1]!, base64: match[2]! });
    }
  }
  return Object.fromEntries(
    Object.entries(row).map(([key, val]) => [key, stripInlineAttachments(val)]),
  );
}
