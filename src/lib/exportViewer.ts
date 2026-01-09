import marzipanoUmd from 'marzipano/dist/marzipano.js?raw';

import type { OrbitryProject } from './project';
import type { StoredAsset } from './assets';

type ExportAsset = {
  sceneId: string;
  blob: Blob;
  fileName: string;
};

function safeFileName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'file';
}

async function writeFile(dir: any, name: string, data: Blob | string) {
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function buildViewerFiles(project: OrbitryProject) {
  const css = `
html, body { margin: 0; padding: 0; height: 100%; background: #0b0f17; color: #e6eefc; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
.topbar { position: fixed; top: 0; left: 0; right: 0; height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 12px; background: rgba(10,14,22,0.88); backdrop-filter: blur(10px); border-bottom: 1px solid rgba(255,255,255,0.08); z-index: 10; }
.brand { font-weight: 700; letter-spacing: 0.2px; }
.spacer { flex: 1; }
.btn { background: rgba(255,255,255,0.06); color: #e6eefc; border: 1px solid rgba(255,255,255,0.10); border-radius: 10px; padding: 6px 10px; cursor: pointer; }
.btn:hover { background: rgba(255,255,255,0.10); }
.select { background: rgba(255,255,255,0.06); color: #e6eefc; border: 1px solid rgba(255,255,255,0.10); border-radius: 10px; padding: 6px 10px; }
#pano { position: absolute; top: 48px; left: 0; right: 0; bottom: 0; }
.hotspotDot { width: 18px; height: 18px; border-radius: 999px; border: 2px solid rgba(243,196,106,0.95); background: rgba(16,20,28,0.85); box-shadow: 0 8px 18px rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; }
.hotspotDot:hover { transform: scale(1.06); }
.hsArrow { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; }
.infoPanel { position: fixed; left: 12px; bottom: 12px; width: min(420px, calc(100% - 24px)); background: rgba(10,14,22,0.92); border: 1px solid rgba(255,255,255,0.10); border-radius: 14px; padding: 12px 12px 10px; box-shadow: 0 16px 40px rgba(0,0,0,0.45); z-index: 12; display: none; }
.infoPanel.show { display: block; }
.infoTitle { font-weight: 700; margin-bottom: 6px; }
.infoText { opacity: 0.92; line-height: 1.35; }
.infoClose { position: absolute; top: 8px; right: 10px; cursor: pointer; opacity: 0.7; }
.infoClose:hover { opacity: 1; }
`.trim();

  const indexHtml = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(project.title || 'Orbitry Viewer')}</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <div class="topbar">
      <div class="brand">Orbitry Viewer</div>
      <select id="sceneSelect" class="select"></select>
      <div class="spacer"></div>
      <button class="btn" id="btnFullscreen">Fullscreen</button>
    </div>
    <div id="pano"></div>

    <div id="infoPanel" class="infoPanel">
      <div class="infoClose" id="infoClose">✕</div>
      <div class="infoTitle" id="infoTitle"></div>
      <div class="infoText" id="infoText"></div>
    </div>

    <script src="marzipano.js"></script>
    <script src="project.js"></script>
    <script src="viewer.js"></script>
  </body>
</html>`;

  const projectJs = `window.ORBITRY_PROJECT = ${JSON.stringify(project, null, 2)};`;

  const viewerJs = `/* Orbitry exported viewer (MVP) */
(function(){
  var project = window.ORBITRY_PROJECT;
  if (!project || !project.scenes || !project.scenes.length) {
    document.body.innerHTML = '<div style="padding:24px;color:#fff">No scenes in project</div>';
    return;
  }

  var container = document.getElementById('pano');
  var viewer = new window.Marzipano.Viewer(container, { stageType: 'webgl' });
  var sceneMap = {};
  project.scenes.forEach(function(s){ sceneMap[s.id] = s; });

  var sceneSelect = document.getElementById('sceneSelect');
  project.scenes.forEach(function(s){
    var opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name || s.id;
    sceneSelect.appendChild(opt);
  });

  var infoPanel = document.getElementById('infoPanel');
  var infoTitle = document.getElementById('infoTitle');
  var infoText  = document.getElementById('infoText');
  document.getElementById('infoClose').addEventListener('click', function(){
    infoPanel.classList.remove('show');
  });

  function showInfo(h){
    infoTitle.textContent = h.title || 'Info';
    infoText.textContent = h.text || '';
    infoPanel.classList.add('show');
  }

  function makeHotspotEl(h){
    var el = document.createElement('div');
    var isLink = h.type === 'link';
    el.className = 'hotspotDot ' + (isLink ? 'hotspotLink' : 'hotspotInfo');
    if (isLink) {
      var arrow = document.createElement('div');
      arrow.className = 'hsArrow';
      arrow.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="rgba(243,196,106,0.95)" d="M4 12a1 1 0 0 1 1-1h9.2l-2.4-2.4a1 1 0 1 1 1.4-1.4l4.6 4.6a1 1 0 0 1 0 1.4l-4.6 4.6a1 1 0 1 1-1.4-1.4l2.4-2.4H5a1 1 0 0 1-1-1z"/></svg>';
      var rot = (typeof h.rotation === 'number') ? h.rotation : 0;
      arrow.style.transform = 'rotate(' + rot + 'rad)';
      el.appendChild(arrow);
      el.title = 'Go to: ' + (sceneMap[h.targetSceneId] ? (sceneMap[h.targetSceneId].name || h.targetSceneId) : h.targetSceneId);
      el.addEventListener('click', function(ev){
        ev.stopPropagation();
        if (h.targetSceneId) loadScene(h.targetSceneId);
      });
    } else {
      el.title = h.title || 'Info';
      el.addEventListener('click', function(ev){
        ev.stopPropagation();
        showInfo(h);
      });
    }
    return el;
  }

  var current = { id: null, mscene: null, hotspots: [] };

  function clearHotspots(){
    current.hotspots.forEach(function(el){ try { el.remove(); } catch(e){} });
    current.hotspots = [];
  }

  function loadScene(sceneId){
    var s = sceneMap[sceneId];
    if (!s) return;
    infoPanel.classList.remove('show');
    clearHotspots();

    var imgUrl = 'assets/' + s.id + '.jpg';
    var source = window.Marzipano.ImageUrlSource.fromString(imgUrl);
    var geometry = new window.Marzipano.EquirectGeometry([{ width: 8000 }]);
    var limiter = window.Marzipano.RectilinearView.limit.traditional(1024, (120 * Math.PI) / 180);
    var view = new window.Marzipano.RectilinearView(s.initialView || { yaw: 0, pitch: 0, fov: 1.2 }, limiter);
    var mscene = viewer.createScene({ source: source, geometry: geometry, view: view });
    current.id = s.id;
    current.mscene = mscene;
    mscene.switchTo({ transitionDuration: 260 });

    sceneSelect.value = s.id;

    var hsContainer = mscene.hotspotContainer();
    (s.hotspots || []).forEach(function(h){
      var el = makeHotspotEl(h);
      hsContainer.createHotspot(el, { yaw: h.yaw, pitch: h.pitch });
      current.hotspots.push(el);
    });
  }

  sceneSelect.addEventListener('change', function(){
    loadScene(sceneSelect.value);
  });

  document.getElementById('btnFullscreen').addEventListener('click', function(){
    var el = document.documentElement;
    if (!document.fullscreenElement) {
      (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen).call(el);
    } else {
      (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document);
    }
  });

  loadScene(project.scenes[0].id);
})();`;

  const readme = `Orbitry export (viewer)

Files:
- index.html            Viewer for hosting (Netlify / any static hosting).
- viewer_standalone.html Offline viewer (double-click works, everything embedded).

Local preview options:
1) Recommended: open viewer_standalone.html (no server needed).
2) Or run a tiny local server in this folder, then open http://localhost:8000 :
   - Windows (PowerShell):  python -m http.server 8000
   - Node:                 npx serve -l 8000
