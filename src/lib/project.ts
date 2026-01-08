export type OrbitryVersion = 1;

export type OrbitryScenePanorama = {
  type: 'equirect';
  /** Friendly name shown in UI. */
  label?: string;
  /** Original filename (when imported). */
  fileName?: string;
  /** Dimensions if known. */
  width?: number;
  height?: number;
};

export type OrbitryViewParameters = {
  yaw: number;
  pitch: number;
  fov: number;
};

export type OrbitryInfoHotspot = {
  id: string;
  type: 'info';
  yaw: number;
  pitch: number;
  title?: string;
  text?: string;
};

export type OrbitryLinkHotspot = {
  id: string;
  type: 'link';
  yaw: number;
  pitch: number;
  targetSceneId: string;
};

export type OrbitryHotspot = OrbitryInfoHotspot | OrbitryLinkHotspot;

export type OrbitryScene = {
  id: string;
  name: string;
  panorama: OrbitryScenePanorama;
  initialView: OrbitryViewParameters;
  hotspots: OrbitryHotspot[];
};

export type OrbitryProject = {
  version: OrbitryVersion;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  title: string;
  scenes: OrbitryScene[];
};

export function createEmptyProject(title: string = 'Untitled Orbitry Project'): OrbitryProject {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    title,
    scenes: []
  };
}

export function touchProject(p: OrbitryProject): OrbitryProject {
  return { ...p, updatedAt: new Date().toISOString() };
}

export function assertIsProject(data: any): asserts data is OrbitryProject {
  if (!data || typeof data !== 'object') throw new Error('Project is not an object');
  if (data.version !== 1) throw new Error('Unsupported project version');
  if (typeof data.title !== 'string') throw new Error('Project.title must be a string');
  if (!Array.isArray(data.scenes)) throw new Error('Project.scenes must be an array');
}

export function uid(prefix: string = 'id'): string {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
