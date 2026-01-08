export type StoredAsset = {
  sceneId: string;
  fileName: string;
  blob: Blob;
  /** Final pixel dimensions of the stored blob. */
  width: number;
  height: number;
  /** Original image dimensions (before any downscale). */
  originalWidth: number;
  originalHeight: number;
  updatedAt: string; // ISO
};

const DB_NAME = 'orbitry_assets_v1';
const STORE = 'assets';

let cachedSafeMaxTex: number | null = null;

/**
 * Returns a conservative maximum texture size to avoid "blank WebGL" issues.
 * We query the browser's WebGL MAX_TEXTURE_SIZE and clamp it to a safe ceiling.
 */
export async function getSafeMaxTextureSize(): Promise<number> {
  if (cachedSafeMaxTex) return cachedSafeMaxTex;

  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    const max = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) : 4096;

    // Clamp to a "works on most machines" value; still respects low-end devices.
    cachedSafeMaxTex = Math.max(2048, Math.min(max || 4096, 8192));
    return cachedSafeMaxTex;
  } catch {
    cachedSafeMaxTex = 4096;
    return cachedSafeMaxTex;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'sceneId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveAssetToIdb(asset: StoredAsset): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put(asset);
  });
  db.close();
}

export async function loadAssetFromIdb(sceneId: string): Promise<StoredAsset | null> {
  const db = await openDb();
  const asset = await new Promise<StoredAsset | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    tx.onerror = () => reject(tx.error);
    const req = tx.objectStore(STORE).get(sceneId);
    req.onsuccess = () => resolve((req.result as StoredAsset) || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return asset;
}

export async function deleteAssetFromIdb(sceneId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).delete(sceneId);
  });
  db.close();
}

async function decodeImageToBitmap(file: File): Promise<{ bitmap: ImageBitmap; revoke?: () => void }> {
  // Fast path: createImageBitmap(File) (Chrome/Edge/Firefox)
  try {
    const bitmap = await createImageBitmap(file);
    return { bitmap };
  } catch {
    // Fallback: HTMLImageElement
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to decode image'));
    });
    // createImageBitmap works with HTMLImageElement in modern browsers.
    const bitmap = await createImageBitmap(img);
    return { bitmap, revoke: () => URL.revokeObjectURL(url) };
  }
}

/**
 * "Does something" like Marzipano Tool: decodes and (if needed) downsizes
 * the equirect image to a safe size for WebGL.
 */
export async function processEquirectToSafeBlob(
  file: File,
  opts?: { forceMaxSize?: number; mime?: 'image/jpeg' | 'image/webp'; quality?: number }
): Promise<{ blob: Blob; width: number; height: number; originalWidth: number; originalHeight: number; fileName: string }> {
  const { bitmap, revoke } = await decodeImageToBitmap(file);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;

  const safeMax = opts?.forceMaxSize ?? (await getSafeMaxTextureSize());

  // Keep as-is if it's already within safe limits.
  const scale = Math.min(1, safeMax / Math.max(originalWidth, originalHeight));
  const width = Math.round(originalWidth * scale);
  const height = Math.round(originalHeight * scale);

  let blob: Blob;
  if (scale === 1) {
    // Keep original file bytes.
    blob = file;
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context not available');
    ctx.drawImage(bitmap, 0, 0, width, height);

    const mime = opts?.mime ?? 'image/jpeg';
    const quality = typeof opts?.quality === 'number' ? opts.quality : 0.9;

    blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to encode image'))),
        mime,
        quality
      );
    });
  }

  try {
    bitmap.close();
  } catch {
    // ignore
  }
  revoke?.();

  const fileName = file.name;
  return { blob, width, height, originalWidth, originalHeight, fileName };
}
