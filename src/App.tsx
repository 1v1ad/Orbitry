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

  const hasScenes = scenes.length > 0;
  const hasHotspots = selectedScene ? selectedScene.hotspots.length > 0 : false;

  return (
    <div className="app">
      {/* Hidden file inputs — exactly as original (style display:none) */}
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

      {/* ── Sidebar ────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebarHeader">
          <div className="brand">
            <svg width="28" height="28" viewBox="0 0 28 28">
              <defs>
                <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#F0BE5C"/><stop offset="100%" stopColor="#D4922E"/></linearGradient>
                <linearGradient id="ls" x1="0.3" y1="0" x2="0.8" y2="1"><stop offset="0%" stopColor="#F0BE5C"/><stop offset="100%" stopColor="#B87A24"/></linearGradient>
              </defs>
              <ellipse cx="14" cy="14" rx="10.6" ry="4" fill="none" stroke="url(#lg)" strokeWidth="1.1" strokeLinecap="round" transform="rotate(-25,14,14)" opacity="0.85"/>
              <circle cx="14" cy="14" r="6.4" fill="url(#ls)"/>
              <polyline points="13,11 16,14 13,17" fill="none" stroke="#101318" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" opacity="0.85"/>
              <circle cx="22" cy="11.8" r="1.4" fill="#F0BE5C" transform="rotate(-25,14,14)"/>
            </svg>
            <span className="brandName">Orbitry</span>
            <span className="badge">Beta</span>
          </div>
        </div>

        <div className="sidebarScroll">

          {/* Step 1 — Import */}
          <div className="section">
            <div className="sectionHeader">
              <div className={`step ${hasScenes ? 'done' : ''}`}>1</div>
              <div className="sectionTitle">Import Panoramas</div>
              {hasScenes && <div className="count">{scenes.length}</div>}
            </div>
            {importing ? (
              <div className="importStatus">
                <div className="spinner" />
                {importStatus}
              </div>
            ) : (
              <button className="dropZone" onClick={onImportPanoramaClick}>
                <div className="dropIcon">📷</div>
                <div className="dropText">Click to add panoramas</div>
                <div className="dropHint">Equirectangular images (2:1 ratio)</div>
              </button>
            )}
          </div>

          {/* Step 2 — Scenes */}
          <div className="section">
            <div className="sectionHeader">
              <div className={`step ${hasScenes ? 'done' : ''}`}>2</div>
              <div className="sectionTitle">Scenes</div>
            </div>
            <div className="card">
              {project.scenes.length === 0 ? (
                <div className="emptyState">Import panoramas to create scenes</div>
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
                        const other = project.scenes.find((x) => x.id !== s.id)?.id ?? null;
                        setLinkTargetSceneId(other);
                      }}
                    >
                      <div className="sceneThumb">{hasAsset ? '360°' : '—'}</div>
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
          </div>

          {/* Step 3 — Hotspots */}
          <div className="section">
            <div className="sectionHeader">
              <div className={`step ${hasHotspots ? 'done' : ''}`}>3</div>
              <div className="sectionTitle">Hotspots</div>
              {selectedScene && selectedScene.hotspots.length > 0 && (
                <div className="count">{selectedScene.hotspots.length}</div>
              )}
            </div>
            <div className="card">
              {!selectedScene ? (
                <div className="emptyState">Select a scene to add hotspots</div>
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
                    <div className="small">
                      {selectedScene.hotspots.length} in this scene
                    </div>
                    <div style={{ flex: 1 }} />
                    <button className="btn btnSm" onClick={clearHotspots} disabled={selectedScene.hotspots.length === 0}>
                      Clear
                    </button>
                  </div>

                  <div className="segmented" aria-label="Interaction mode">
                    <button
                      className={`segBtn ${hotspotMode === 'navigate' ? 'active' : ''}`}
                      onClick={() => setHotspotMode('navigate')}
                    >
                      Move
                    </button>
                    <button
                      className={`segBtn ${hotspotMode === 'info' ? 'active' : ''}`}
                      onClick={() => setHotspotMode('info')}
                    >
                      Info
                    </button>
                    <button
                      className={`segBtn ${hotspotMode === 'link' ? 'active' : ''}`}
                      onClick={() => setHotspotMode('link')}
                      disabled={project.scenes.length < 2}
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
                      </div>
                    </div>
                  ) : (
                    <div className="small" style={{ marginTop: 10 }}>
                      Place an <strong>info hotspot</strong>: click (don't drag) inside the panorama.
                    </div>
                  )}

                  {selectedScene.hotspots.length > 0 ? (
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

                  {selectedHotspot ? (
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
                        </>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>

          {/* Step 4 — Save & Publish */}
          <div className="section">
            <div className="sectionHeader">
              <div className="step">4</div>
              <div className="sectionTitle">Save & Publish</div>
            </div>
            <div className="actionGroup">
              <button className="actionCard" onClick={saveProject} disabled={importing}>
                <div className="actionIcon save">💾</div>
                <div className="actionText">
                  <div className="actionLabel">Save Project</div>
                  <div className="actionDesc">Download .json to continue editing later</div>
                </div>
              </button>
              <button className="actionCard" onClick={onLoadProjectClick} disabled={importing}>
                <div className="actionIcon load">📂</div>
                <div className="actionText">
                  <div className="actionLabel">Open Project</div>
                  <div className="actionDesc">Load a previously saved .json file</div>
                </div>
              </button>
              <button className="actionCard" onClick={onExportViewerClick} disabled={importing || project.scenes.length === 0}>
                <div className="actionIcon publish">🚀</div>
                <div className="actionText">
                  <div className="actionLabel">Export Viewer</div>
                  <div className="actionDesc">Download standalone tour to share</div>
                </div>
              </button>
            </div>
          </div>

        </div>
      </aside>

      {/* ── Viewer ─────────────────────────────── */}
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
            if (hotspotMode !== 'navigate') return;
            if (project.scenes.some((s) => s.id === targetId)) {
              setSelectedSceneId(targetId);
              setSelectedHotspotId(null);
            }
          }}
        />

        {/* Overlay badges */}
        {selectedScene && selectedPanoramaUrl && (
          <div className="viewerOverlay">
            <div className="hint">
              {hotspotMode === 'navigate' && <>Drag to look around</>}
              {hotspotMode === 'info' && <>Click to place <strong>info hotspot</strong></>}
              {hotspotMode === 'link' && <>Click to place <strong>link arrow</strong></>}
            </div>
            <div className="hint">
              <strong>{selectedScene.name}</strong> · {selectedScene.hotspots.length} hotspots
            </div>
          </div>
        )}

        {toast ? <div className="toast">{toast}</div> : null}
      </main>
    </div>
  );
}
