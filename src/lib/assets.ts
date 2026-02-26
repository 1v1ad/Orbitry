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
 *
 * Also supports partial panoramas (e.g. Samsung phone panoramas at ~4:1 ratio):
 * pads to 2:1 equirectangular with black fill for missing sky/floor.
 */
export async function processEquirectToSafeBlob(
  file: File,
  opts?: { forceMaxSize?: number; mime?: 'image/jpeg' | 'image/webp'; quality?: number }
): Promise<{ blob: Blob; width: number; height: number; originalWidth: number; originalHeight: number; fileName: string }> {
  const { bitmap, revoke } = await decodeImageToBitmap(file);
  const originalWidth = bitmap.width;
  const originalHeight = bitmap.height;

  const safeMax = opts?.forceMaxSize ?? (await getSafeMaxTextureSize());
  const ratio = originalWidth / originalHeight;

  // Determine if we need to pad to 2:1 equirectangular.
  // Standard equirect is 2:1. Anything wider (phone panoramas: ~3:1 to ~5:1)
  // gets padded vertically with black to form a proper 2:1 image.
  const needsPadding = ratio > 2.2; // Allow small tolerance around 2:1

  let srcWidth = originalWidth;
  let srcHeight = originalHeight;
  let targetWidth: number;
  let targetHeight: number;

  if (needsPadding) {
    // Keep the width, compute height for 2:1
    targetWidth = srcWidth;
    targetHeight = Math.round(srcWidth / 2);
  } else {
    targetWidth = srcWidth;
    targetHeight = srcHeight;
  }

  // Now apply safe max downscale
  const scale = Math.min(1, safeMax / Math.max(targetWidth, targetHeight));
  const finalWidth = Math.round(targetWidth * scale);
  const finalHeight = Math.round(targetHeight * scale);

  let blob: Blob;

  if (!needsPadding && scale === 1) {
    // Perfect 2:1 and within size limits — keep original bytes
    blob = file;
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = finalWidth;
    canvas.height = finalHeight;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context not available');

    // Fill with black (sky/floor for partial panoramas)
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, finalWidth, finalHeight);

    if (needsPadding) {
      // Center the panorama vertically in the 2:1 frame
      const drawW = finalWidth;
      const drawH = Math.round((originalHeight / originalWidth) * finalWidth);
      const offsetY = Math.round((finalHeight - drawH) / 2);
      ctx.drawImage(bitmap, 0, offsetY, drawW, drawH);
    } else {
      // Standard downscale
      ctx.drawImage(bitmap, 0, 0, finalWidth, finalHeight);
    }

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
  return { blob, width: finalWidth, height: finalHeight, originalWidth, originalHeight, fileName };
}
