import { useEffect, useMemo, useRef } from 'react';
import Marzipano from 'marzipano';
import type { OrbitryHotspot, OrbitryScene, OrbitryViewParameters } from '../lib/project';

type Props = {
  scene?: OrbitryScene;
  /** Object URL for the current scene panorama (equirect). */
  panoramaUrl?: string;
  /** Hotspots to render for the current scene. */
  hotspots?: OrbitryHotspot[];
  onClickInViewer?: (coords: { yaw: number; pitch: number }, ev: MouseEvent) => void;
  onLinkHotspotClick?: (targetSceneId: string, ev: MouseEvent) => void;
};

export default function MarzipanoViewer({ scene, panoramaUrl, hotspots = [], onClickInViewer, onLinkHotspotClick }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<any | null>(null);
  const currentSceneRef = useRef<any | null>(null);
  const hotspotElsRef = useRef<Map<string, HTMLElement>>(new Map());

  const isReady = useMemo(() => !!scene && !!panoramaUrl, [scene, panoramaUrl]);

  // Init viewer once.
  useEffect(() => {
    if (!containerRef.current) return;
    const viewer = new Marzipano.Viewer(containerRef.current, { stageType: 'webgl' });
    viewerRef.current = viewer;

    return () => {
      try {
        viewer.destroy();
      } catch {
        // ignore
      }
      viewerRef.current = null;
      currentSceneRef.current = null;
      hotspotElsRef.current.clear();
    };
  }, []);

  // Switch scene when scene/panoramaUrl changes.
  useEffect(() => {
    if (!viewerRef.current || !scene || !panoramaUrl) return;

    // Create equirect scene.
    const source = Marzipano.ImageUrlSource.fromString(panoramaUrl);
    // Single-level equirect geometry. We keep it high enough for crispness,
    // while the import step already downscales to a safe size for WebGL.
    const geometry = new Marzipano.EquirectGeometry([{ width: 8000 }]);

    const limiter = Marzipano.RectilinearView.limit.traditional(1024, (120 * Math.PI) / 180);
    const view = new Marzipano.RectilinearView(scene.initialView, limiter);

    const mScene = viewerRef.current.createScene({ source, geometry, view });

    // Keep for click math.
    currentSceneRef.current = mScene;

    // Switch (with a small fade).
    mScene.switchTo({ transitionDuration: 280 });

    // Clear hotspots from previous scene.
    hotspotElsRef.current.forEach((el) => {
      try {
        el.remove();
      } catch {
        // ignore
      }
    });
    hotspotElsRef.current.clear();

    return () => {
      // nothing
    };
  }, [scene?.id, panoramaUrl]);

  // Render hotspots (rebuild each time for MVP simplicity).
  useEffect(() => {
    const mScene = currentSceneRef.current;
    if (!mScene) return;

    // Remove old.
    hotspotElsRef.current.forEach((el) => el.remove());
    hotspotElsRef.current.clear();

    const container = mScene.hotspotContainer();
    hotspots.forEach((h) => {
      const el = document.createElement('div');
      const isLink = h.type === 'link';
      el.className = `hotspotDot ${isLink ? 'hotspotLink' : 'hotspotInfo'}`;
      el.title = isLink ? `Link → ${h.targetSceneId}` : (h.title || 'Info hotspot');

      if (isLink) {
        // Clicking a link hotspot should navigate, not add a new hotspot.
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onLinkHotspotClick?.(h.targetSceneId, ev);
        });
      } else {
        // Info hotspot: stopPropagation so it doesn't create a new one.
        el.addEventListener('click', (ev) => ev.stopPropagation());
      }

      container.createHotspot(el, { yaw: h.yaw, pitch: h.pitch });
      hotspotElsRef.current.set(h.id, el);
    });
  }, [hotspots, scene?.id]);

  // Click-to-add.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const handler = (ev: MouseEvent) => {
      if (!onClickInViewer) return;
      const mScene = currentSceneRef.current;
      if (!mScene) return;
      const view = mScene.view();
      const rect = root.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;

      const coords: OrbitryViewParameters = view.screenToCoordinates({ x, y });
      if (!coords || typeof coords.yaw !== 'number' || typeof coords.pitch !== 'number') return;
      onClickInViewer({ yaw: coords.yaw, pitch: coords.pitch }, ev);
    };

    root.addEventListener('click', handler);
    return () => root.removeEventListener('click', handler);
  }, [onClickInViewer]);

  return (
    <div className="viewerWrap">
      <div ref={containerRef} className="viewer" />
      <div className="viewerOverlay">
        <div className="hint">
          <strong>Orbitry Editor MVP</strong>
          <div style={{ marginTop: 6 }}>
            {isReady ? (
              <>
                Click in the panorama to add a hotspot (Info or Link — choose in sidebar).
              </>
            ) : (
              <>Import a 360 equirectangular image (2:1) to start.</>
            )}
          </div>
        </div>
        <div className="hint" style={{ textAlign: 'right' }}>
          <div><strong>Scene</strong>: {scene ? scene.name : '—'}</div>
          <div style={{ marginTop: 4 }}>Hotspots: {hotspots.length}</div>
        </div>
      </div>
    </div>
  );
}
