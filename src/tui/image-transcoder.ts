/**
 * Async jpeg/webp → PNG transcoder for kitty terminals (which only accept PNG).
 * Registered via the framework's setImageTranscoder: the render-time call is a
 * synchronous cache lookup; a miss spawns a background sharp job and returns null
 * (text fallback) until the job finishes and onTranscodeReady listeners re-render.
 * Display-only: session records keep the original bytes, nothing is persisted.
 */

type Entry = { state: "pending" } | { state: "done"; png: string } | { state: "failed" };

// Matches the framework's pngCache limit; pending entries are never evicted.
const CACHE_LIMIT = 32;
// Display is at most 14 cells tall; 2048px is far beyond need and keeps cached
// PNG base64 to a few MB per image instead of tens.
const MAX_EDGE_PX = 2048;

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

export function transcodeToPng(base64Data: string, mimeType: string): string | null {
  if (mimeType !== "image/jpeg" && mimeType !== "image/webp") return null;
  const entry = entries.get(base64Data);
  if (entry?.state === "done") {
    entries.delete(base64Data);
    entries.set(base64Data, entry);
    return entry.png;
  }
  // pending or failed: never respawn a job (failed is a negative cache).
  if (entry) return null;
  entries.set(base64Data, { state: "pending" });
  evictOldestFinished();
  void runJob(base64Data);
  return null;
}

/** Subscribe to successful conversions; returns an unsubscribe function. */
export function onTranscodeReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function evictOldestFinished(): void {
  if (entries.size <= CACHE_LIMIT) return;
  for (const [key, entry] of entries) {
    if (entry.state !== "pending") {
      entries.delete(key);
      return;
    }
  }
}

async function runJob(base64Data: string): Promise<void> {
  let png: string;
  try {
    // Dynamic import: native sharp loads only when a kitty terminal actually
    // shows a non-PNG image; startup and other terminals pay nothing.
    const { default: sharp } = await import("sharp");
    const buffer = await sharp(Buffer.from(base64Data, "base64"))
      .rotate() // apply EXIF orientation; the framework re-reads PNG dimensions
      .resize({ width: MAX_EDGE_PX, height: MAX_EDGE_PX, fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    png = buffer.toString("base64");
  } catch {
    entries.set(base64Data, { state: "failed" });
    return;
  }
  entries.set(base64Data, { state: "done", png });
  // Notify outside the try: a listener error must not demote a done entry.
  // Failures stay silent — the text fallback already shows the unchanged state.
  for (const listener of listeners) listener();
}
