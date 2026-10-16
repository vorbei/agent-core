// Turns an image the user pasted or dropped on the composer into a message attachment: the image
// files a clipboard or drop carries, and each one downscaled and re-encoded (PNG kept when it fits,
// else JPEG) under the product's byte limit. GIF and other types are refused, not converted.

/** The file types the composer attaches; anything else is refused with a notice. */
export const IMAGE_INPUT_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Defaults: four images, each at most 1568 px on its long edge and 700,000 base64 characters. */
export const IMAGE_LIMITS = Object.freeze({ max: 4, maxEdge: 1568, maxBase64: 700_000 });

/** The files of a paste or drop that are images (any image type: the caller refuses the unsupported ones). */
export function imageFilesOf(transfer) {
  if (!transfer) return [];
  const fromItems = [...(transfer.items || [])].filter(item => item.kind === "file" && /^image\//.test(item.type))
    .map(item => item.getAsFile()).filter(Boolean);
  return fromItems.length ? fromItems : [...(transfer.files || [])].filter(file => /^image\//.test(file.type));
}

/** Whether a drag carries files (its types are all a dragover can read). */
export function dragHasFiles(transfer) {
  return [...(transfer?.types || [])].includes("Files");
}

const JPEG_QUALITIES = [0.85, 0.72, 0.6];

/**
 * One image file as an attachment: `{ mimeType, data (base64), src (an object URL to show it) }`.
 * Throws IMAGE_TYPE_UNSUPPORTED, or IMAGE_UNREADABLE when the browser cannot decode or shrink it.
 */
export async function prepareChatImage(file, { maxEdge = IMAGE_LIMITS.maxEdge, maxBase64 = IMAGE_LIMITS.maxBase64 } = {}) {
  if (!IMAGE_INPUT_TYPES.includes(file?.type)) throw new Error("IMAGE_TYPE_UNSUPPORTED");
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error("IMAGE_UNREADABLE"); }
  try {
    // Shrink until an encoding fits: the long edge first, then JPEG quality, then the edge again.
    for (let edge = Math.min(maxEdge, Math.max(bitmap.width, bitmap.height)); edge >= 256; edge = Math.floor(edge * 0.75)) {
      const scale = edge / Math.max(bitmap.width, bitmap.height);
      const canvas = drawn(bitmap, Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      const attempts = [...(file.type === "image/png" ? [["image/png"]] : []), ...JPEG_QUALITIES.map(quality => ["image/jpeg", quality])];
      for (const [type, quality] of attempts) {
        const blob = await encoded(canvas, type, quality);
        if (blob.type !== type) continue;
        const data = await base64(blob);
        if (data.length <= maxBase64) return { mimeType: type, data, src: URL.createObjectURL(blob) };
      }
    }
  } finally { bitmap.close?.(); }
  throw new Error("IMAGE_UNREADABLE");
}

// A white background, so a transparent PNG read as JPEG does not turn black.
function drawn(bitmap, width, height) {
  const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement("canvas"), { width, height });
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

function encoded(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("IMAGE_UNREADABLE")), type, quality));
}

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
