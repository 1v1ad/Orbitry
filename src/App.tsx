import { useMemo, useRef, useState } from 'react';
import MarzipanoViewer from './components/MarzipanoViewer';
import {
  assertIsProject,
  createEmptyProject,
  touchProject,
  uid,
  type OrbitryProject,
  type OrbitryScene,
  type OrbitryHotspot
} from './lib/project';
import { downloadText } from './lib/download';

type AssetMap = Record<string, { file: File; url: string }>; // by sceneId

export default function App() {
  const [project, setProject] = useState<OrbitryProject>(() => createEmptyProject('Orbitry MVP'));
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetMap>({});

  const importPanoramaInputRef = useRef<HTMLInputElement | null>(null);
  const loadProjectInputRef = useRef<HTMLInputElement | null>(null);

  const scenes = project.scenes;
  const selectedScene = useMemo(() => scenes.find((s) => s.id === selectedSceneId) || null, [scenes, selectedSceneId]);
  const selectedPanoramaUrl = selectedSceneId ? assets[selectedSceneId]?.url : undefined;

  const onImportPanoramaClick = () => importPanoramaInputRef.current?.click();
  const onLoadProjectClick = () => loadProjectInputRef.current?.click();

  async function inferImageSize(file: File): Promise<{ width?: number; height?: number }> {
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      const p = new Promise<{ width: number; height: number }>((resolve, reject) => {
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = () => reject(new Error('Failed to load image'));
      });
      img.src = url;
      const { width, height } = await p;
      URL.revokeObjectURL(url);
      return { width, height };
    } catch {
      return {};
    }
  }

  async function handleImportFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    const newScenes: OrbitryScene[] = [];
    const newAssets: AssetMap = {};

    for (const file of Array.from(files)) {
      const id = uid('scene');
      const baseName = file.name.replace(/\.[^/.]+$/, '');
      const { width, height } = await inferImageSize(file);

      const scene: OrbitryScene = {
        id,
        name: baseName || `Scene ${project.scenes.length + newScenes.length + 1}`,
        panorama: {
          type: 'equirect',
          label: 'Imported equirect',
          fileName: file.name,
          width,
          height
        },
        initialView: {
          yaw: 0,
          pitch: 0,
          fov: 1.25
        },
        hotspots: []
      };

      const url = URL.createObjectURL(file);
      newAssets[id] = { file, url };
      newScenes.push(scene);
    }

    setAssets((prev) => ({ ...prev, ...newAssets }));
    setProject((prev) => touchProject({ ...prev, scenes: [...prev.scenes, ...newScenes] }));

    if (!selectedSceneId && newScenes.length > 0) setSelectedSceneId(newScenes[0].id);
  }

  function saveProject() {
    const json = JSON.stringify(project, null, 2);
    downloadText('orbitry.project.json', json, 'application/json');
  }

  async function loadProject(file: File) {
    const text = await file.text();
    const data = JSON.parse(text);
    assertIsProject(data);

    // Note: assets are not embedded in the project file in MVP.
    // We load the structure and keep any already-imported images (if ids match).
    setProject(data);
    setSelectedSceneId(data.scenes[0]?.id ?? null);
  }

  function addInfoHotspot(yaw: number, pitch: number) {
    if (!selectedScene) return;

    const hotspot: OrbitryHotspot = {
      id: uid('hs'),
      type: 'info',
      yaw,
      pitch,
      title: `Info ${selectedScene.hotspots.length + 1}`,
      text: ''
    };

    setProject((prev) => {
      const scenes = prev.scenes.map((s) => (s.id === selectedScene.id ? { ...s, hotspots: [...s.hotspots, hotspot] } : s));
      return touchProject({ ...prev, scenes });
    });
  }

  function clearHotspots() {
    if (!selectedScene) return;
    setProject((prev) => {
      const scenes = prev.scenes.map((s) => (s.id === selectedScene.id ? { ...s, hotspots: [] } : s));
      return touchProject({ ...prev, scenes });
    });
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span>Orbitry</span>
          <span className="badge">MVP editor</span>
        </div>

        <div className="spacer" />

        <button className="btn primary" onClick={onImportPanoramaClick}>Import panoramas</button>
        <button className="btn" onClick={saveProject}>Save project</button>
        <button className="btn" onClick={onLoadProjectClick}>Load project</button>

        <input
          ref={importPanoramaInputRef}
          type="file"
          accept="image/jpeg,image/jpg,image/png,image/tiff,image/tif"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => handleImportFiles(e.target.files)}
        />
        <input
          ref={loadProjectInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) loadProject(f);
          }}
        />
      </div>

      <div className="layout">
        <aside className="sidebar">
          <h2>Project</h2>
          <div className="card">
            <div style={{ fontWeight: 800, fontSize: 14 }}>{project.title}</div>
            <div style={{ marginTop: 6, color: 'var(--muted)', fontSize: 12 }}>
              Scenes: {project.scenes.length} • Updated: {new Date(project.updatedAt).toLocaleString()}
            </div>
          </div>

          <h2>Scenes</h2>
          <div className="card">
            {project.scenes.length === 0 ? (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                No scenes yet. Click <strong>Import panoramas</strong>.
              </div>
            ) : (
              project.scenes.map((s) => {
                const active = s.id === selectedSceneId;
                const hasAsset = !!assets[s.id];
                return (
                  <div
                    key={s.id}
                    className={`sceneItem ${active ? 'active' : ''}`}
                    onClick={() => setSelectedSceneId(s.id)}
                  >
                    <div className="sceneThumb">{hasAsset ? '360' : '—'}</div>
                    <div className="sceneMeta">
                      <div className="sceneName">{s.name}</div>
                      <div className="sceneSub">
                        {s.panorama.fileName ?? 'no file'}{s.panorama.width ? ` • ${s.panorama.width}×${s.panorama.height}` : ''}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <h2>Hotspots</h2>
          <div className="card">
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                {selectedScene ? `${selectedScene.hotspots.length} in this scene` : 'Select a scene'}
              </div>
              <div style={{ flex: 1 }} />
              <button className="btn" onClick={clearHotspots} disabled={!selectedScene || selectedScene.hotspots.length === 0}>
                Clear
              </button>
            </div>
            <div style={{ marginTop: 10, color: 'var(--muted)', fontSize: 12, lineHeight: 1.5 }}>
              MVP: click inside the panorama to add an <strong>info hotspot</strong>.
              Link hotspots and theme editor come next.
            </div>
          </div>

          <h2>Next</h2>
          <div className="card" style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
            <div>✅ Local-first editor shell</div>
            <div>✅ Project format (v1)</div>
            <div>✅ Import equirect panoramas</div>
            <div>✅ Click-to-add hotspots</div>
            <div style={{ marginTop: 8 }}>Up next: link hotspots, import Marzipano <code>APP_DATA</code>, export bundles.</div>
          </div>
        </aside>

        <main className="viewerWrap">
          <MarzipanoViewer
            scene={selectedScene ?? undefined}
            panoramaUrl={selectedPanoramaUrl}
            hotspots={selectedScene?.hotspots ?? []}
            onClickInViewer={(coords) => addInfoHotspot(coords.yaw, coords.pitch)}
          />
        </main>
      </div>
    </div>
  );
}
