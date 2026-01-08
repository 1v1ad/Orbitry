import { useEffect, useMemo, useRef } from 'react';
import Marzipano from 'marzipano';
import type { OrbitryHotspot, OrbitryScene, OrbitryViewParameters } from '../lib/project';

type Props = {
  scene?: OrbitryScene;
  /** Object URL for the current scene panorama (equirect). */
  panoramaUrl?: string;
  /** Hotspots to render for the current scene. */
  hotspots?: OrbitryHotspot[];
  onClickInViewer?: (coords: { yaw: number; pitch: number }, ev: MouseEvent | PointerEvent) => void;
  onLinkHotspotClick?: (targetSceneId: string, ev: MouseEvent | PointerEvent) => void;
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

        // Prevent pointer-based click-to-add from firing when clicking a hotspot.
        el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        el.addEventListener('pointerup', (ev) => ev.stopPropagation());
      } else {
        // Info hotspot: stopPropagation so it doesn't create a new one.
        el.addEventListener('click', (ev) => ev.stopPropagation());

        el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        el.addEventListener('pointerup', (ev) => ev.stopPropagation());
      }

      container.createHotspot(el, { yaw: h.yaw, pitch: h.pitch });
      hotspotElsRef.current.set(h.id, el);
    });
  }, [hotspots, scene?.id]);

  // Click-to-add (but not on drag).
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    const MOVE_PX = 6; // threshold to treat as drag, not click
    let down:
      | {
          pointerId: number;
          x: number;
          y: number;
          moved: boolean;
        }
      | null = null;

    const onDown = (ev: PointerEvent) => {
      if (!onClickInViewer) return;
      if (ev.button !== 0) return; // only left click / primary
      down = { pointerId: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false };
    };

    const onMove = (ev: PointerEvent) => {
      if (!down) return;
      if (ev.pointerId !== down.pointerId) return;
      const dx = ev.clientX - down.x;
      const dy = ev.clientY - down.y;
      if ((dx * dx + dy * dy) >= MOVE_PX * MOVE_PX) down.moved = true;
    };

    const onUpOrCancel = (ev: PointerEvent) => {
      if (!down) return;
      if (ev.pointerId !== down.pointerId) return;

      const wasClick = !down.moved;
      down = null;

      if (!wasClick) return;
      if (!onClickInViewer) return;

      // If the user clicked on a hotspot element, do nothing (navigation / stopPropagation already handled).
      const t = ev.target as HTMLElement | null;
      if (t?.closest?.('.hotspotDot')) return;

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

    root.addEventListener('pointerdown', onDown);
    root.addEventListener('pointermove', onMove);
    root.addEventListener('pointerup', onUpOrCancel);
    root.addEventListener('pointercancel', onUpOrCancel);

    return () => {
      root.removeEventListener('pointerdown', onDown);
      root.removeEventListener('pointermove', onMove);
      root.removeEventListener('pointerup', onUpOrCancel);
      root.removeEventListener('pointercancel', onUpOrCancel);
    };
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
                Drag to look around. Switch to <strong>Info</strong> or <strong>Link</strong> in the sidebar to place hotspots.
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
