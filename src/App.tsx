import React, { useMemo, useRef, useState } from 'react';
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

type AssetMap = Record<string, (StoredAsset & { url: string })>;
type HotspotMode = 'navigate' | 'info' | 'link';

// Железобетонное скрытие элементов, чтобы не было "призраков"
const hiddenInputStyle: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  borderWidth: 0,
};

export default function App() {
  const [project, setProject] = useState<OrbitryProject>(() => createEmptyProject('Orbitry MVP'));
  const [selectedSceneId, setSelectedSceneId] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetMap>({});

  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string>('');
  const [toast, setToast] = useState<string | null>(null);

  const [hotspotMode, setHotspotMode] = useState<HotspotMode>('navigate');
  const [linkTargetSceneId, setLinkTargetSceneId] = useState<string | null>(null);
  const [selectedHotspotId, setSelectedHotspotId] = useState<string | null>(null);

  const loadProjectInputRef = useRef<HTMLInputElement | null>(null);
  const panoramaInputRef = useRef<HTMLInputElement | null>(null);

  const scenes = project.scenes;
  const selectedScene = useMemo(() => scenes.find((s) => s.id === selectedSceneId) || null, [scenes, selectedSceneId]);
  const selectedPanoramaUrl = selectedSceneId ? assets[selectedSceneId]?.url : undefined;

  // ── Toast ──────────────────────────────────────

  function showToast(msg: string) {
    setToast(msg);
    window.clearTimeout((showToast as any)._t);
    (showToast as any)._t = window.setTimeout(() => setToast(null), 3500);
  }

  // ── Asset helpers ──────────────────────────────

  function upsertAsset(sceneId: string, asset: StoredAsset) {
    setAssets((prev) => {
      const next = { ...prev };
      const prevAsset = next[sceneId];
      if (prevAsset?.url) {
        try { URL.revokeObjectURL(prevAsset.url); } catch { /* ignore */ }
      }
      const url = URL.createObjectURL(asset.blob);
      next[sceneId] = { ...asset, url };
      return next;
    });
  }

  // ── Import ─────────────────────────────────────

  async function handleImportFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setImporting(true);
    setImportStatus('Preparing…');

    try {
      const safeMax = await getSafeMaxTextureSize();
      const newScenes: OrbitryScene[] = [];

      let idx = 0;
      for (const file of Array.from(files)) {
        idx += 1;
        setImportStatus(`Processing ${idx}/${files.length}: ${file.name}`);

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
            fileName,
            width: originalWidth,
            height: originalHeight
          },
          initialView: { yaw: 0, pitch: 0, fov: 1.25 },
          hotspots: []
        };

        const stored: StoredAsset = { sceneId: id, fileName, blob, width, height, originalWidth, originalHeight, updatedAt: new Date().toISOString() };
        await saveAssetToIdb(stored);
        upsertAsset(id, stored);
        newScenes.push(scene);
      }

      setProject((prev) => touchProject({ ...prev, scenes: [...prev.scenes, ...newScenes] }));
      if (!selectedSceneId && newScenes.length > 0) setSelectedSceneId(newScenes[0].id);

      if (newScenes.length > 0) {
        const firstSceneId = (selectedSceneId ?? newScenes[0].id);
        const all = [...project.scenes, ...newScenes].map((s) => s.id);
        const other = all.find((id) => id !== firstSceneId) ?? null;
        if (!linkTargetSceneId) setLinkTargetSceneId(other);
      }

      setImporting(false);
      setImportStatus('');
      showToast(`${newScenes.length} panorama${newScenes.length > 1 ? 's' : ''} imported`);
    } catch (err: any) {
      console.error('Import error:', err);
      setImporting(false);
      setImportStatus('');
      showToast(`Import error: ${err.message || String(err)}`);
    }
  }

  // ── Project save / load ────────────────────────

  function saveProject() {
    const json = JSON.stringify(project, null, 2);
    downloadText('orbitry.project.json', json, 'application/json');
    showToast('Project saved');
  }

  async function loadProject(file: File) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      assertIsProject(data);

      setProject(data);
      setSelectedSceneId(data.scenes[0]?.id ?? null);
      setSelectedHotspotId(null);

      for (const s of data.scenes) {
        const asset = await loadAssetFromIdb(s.id);
        if (asset) upsertAsset(s.id, asset);
      }

      const firstId = data.scenes[0]?.id ?? null;
      const other = data.scenes.find((s) => s.id !== firstId)?.id ?? null;
      setLinkTargetSceneId(other);
      showToast('Project loaded');
    } catch (err: any) {
      console.error('Load project error:', err);
      showToast(`Failed to load project: ${err.message || String(err)}`);
    }
  }

  async function onPublishClick() {
    try {
      const assetsForExport: Record<string, StoredAsset | undefined> = {};
      for (const [sceneId, a] of Object.entries(assets)) {
        assetsForExport[sceneId] = {
          sceneId: a.sceneId, fileName: a.fileName, blob: a.blob,
          width: a.width, height: a.height, originalWidth: a.originalWidth,
          originalHeight: a.originalHeight, updatedAt: a.updatedAt || new Date().toISOString()
        };
      }
      const res = await exportViewer(project, assetsForExport);
      if (res.mode === 'folder') {
        showToast(`Published to folder: ${res.folderName}`);
      } else {
        showToast('Tour downloaded as HTML');
      }
    } catch (e: any) {
      console.error(e);
      showToast(`Publish failed: ${e?.message || String(e)}`);
    }
  }

  // ── Hotspot CRUD ───────────────────────────────

  function addInfoHotspot(yaw: number, pitch: number) {
    if (!selectedScene) return;
    const hotspot: OrbitryInfoHotspot = {
      id: uid('hs'), type: 'info', yaw, pitch,
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
    if (!target) { showToast('Select target scene for link hotspot'); return; }
    if (target === selectedScene.id) { showToast('Link target must be a different scene'); return; }

    const hotspot: OrbitryLinkHotspot = { id: uid('hs'), type: 'link', yaw, pitch, targetSceneId: target, rotation: 0 };
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

  // ── Render ─────────────────────────────────────

  return (
    <div className="app">
      {/* Hidden load-project input */}
      <input
        ref={loadProjectInputRef}
        type="file"
        accept="application/json,.json"
        style={hiddenInputStyle}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadProject(f);
          e.target.value = '';
        }}
      />

      {/* ── Sidebar ────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <div className="brand-logo">O</div>
            <span className="brand-name">Orbitry</span>
            <span className="brand-tag">Beta</span>
          </div>
        </div>

        <div className="sidebar-scroll">

          {/* ── Step 1: Import ──────────────────── */}
          <div className="section">
            <div className="section-header">
              <div className={`section-step ${hasScenes ? 'done' : ''}`}>1</div>
              <div className="section-title">Import Panoramas</div>
              {hasScenes && <div className="section-count">{scenes.length}</div>}
            </div>

            {importing ? (
              <div className="import-status">
                <div className="import-spinner" />
                {importStatus}
              </div>
            ) : (
              <div 
                className="drop-zone" 
                onClick={() => panoramaInputRef.current?.click()}
                style={{ cursor: 'pointer' }}
              >
                <input
                  ref={panoramaInputRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,image/tiff,image/tif"
                  multiple
                  style={hiddenInputStyle}
                  onChange={(e) => { 
                    handleImportFiles(e.target.files); 
                    e.target.value = ''; 
                  }}
                />
                <div className="drop-zone-icon">📷</div>
                <div className="drop-zone-text">Click to add panoramas</div>
                <div className="drop-zone-hint">Equirectangular images (2:1 ratio)</div>
              </div>
            )}
          </div>

          {/* ── Step 2: Scenes ──────────────────── */}
          <div className="section">
            <div className="section-header">
              <div className={`section-step ${hasScenes ? 'done' : ''}`}>2</div>
              <div className="section-title">Scenes</div>
            </div>

            {!hasScenes ? (
              <div className="empty-state">
                Import panoramas to create scenes
              </div>
            ) : (
              <div className="scene-list">
                {scenes.map((s) => {
                  const active = s.id === selectedSceneId;
                  const hasAsset = !!assets[s.id];
                  return (
                    <div
                      key={s.id}
                      className={`scene-item ${active ? 'active' : ''}`}
                      onClick={() => {
                        setSelectedSceneId(s.id);
                        setSelectedHotspotId(null);
                        const other = project.scenes.find((x) => x.id !== s.id)?.id ?? null;
                        setLinkTargetSceneId(other);
                      }}
                    >
                      <div className="scene-thumb">
                        <span className="scene-thumb-label">{hasAsset ? '360°' : '—'}</span>
                      </div>
                      <div className="scene-meta">
                        <div className="scene-name">{s.name}</div>
                        <div className="scene-detail">
                          {s.panorama.fileName ?? 'no file'}
                          {s.panorama.width ? ` · ${s.panorama.width}×${s.panorama.height}` : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Step 3: Hotspots ────────────────── */}
          <div className="section">
            <div className="section-header">
              <div className={`section-step ${hasHotspots ? 'done' : ''}`}>3</div>
              <div className="section-title">Hotspots</div>
              {selectedScene && selectedScene.hotspots.length > 0 && (
                <div className="section-count">{selectedScene.hotspots.length}</div>
              )}
            </div>

            {!selectedScene ? (
              <div className="empty-state">
                Select a scene to add hotspots
              </div>
            ) : (
              <>
                <div className="mode-switcher">
                  <button
                    className={`mode-btn ${hotspotMode === 'navigate' ? 'active' : ''}`}
                    onClick={() => setHotspotMode('navigate')}
                  >
                    ◎ Move
                  </button>
                  <button
                    className={`mode-btn ${hotspotMode === 'info' ? 'active' : ''}`}
                    onClick={() => setHotspotMode('info')}
                  >
                    ℹ Info
                  </button>
                  <button
                    className={`mode-btn ${hotspotMode === 'link' ? 'active' : ''}`}
                    onClick={() => setHotspotMode('link')}
                    disabled={scenes.length < 2}
                  >
                    ↗ Link
                  </button>
                </div>

                {hotspotMode === 'navigate' && (
                  <div className="mode-hint">
                    Drag to look around. Switch to <strong>Info</strong> or <strong>Link</strong> to place hotspots.
                  </div>
                )}

                {hotspotMode === 'info' && (
                  <div className="mode-hint">
                    Click inside the panorama to place an <strong>info hotspot</strong>.
                  </div>
                )}

                {hotspotMode === 'link' && (
                  <>
                    <div style={{ marginTop: 8 }}>
                      <div className="field-label">Link target</div>
                      <select
                        className="select"
                        value={linkTargetSceneId ?? ''}
                        onChange={(e) => setLinkTargetSceneId(e.target.value || null)}
                        disabled={linkTargets.length === 0}
                      >
                        <option value="">— select —</option>
                        {linkTargets.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="mode-hint">
                      Pick a target scene, then click the panorama to place a <strong>link arrow</strong>.
                    </div>
                  </>
                )}

                {/* Hotspot list */}
                {selectedScene.hotspots.length > 0 && (
                  <div className="hs-list">
                    {selectedScene.hotspots.map((h) => {
                      const active = h.id === selectedHotspotId;
                      const isLink = h.type === 'link';
                      const title = isLink
                        ? `→ ${project.scenes.find((s) => s.id === (h as OrbitryLinkHotspot).targetSceneId)?.name ?? (h as OrbitryLinkHotspot).targetSceneId}`
                        : ((h as OrbitryInfoHotspot).title || 'Info hotspot');

                      return (
                        <div key={h.id} className={`hs-item ${active ? 'active' : ''}`} onClick={() => setSelectedHotspotId(h.id)}>
                          <div className={`hs-badge ${isLink ? 'link-badge' : 'info-badge'}`}>
                            {isLink ? '↗' : 'i'}
                          </div>
                          <div className="hs-title">{title}</div>
                          <button
                            className="btn btn-icon btn-ghost hs-delete"
                            title="Delete"
                            onClick={(ev) => { ev.stopPropagation(); deleteHotspot(h.id); }}
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}

                    <button
                      className="btn btn-sm btn-ghost"
                      style={{ marginTop: 4, color: 'var(--danger)', justifyContent: 'flex-start' }}
                      onClick={clearHotspots}
                    >
                      Clear all hotspots
                    </button>
                  </div>
                )}

                {/* Hotspot editor */}
                {selectedHotspot && (
                  <div className="hs-editor">
                    <div className="field-label">Edit selected</div>
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
                          placeholder="Description (optional)"
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
                        <div style={{ marginTop: 8 }}>
                          <div className="field-label">Arrow direction</div>
                          <input
                            className="input"
                            type="range"
                            min={-3.14159}
                            max={3.14159}
                            step={0.01}
                            value={(selectedHotspot as OrbitryLinkHotspot).rotation ?? 0}
                            onChange={(e) => updateHotspot(selectedHotspot.id, { rotation: Number(e.target.value) } as any)}
                            style={{ padding: '4px 0' }}
                          />
                        </div>
                        <div className="mode-hint" style={{ padding: '4px 0 0' }}>
                          Drag the ↻ handle in the viewer to rotate the arrow.
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Step 4: Save & Publish ─────────── */}
          <div className="section">
            <div className="section-header">
              <div className="section-step">4</div>
              <div className="section-title">Save & Publish</div>
            </div>

            <div className="action-group">
              <div className="action-card" onClick={saveProject}>
                <div className="action-icon save">💾</div>
                <div className="action-text">
                  <div className="action-label">Save Project</div>
                  <div className="action-desc">Download .json to continue editing later</div>
                </div>
              </div>

              <div className="action-card" onClick={() => loadProjectInputRef.current?.click()}>
                <div className="action-icon load">📂</div>
                <div className="action-text">
                  <div className="action-label">Open Project</div>
                  <div className="action-desc">Load a previously saved .json file</div>
                </div>
              </div>

              <div
                className="action-card"
                onClick={onPublishClick}
                style={scenes.length === 0 ? { opacity: 0.35, cursor: 'not-allowed', pointerEvents: 'none' } : {}}
              >
                <div className="action-icon publish">🚀</div>
                <div className="action-text">
                  <div className="action-label">Publish Tour</div>
                  <div className="action-desc">Export standalone viewer to share</div>
                </div>
              </div>
            </div>
          </div>

        </div>
      </aside>

      {/* ── Viewer ─────────────────────────────── */}
      <div className="viewer-container">
        {selectedScene && selectedPanoramaUrl ? (
          <MarzipanoViewer
            scene={selectedScene}
            panoramaUrl={selectedPanoramaUrl}
            hotspots={selectedScene.hotspots}
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
        ) : (
          <div className="viewer-empty">
            <div className="viewer-empty-icon">🌍</div>
            <div className="viewer-empty-text">No panorama selected</div>
            <div className="viewer-empty-hint">Import a 360° image to get started</div>
          </div>
        )}

        {/* Overlay badges */}
        {selectedScene && selectedPanoramaUrl && (
          <div className="viewer-overlay">
            <div className="viewer-badge">
              {hotspotMode === 'navigate' && <>Drag to look around</>}
              {hotspotMode === 'info' && <>Click to place <strong>info hotspot</strong></>}
              {hotspotMode === 'link' && <>Click to place <strong>link arrow</strong></>}
            </div>
            <div className="viewer-badge">
              <strong>{selectedScene.name}</strong> · {selectedScene.hotspots.length} hotspots
            </div>
          </div>
        )}

        {toast && <div className="toast">{toast}</div>}
      </div>
    </div>
  );
}