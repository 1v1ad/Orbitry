import { useMemo, useRef, useState } from 'react';
import MarzipanoViewer from './components/MarzipanoViewer';
import {
  assertIsProject,
  createEmptyProject,
  touchProject,
  uid,
  type OrbitryProject,
  type OrbitryScene,
  type OrbitryHotspot,
  type OrbitryInfoHotspot,
  type OrbitryLinkHotspot
} from './lib/project';
import { downloadText } from './lib/download';
import { exportViewer } from './lib/exportViewer';
import {
  getSafeMaxTextureSize,
  loadAssetFromIdb,
  processEquirectToSafeBlob,
  saveAssetToIdb,
  type StoredAsset
} from './lib/assets';

type AssetMap = Record<string, (StoredAsset & { url: string })>; // by sceneId
type HotspotMode = 'navigate' | 'info' | 'link';

export default function App() {
  const [project, setProject] = useState<OrbitryProject>(() => createEmptyProject('Orbitry MVP'));
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetMap>({});

  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string>('');
  const [toast, setToast] = useState<string | null>(null);

  // Default to navigation so the user can immediately drag to look around
  // without accidentally placing hotspots.
  const [hotspotMode, setHotspotMode] = useState<HotspotMode>('navigate');
  const [linkTargetSceneId, setLinkTargetSceneId] = useState<string | null>(null);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);

  const importPanoramaInputRef = useRef<HTMLInputElement | null>(null);
  const loadProjectInputRef = useRef<HTMLInputElement | null>(null);

  const scenes = project.scenes;
  const selectedScene = useMemo(() => scenes.find((s) => s.id === selectedSceneId) || null, [scenes, selectedSceneId]);
  const selectedPanoramaUrl = selectedSceneId ? assets[selectedSceneId]?.url : undefined;

  const onImportPanoramaClick = () => importPanoramaInputRef.current?.click();
  const onLoadProjectClick = () => loadProjectInputRef.current?.click();

  async function onExportViewerClick() {
    try {
      // Strip runtime-only URL field.
      const assetsForExport: Record<string, StoredAsset | undefined> = {};
      for (const [sceneId, a] of Object.entries(assets)) {
        assetsForExport[sceneId] = {
          sceneId: a.sceneId,
          fileName: a.fileName,
          blob: a.blob,
          width: a.width,
          height: a.height,
          originalWidth: a.originalWidth,
          originalHeight: a.originalHeight,
          // Keep required metadata for StoredAsset.
          updatedAt: a.updatedAt || new Date().toISOString()
        };
      }

      const res = await exportViewer(project, assetsForExport);
      if (res.mode === 'folder') {
        showToast(`Exported viewer to folder: ${res.folderName}`);
      } else {
        showToast('Downloaded viewer HTML');
      }
    } catch (e: any) {
      console.error(e);
      showToast(`Export failed: ${e?.message || String(e)}`);
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    window.clearTimeout((showToast as any)._t);
    (showToast as any)._t = window.setTimeout(() => setToast(null), 2800);
  }

  function upsertAsset(sceneId: string, asset: StoredAsset) {
    setAssets((prev) => {
      const next = { ...prev };
      const prevAsset = next[sceneId];
      if (prevAsset?.url) {
        try {
          URL.revokeObjectURL(prevAsset.url);
        } catch {
          // ignore
        }
      }
      const url = URL.createObjectURL(asset.blob);
      next[sceneId] = { ...asset, url };
      return next;
    });
  }

  async function handleImportFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setImporting(true);
    setImportStatus('Preparing…');

    const safeMax = await getSafeMaxTextureSize();
    const newScenes: OrbitryScene[] = [];

    let idx = 0;
    for (const file of Array.from(files)) {
      idx += 1;
      setImportStatus(`Processing ${idx}/${files.length}: ${file.name}`);

      // Decode & (if needed) downscale to a safe size for WebGL.
      const { blob, width, height, originalWidth, originalHeight, fileName } = await processEquirectToSafeBlob(file, {
        forceMaxSize: safeMax,
        mime: 'image/jpeg',
        quality: 0.9
      });

      const id = uid('scene');
      const baseName = file.name.replace(/\.[^/.]+$/, '');

      const scene: OrbitryScene = {
        id,
        name: baseName || `Scene ${project.scenes.length + newScenes.length + 1}`,
        panorama: {
          type: 'equirect',
          label: originalWidth !== width ? `Imported (scaled to ${width}×${height})` : 'Imported equirect',
          fileName: fileName,
          width: originalWidth,
          height: originalHeight
        },
        initialView: {
          yaw: 0,
          pitch: 0,
          fov: 1.25
        },
        hotspots: []
      };

      const stored: StoredAsset = {
        sceneId: id,
        fileName,
        blob,
        width,
        height,
        originalWidth,
        originalHeight,
        updatedAt: new Date().toISOString()
      };

      await saveAssetToIdb(stored);
      upsertAsset(id, stored);
      newScenes.push(scene);
    }

    setProject((prev) => touchProject({ ...prev, scenes: [...prev.scenes, ...newScenes] }));

    if (!selectedSceneId && newScenes.length > 0) setSelectedSceneId(newScenes[0].id);

    // Default link target to the first other scene.
    if (newScenes.length > 0) {
      const firstSceneId = (selectedSceneId ?? newScenes[0].id);
      const all = [...project.scenes, ...newScenes].map((s) => s.id);
      const other = all.find((id) => id !== firstSceneId) ?? null;
      if (!linkTargetSceneId) setLinkTargetSceneId(other);
    }

    setImporting(false);
    setImportStatus('');
    showToast('Panorama imported ✅');
  }

  function saveProject() {
    const json = JSON.stringify(project, null, 2);
    downloadText('orbitry.project.json', json, 'application/json');
  }

  async function loadProject(file: File) {
    const text = await file.text();
    const data = JSON.parse(text);
    assertIsProject(data);

    setProject(data);
    setSelectedSceneId(data.scenes[0]?.id ?? null);
    setSelectedHotspotId(null);

    // Try to rehydrate assets from IndexedDB (local-first behaviour).
    for (const s of data.scenes) {
      const asset = await loadAssetFromIdb(s.id);
      if (asset) upsertAsset(s.id, asset);
    }

    // Pick a sane default link target.
    const firstId = data.scenes[0]?.id ?? null;
    const other = data.scenes.find((s) => s.id !== firstId)?.id ?? null;
    setLinkTargetSceneId(other);

    showToast('Project loaded ✅');
  }

  function addInfoHotspot(yaw: number, pitch: number) {
    if (!selectedScene) return;

    const hotspot: OrbitryInfoHotspot = {
      id: uid('hs'),
      type: 'info',
      yaw,
      pitch,
      title: `Info ${selectedScene.hotspots.filter((h) => h.type === 'info').length + 1}`,
      text: ''
    };

    setProject((prev) => {
      const scenes = prev.scenes.map((s) => (s.id === selectedScene.id ? { ...s, hotspots: [...s.hotspots, hotspot] } : s));
      return touchProject({ ...prev, scenes });
    });
    setSelectedHotspotId(hotspot.id);
  }

  function addLinkHotspot(yaw: number, pitch: number) {
    if (!selectedScene) return;
    const target = linkTargetSceneId;
    if (!target) {
      showToast('Select target scene for link hotspot');
      return;
    }
    if (target === selectedScene.id) {
      showToast('Link target must be a different scene');
      return;
    }

    const hotspot: OrbitryLinkHotspot = {
      id: uid('hs'),
      type: 'link',
      yaw,
      pitch,
      targetSceneId: target,
      rotation: 0
    };

    setProject((prev) => {
      const scenes = prev.scenes.map((s) => (s.id === selectedScene.id ? { ...s, hotspots: [...s.hotspots, hotspot] } : s));
      return touchProject({ ...prev, scenes });
    });
    setSelectedHotspotId(hotspot.id);
  }

  function clearHotspots() {
    if (!selectedScene) return;
    setProject((prev) => {
      const scenes = prev.scenes.map((s) => (s.id === selectedScene.id ? { ...s, hotspots: [] } : s));
      return touchProject({ ...prev, scenes });
    });
    setSelectedHotspotId(null);
  }

  function deleteHotspot(hotspotId: string) {
    if (!selectedScene) return;
    setProject((prev) => {
      const scenes = prev.scenes.map((s) =>
        s.id === selectedScene.id ? { ...s, hotspots: s.hotspots.filter((h) => h.id !== hotspotId) } : s
      );
      return touchProject({ ...prev, scenes });
    });
    if (selectedHotspotId === hotspotId) setSelectedHotspotId(null);
  }

  function updateHotspot(hotspotId: string, patch: Partial<OrbitryHotspot>) {
    if (!selectedScene) return;
    setProject((prev) => {
      const scenes = prev.scenes.map((s) => {
        if (s.id !== selectedScene.id) return s;
        const hotspots = s.hotspots.map((h) => (h.id === hotspotId ? ({ ...h, ...patch } as OrbitryHotspot) : h));
        return { ...s, hotspots };
      });
      return touchProject({ ...prev, scenes });
    });
  }

  const selectedHotspot = useMemo(() => {
    if (!selectedScene || !selectedHotspotId) return null;
    return selectedScene.hotspots.find((h) => h.id === selectedHotspotId) ?? null;
  }, [selectedScene, selectedHotspotId]);

  const linkTargets = useMemo(() => {
    if (!selectedScene) return [];
    return project.scenes.filter((s) => s.id !== selectedScene.id);
  }, [project.scenes, selectedScene?.id]);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span>Orbitry</span>
          <span className="badge">MVP editor</span>
        </div>

        <div className="spacer" />

        <button className="btn primary" onClick={onImportPanoramaClick} disabled={importing}>
          {importing ? 'Importing…' : 'Import panoramas'}
        </button>
        <button className="btn" onClick={saveProject} disabled={importing}>Save project</button>
        <button className="btn" onClick={onLoadProjectClick} disabled={importing}>Load project</button>
        <button className="btn" onClick={onExportViewerClick} disabled={importing || project.scenes.length === 0}>
          Export viewer
        </button>

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

        {importing ? <div className="topStatus">{importStatus}</div> : null}
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
                    onClick={() => {
                      setSelectedSceneId(s.id);
                      setSelectedHotspotId(null);
                      // Auto-fix link target when switching scenes.
                      const other = project.scenes.find((x) => x.id !== s.id)?.id ?? null;
                      setLinkTargetSceneId(other);
                    }}
                  >
                    <div className="sceneThumb">{hasAsset ? '360' : '—'}</div>
                    <div className="sceneMeta">
                      <div className="sceneName">{s.name}</div>
                      <div className="sceneSub">
                        {s.panorama.fileName ?? 'no file'}
                        {s.panorama.width ? ` • ${s.panorama.width}×${s.panorama.height}` : ''}
                        {assets[s.id] && (assets[s.id].originalWidth !== assets[s.id].width) ? ` → ${assets[s.id].width}×${assets[s.id].height}` : ''}
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

            <div style={{ marginTop: 10 }}>
              <div className="segmented" aria-label="Interaction mode">
                <button
                  className={`segBtn ${hotspotMode === 'navigate' ? 'active' : ''}`}
                  onClick={() => setHotspotMode('navigate')}
                  disabled={!selectedScene}
                >
                  Move
                </button>
                <button
                  className={`segBtn ${hotspotMode === 'info' ? 'active' : ''}`}
                  onClick={() => setHotspotMode('info')}
                  disabled={!selectedScene}
                >
                  Info
                </button>
                <button
                  className={`segBtn ${hotspotMode === 'link' ? 'active' : ''}`}
                  onClick={() => setHotspotMode('link')}
                  disabled={!selectedScene || project.scenes.length < 2}
                >
                  Link
                </button>
              </div>

              {hotspotMode === 'navigate' ? (
                <div className="small" style={{ marginTop: 10 }}>
                  Drag to look around. Switch to <strong>Info</strong> or <strong>Link</strong> to place hotspots.
                </div>
              ) : hotspotMode === 'link' ? (
                <div style={{ marginTop: 10 }}>
                  <div className="fieldLabel">Link target</div>
                  <select
                    className="select"
                    value={linkTargetSceneId ?? ''}
                    onChange={(e) => setLinkTargetSceneId(e.target.value || null)}
                    disabled={!selectedScene || linkTargets.length === 0}
                  >
                    <option value="">— select —</option>
                    {linkTargets.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  <div className="small" style={{ marginTop: 8 }}>
                    Place a <strong>link hotspot</strong>: pick target, then click inside the panorama.
                    Click a link hotspot in the viewer to move.
                  </div>
                </div>
              ) : (
                <div className="small" style={{ marginTop: 10 }}>
                  Place an <strong>info hotspot</strong>: click (don’t drag) inside the panorama.
                </div>
              )}
            </div>

            {selectedScene && selectedScene.hotspots.length > 0 ? (
              <div style={{ marginTop: 12 }}>
                <div className="fieldLabel">In this scene</div>
                <div className="hsList">
                  {selectedScene.hotspots.map((h) => {
                    const active = h.id === selectedHotspotId;
                    const badge = h.type === 'link' ? '↗' : 'i';
                    const title = h.type === 'link'
                      ? `Link → ${project.scenes.find((s) => s.id === (h as OrbitryLinkHotspot).targetSceneId)?.name ?? (h as OrbitryLinkHotspot).targetSceneId}`
                      : ((h as OrbitryInfoHotspot).title || 'Info hotspot');

                    return (
                      <div key={h.id} className={`hsItem ${active ? 'active' : ''}`} onClick={() => setSelectedHotspotId(h.id)}>
                        <div className="hsBadge">{badge}</div>
                        <div className="hsTitle">{title}</div>
                        <button
                          className="iconBtn"
                          title="Delete"
                          onClick={(ev) => { ev.stopPropagation(); deleteHotspot(h.id); }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {selectedScene && selectedHotspot ? (
              <div style={{ marginTop: 12 }}>
                <div className="fieldLabel">Edit selected</div>
                {selectedHotspot.type === 'info' ? (
                  <>
                    <input
                      className="input"
                      placeholder="Title"
                      value={(selectedHotspot as OrbitryInfoHotspot).title ?? ''}
                      onChange={(e) => updateHotspot(selectedHotspot.id, { title: e.target.value })}
                    />
                    <textarea
                      className="textarea"
                      placeholder="Text (optional)"
                      value={(selectedHotspot as OrbitryInfoHotspot).text ?? ''}
                      onChange={(e) => updateHotspot(selectedHotspot.id, { text: e.target.value })}
                    />
                  </>
                ) : (
                  <>
                    <select
                      className="select"
                      value={(selectedHotspot as OrbitryLinkHotspot).targetSceneId}
                      onChange={(e) => updateHotspot(selectedHotspot.id, { targetSceneId: e.target.value })}
                    >
                      {linkTargets.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>

                    <div style={{ marginTop: 10 }}>
                      <div className="fieldLabel">Direction</div>
                      <input
                        className="input"
                        type="range"
                        min={-3.14159}
                        max={3.14159}
                        step={0.01}
                        value={(selectedHotspot as OrbitryLinkHotspot).rotation ?? 0}
                        onChange={(e) => updateHotspot(selectedHotspot.id, { rotation: Number(e.target.value) } as any)}
                      />
                      <div className="small" style={{ marginTop: 6 }}>
                        Tip: select the link hotspot in the viewer and drag the small ↻ handle to rotate the arrow.
                      </div>
                    </div>
                    <div className="small" style={{ marginTop: 8 }}>
                      This hotspot moves to the selected scene.
                    </div>
                  </>
                )}
              </div>
            ) : null}
          </div>

          <h2>Next</h2>
          <div className="card" style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.6 }}>
            <div>✅ Local-first editor shell</div>
            <div>✅ Project format (v1)</div>
            <div>✅ Import equirect panoramas (safe downscale)</div>
            <div>✅ Info + Link hotspots</div>
            <div style={{ marginTop: 8 }}>
              Up next: import Marzipano <code>APP_DATA</code>, export bundles.
            </div>
          </div>
        </aside>

        <main className="viewerWrap">
          <MarzipanoViewer
            scene={selectedScene ?? undefined}
            panoramaUrl={selectedPanoramaUrl}
            hotspots={selectedScene?.hotspots ?? []}
            interactionMode={hotspotMode}
            selectedHotspotId={selectedHotspotId}
            onSelectHotspot={(id) => setSelectedHotspotId(id)}
            onUpdateLinkRotation={(id, rotation) => updateHotspot(id, { rotation } as any)}
            onClickInViewer={(coords) => {
              if (!selectedScene) return;
              if (hotspotMode === 'navigate') return;
              if (hotspotMode === 'link') addLinkHotspot(coords.yaw, coords.pitch);
              else addInfoHotspot(coords.yaw, coords.pitch);
            }}
            onLinkHotspotClick={(targetId) => {
              // Navigation works only in Move mode; in edit modes we select instead.
              if (hotspotMode !== 'navigate') return;
              if (project.scenes.some((s) => s.id === targetId)) {
                setSelectedSceneId(targetId);
                setSelectedHotspotId(null);
              }
            }}
          />

          {toast ? <div className="toast">{toast}</div> : null}
        </main>
      </div>
    </div>
  );
}