`;

  return { css, indexHtml, projectJs, viewerJs, marzipanoUmd, readme };
}

function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function collectAssetsForExport(project: OrbitryProject, assets: Record<string, StoredAsset | undefined>) {
  const out: ExportAsset[] = [];

  for (const scene of project.scenes) {
    const stored = assets[scene.id];
    const blob = stored?.blob;
    if (!blob) continue;
    // Export as .jpg; our import pipeline already normalizes to JPEG.
    const fileName = safeFileName(`${scene.id}.jpg`);
    out.push({ sceneId: scene.id, blob, fileName });
  }

  return out;
}

function buildStandaloneHtml(args: {
  project: OrbitryProject;
  embeddedAssets: Record<string, string>;
  css: string;
  marzipanoUmd: string;
}) {
  const { project, embeddedAssets, css, marzipanoUmd } = args;

  // Single-file viewer that can be opened directly from file:// (no CORS issues)
  // because all panoramas are embedded as data: URLs.
  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(project.title || 'Orbitry Viewer')}</title>
    <style>${css}</style>
  </head>
  <body>
    <div class="topbar">
      <div class="brand">Orbitry Viewer</div>
      <select id="sceneSelect" class="select"></select>
      <div class="spacer"></div>
      <button class="btn" id="btnFullscreen">Fullscreen</button>
    </div>
    <div id="pano"></div>
    <div id="infoPanel" class="infoPanel">
      <div class="infoClose" id="infoClose">✕</div>
      <div class="infoTitle" id="infoTitle"></div>
      <div class="infoText" id="infoText"></div>
    </div>

    <script>${marzipanoUmd}</script>
    <script>window.ORBITRY_PROJECT = ${JSON.stringify(project)}; window.ORBITRY_ASSETS = ${JSON.stringify(embeddedAssets)};</script>
    <script>
      // Viewer logic (uses embedded assets)
      (function(){
        var project = window.ORBITRY_PROJECT;
        var assets = window.ORBITRY_ASSETS || {};
        if (!project || !project.scenes || !project.scenes.length) {
          document.body.innerHTML = '<div style="padding:24px;color:#fff">No scenes in project</div>';
          return;
        }
        var container = document.getElementById('pano');
        var viewer = new window.Marzipano.Viewer(container, { stageType: 'webgl' });
        var sceneMap = {}; project.scenes.forEach(function(s){ sceneMap[s.id] = s; });

        var sceneSelect = document.getElementById('sceneSelect');
        project.scenes.forEach(function(s){
          var opt = document.createElement('option');
          opt.value = s.id;
          opt.textContent = s.name || s.id;
          sceneSelect.appendChild(opt);
        });

        var infoPanel = document.getElementById('infoPanel');
        var infoTitle = document.getElementById('infoTitle');
        var infoText  = document.getElementById('infoText');
        document.getElementById('infoClose').addEventListener('click', function(){ infoPanel.classList.remove('show'); });

        function showInfo(h){ infoTitle.textContent = h.title || 'Info'; infoText.textContent = h.text || ''; infoPanel.classList.add('show'); }
        function makeHotspotEl(h){
          var el = document.createElement('div');
          var isLink = h.type === 'link';
          el.className = 'hotspotDot ' + (isLink ? 'hotspotLink' : 'hotspotInfo');
          if (isLink) {
            var arrow = document.createElement('div'); arrow.className = 'hsArrow';
            arrow.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="rgba(243,196,106,0.95)" d="M4 12a1 1 0 0 1 1-1h9.2l-2.4-2.4a1 1 0 1 1 1.4-1.4l4.6 4.6a1 1 0 0 1 0 1.4l-4.6 4.6a1 1 0 1 1-1.4-1.4l2.4-2.4H5a1 1 0 0 1-1-1z"/></svg>';
            var rot = (typeof h.rotation === 'number') ? h.rotation : 0; arrow.style.transform = 'rotate(' + rot + 'rad)';
            el.appendChild(arrow);
            el.addEventListener('click', function(ev){ ev.stopPropagation(); if (h.targetSceneId) loadScene(h.targetSceneId); });
          } else {
            el.addEventListener('click', function(ev){ ev.stopPropagation(); showInfo(h); });
          }
          return el;
        }

        var current = { hotspots: [] };
        function clearHotspots(){ current.hotspots.forEach(function(el){ try { el.remove(); } catch(e){} }); current.hotspots = []; }

        function loadScene(sceneId){
          var s = sceneMap[sceneId]; if (!s) return;
          infoPanel.classList.remove('show'); clearHotspots();
          var imgUrl = assets[s.id];
          var source = window.Marzipano.ImageUrlSource.fromString(imgUrl);
          var geometry = new window.Marzipano.EquirectGeometry([{ width: 8000 }]);
          var limiter = window.Marzipano.RectilinearView.limit.traditional(1024, (120 * Math.PI) / 180);
          var view = new window.Marzipano.RectilinearView(s.initialView || { yaw: 0, pitch: 0, fov: 1.2 }, limiter);
          var mscene = viewer.createScene({ source: source, geometry: geometry, view: view });
          mscene.switchTo({ transitionDuration: 260 });
          sceneSelect.value = s.id;
          var hsContainer = mscene.hotspotContainer();
          (s.hotspots || []).forEach(function(h){
            var el = makeHotspotEl(h);
            hsContainer.createHotspot(el, { yaw: h.yaw, pitch: h.pitch });
            current.hotspots.push(el);
          });
        }

        sceneSelect.addEventListener('change', function(){ loadScene(sceneSelect.value); });
        document.getElementById('btnFullscreen').addEventListener('click', function(){
          var el = document.documentElement;
          if (!document.fullscreenElement) (el.requestFullscreen||el.webkitRequestFullscreen||el.msRequestFullscreen).call(el);
          else (document.exitFullscreen||document.webkitExitFullscreen||document.msExitFullscreen).call(document);
        });
        loadScene(project.scenes[0].id);
      })();
    </script>
  </body>
</html>`;
}

