import { useEffect, useMemo, useRef } from 'react';
import Marzipano from 'marzipano';
import type { OrbitryHotspot, OrbitryScene, OrbitryViewParameters } from '../lib/project';

type Props = {
  scene?: OrbitryScene;
  /** Object URL for the current scene panorama (equirect). */
  panoramaUrl?: string;
  /** Hotspots to render for the current scene. */
  hotspots?: OrbitryHotspot[];
  /** How the viewer should interpret clicks: move vs edit. */
  interactionMode?: 'navigate' | 'info' | 'link';
  /** Currently selected hotspot (for highlighting / editing). */
  selectedHotspotId?: string | null;
  /** Select a hotspot from the viewer. */
  onSelectHotspot?: (hotspotId: string, ev: MouseEvent | PointerEvent) => void;
  /** Update link hotspot arrow rotation (radians). */
  onUpdateLinkRotation?: (hotspotId: string, rotation: number, ev: PointerEvent) => void;
  onClickInViewer?: (coords: { yaw: number; pitch: number }, ev: MouseEvent | PointerEvent) => void;
  onLinkHotspotClick?: (targetSceneId: string, ev: MouseEvent | PointerEvent) => void;
};

export default function MarzipanoViewer({
  scene,
  panoramaUrl,
  hotspots = [],
  interactionMode = 'navigate',
  selectedHotspotId,
  onSelectHotspot,
  onUpdateLinkRotation,
  onClickInViewer,
  onLinkHotspotClick
}: Props) {
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
      const isSelected = !!selectedHotspotId && h.id === selectedHotspotId;
      el.className = `hotspotDot ${isLink ? 'hotspotLink' : 'hotspotInfo'} ${isSelected ? 'selected' : ''}`;
      el.title = isLink ? `Link → ${h.targetSceneId}` : (h.title || 'Info hotspot');

      // Click behavior depends on mode.
      const selectThis = (ev: any) => {
        ev.stopPropagation();
        onSelectHotspot?.(h.id, ev);
      };

      if (isLink) {
        // Visual arrow (rotatable).
        const arrow = document.createElement('div');
        arrow.className = 'hsArrow';
        // Default arrow points to the right (0 rad).
        arrow.innerHTML = `
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path fill="rgba(243,196,106,0.95)" d="M4 12a1 1 0 0 1 1-1h9.2l-2.4-2.4a1 1 0 1 1 1.4-1.4l4.6 4.6a1 1 0 0 1 0 1.4l-4.6 4.6a1 1 0 1 1-1.4-1.4l2.4-2.4H5a1 1 0 0 1-1-1z"/>
          </svg>
        `.trim();
        (arrow.firstElementChild as SVGElement | null)?.setAttribute('focusable', 'false');
        const rot = (h as any).rotation ?? 0;
        arrow.style.transform = `rotate(${rot}rad)`;
        el.appendChild(arrow);

        if (interactionMode === 'navigate') {
          // In Move mode: clicking navigates.
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            onLinkHotspotClick?.(h.targetSceneId, ev);
          });
        } else {
          // In edit modes: clicking selects.
          el.addEventListener('click', selectThis);
        }

        // Rotate handle only when selected and in Link mode.
        if (isSelected && interactionMode === 'link') {
          const handle = document.createElement('div');
          handle.className = 'hsRotateHandle';
          handle.textContent = '↻';
          el.appendChild(handle);

          const onPointerDown = (ev: PointerEvent) => {
            ev.stopPropagation();
            ev.preventDefault();
            const pointerId = ev.pointerId;
            (handle as any).setPointerCapture?.(pointerId);

            const move = (mv: PointerEvent) => {
              if (mv.pointerId !== pointerId) return;
              const r = el.getBoundingClientRect();
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              const angle = Math.atan2(mv.clientY - cy, mv.clientX - cx);
              arrow.style.transform = `rotate(${angle}rad)`;
              onUpdateLinkRotation?.(h.id, angle, mv);
            };

            const up = (upEv: PointerEvent) => {
              if (upEv.pointerId !== pointerId) return;
              window.removeEventListener('pointermove', move, true);
              window.removeEventListener('pointerup', up, true);
              window.removeEventListener('pointercancel', up, true);
            };

            window.addEventListener('pointermove', move, true);
            window.addEventListener('pointerup', up, true);
            window.addEventListener('pointercancel', up, true);
          };

          handle.addEventListener('pointerdown', onPointerDown);
        }

        // Prevent pointer-based click-to-add from firing when clicking a hotspot.
        el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        el.addEventListener('pointerup', (ev) => ev.stopPropagation());
      } else {
        // Info hotspot: in edit modes, clicking selects.
        if (interactionMode !== 'navigate') {
          el.addEventListener('click', selectThis);
        } else {
          // In Move mode, clicking info hotspots does nothing (for now) but should not add a new hotspot.
          el.addEventListener('click', (ev) => ev.stopPropagation());
        }

        el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
        el.addEventListener('pointerup', (ev) => ev.stopPropagation());
      }

      container.createHotspot(el, { yaw: h.yaw, pitch: h.pitch });
      hotspotElsRef.current.set(h.id, el);
    });
  }, [hotspots, scene?.id, selectedHotspotId, interactionMode]);

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