/**
 * Export a standalone *viewer* (no editor UI) into a folder.
 *
 * Primary path uses the File System Access API (Chrome/Edge): user picks a folder,
 * we create an export subfolder and write all files there.
 *
 * Fallback path (no FS API): downloads a single HTML with embedded images.
 */
export async function exportViewer(project: OrbitryProject, assets: Record<string, StoredAsset | undefined>) {
  const showDirectoryPicker = (window as any).showDirectoryPicker as undefined | ((opts?: any) => Promise<any>);
  const files = buildViewerFiles(project);
  const exportAssets = await collectAssetsForExport(project, assets);

  // FS Access API path.
  if (showDirectoryPicker) {
    const root = await showDirectoryPicker({ mode: 'readwrite' });
    const folderName = safeFileName(`orbitry_export_${new Date().toISOString().replace(/[:.]/g, '-')}`);
    const outDir = await root.getDirectoryHandle(folderName, { create: true });

    await writeFile(outDir, 'index.html', files.indexHtml);
    await writeFile(outDir, 'style.css', files.css);
    await writeFile(outDir, 'marzipano.js', files.marzipanoUmd);
    await writeFile(outDir, 'project.js', files.projectJs);
    await writeFile(outDir, 'viewer.js', files.viewerJs);
    await writeFile(outDir, 'README.txt', files.readme);

    const assetsDir = await outDir.getDirectoryHandle('assets', { create: true });
    for (const a of exportAssets) {
      await writeFile(assetsDir, a.fileName, a.blob);
    }

    // Also write a single-file offline viewer for easy double-click viewing.
    // (Folder mode is great for hosting, but file:// often blocks image fetches.)
    const embeddedAssets: Record<string, string> = {};
    for (const a of exportAssets) {
      embeddedAssets[a.sceneId] = await blobToDataUrl(a.blob);
    }
    const standalone = buildStandaloneHtml({
      project,
      embeddedAssets,
      css: files.css,
      marzipanoUmd: files.marzipanoUmd,
    });
    await writeFile(outDir, 'viewer_standalone.html', standalone);

    return { ok: true as const, mode: 'folder' as const, folderName };
  }

  // Fallback: export a single HTML with embedded assets.
  const embeddedAssets: Record<string, string> = {};
  for (const a of exportAssets) {
    embeddedAssets[a.sceneId] = await blobToDataUrl(a.blob);
  }

  const single = buildStandaloneHtml({
    project,
    embeddedAssets,
    css: files.css,
    marzipanoUmd: files.marzipanoUmd,
  });

  const blob = new Blob([single], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(`${project.title || 'orbitry'}_viewer.html`);
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  return { ok: true as const, mode: 'single-html' as const };
}
