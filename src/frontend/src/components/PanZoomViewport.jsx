import { useState, useRef, useEffect, useCallback } from 'react';
import { ZoomInRegular, ZoomOutRegular, ArrowResetRegular } from '@fluentui/react-icons';

/**
 * PanZoomViewport — a reusable pan/zoom canvas for node diagrams.
 *
 * Renders `children` inside a transformed pan layer (drag to pan, scroll to zoom)
 * and `overlay` as a fixed sibling that is NOT transformed (e.g. a detail card).
 * Shared by the Milestone Map and the My Org map so both behave identically.
 *
 * Props:
 *   children     — diagram content placed inside the transformed `.eng-pan` layer.
 *   overlay      — optional node rendered un-transformed inside the viewport.
 *   dragStateRef — optional ref; the viewport writes { moved } into it so callers
 *                  can suppress a click that was actually the end of a pan-drag.
 *   contentKey   — any value that changes when the content's size changes; the
 *                  viewport re-clamps the pan offset whenever it changes.
 *   minScale/maxScale — zoom bounds (defaults 0.3 / 2.5).
 *   hint         — footer hint text.
 */
export default function PanZoomViewport({
  children,
  overlay = null,
  dragStateRef,
  contentKey,
  minScale = 0.3,
  maxScale = 2.5,
  hint = 'Drag to pan · scroll to zoom · click a card for details',
}) {
  const viewportRef = useRef(null);
  const panRef = useRef(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  useEffect(() => { scaleRef.current = scale; }, [scale]);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const internalDragRef = useRef(null);
  const dragRef = dragStateRef || internalDragRef; // { startX, startY, originX, originY, moved }

  // Constrain the pan offset so the diagram can't be dragged off into infinity —
  // always keep at least `margin` px of content within the viewport on each axis.
  const clampOffset = useCallback((off, s) => {
    const vp = viewportRef.current;
    const pan = panRef.current;
    if (!vp || !pan) return off;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const cw = pan.offsetWidth * s;
    const ch = pan.offsetHeight * s;
    const axis = (v, content, viewport) => {
      const margin = Math.min(120, content, viewport); // keep this much visible
      const min = margin - content;     // content's far edge stays in view
      const max = viewport - margin;    // content's near edge stays in view
      return Math.min(max, Math.max(min, v));
    };
    return { x: axis(off.x, cw, vw), y: axis(off.y, ch, vh) };
  }, []);

  const clampScale = (s) => Math.min(maxScale, Math.max(minScale, s));

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Zoom around the viewport center (used by the +/- buttons).
  const zoomBy = useCallback((factor) => {
    const vp = viewportRef.current;
    const rect = vp ? vp.getBoundingClientRect() : { width: 0, height: 0 };
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setScale((prev) => {
      const next = clampScale(prev * factor);
      setOffset((o) => clampOffset({
        x: cx - ((cx - o.x) / prev) * next,
        y: cy - ((cy - o.y) / prev) * next,
      }, next));
      return next;
    });
  }, [clampOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel zoom toward the cursor. Attached natively so we can preventDefault
  // (React's onWheel is passive and cannot block page scroll).
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setScale((prev) => {
        const next = clampScale(prev * factor);
        if (next === prev) return prev;
        setOffset((o) => clampOffset({
          x: cx - ((cx - o.x) / prev) * next,
          y: cy - ((cy - o.y) / prev) * next,
        }, next));
        return next;
      });
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [clampOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pan with mouse drag.
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) d.moved = true;
      setOffset(clampOffset({ x: d.originX + dx, y: d.originY + dy }, scaleRef.current));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, clampOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-clamp when the content size changes (e.g. filters/expansion add nodes) so
  // the view never ends up stranded in empty space.
  useEffect(() => {
    setOffset((o) => clampOffset(o, scaleRef.current));
  }, [contentKey, scale, clampOffset]);

  function onMouseDown(e) {
    // Ignore clicks on interactive controls (links, buttons, zoom controls).
    if (e.button !== 0 || e.target.closest('button')) return;
    dragRef.current = {
      startX: e.clientX, startY: e.clientY, originX: offset.x, originY: offset.y, moved: false,
    };
    setDragging(true);
    e.preventDefault();
  }

  return (
    <div
      ref={viewportRef}
      className={`eng-diagram-viewport${dragging ? ' dragging' : ''}`}
      onMouseDown={onMouseDown}
    >
      <div className="eng-zoom-controls">
        <button className="eng-zoom-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
          <ZoomOutRegular style={{ fontSize: 16 }} />
        </button>
        <span className="eng-zoom-level">{Math.round(scale * 100)}%</span>
        <button className="eng-zoom-btn" title="Zoom in" onClick={() => zoomBy(1.2)}>
          <ZoomInRegular style={{ fontSize: 16 }} />
        </button>
        <button className="eng-zoom-btn" title="Reset view" onClick={reset}>
          <ArrowResetRegular style={{ fontSize: 16 }} />
        </button>
      </div>
      <div
        ref={panRef}
        className="eng-pan"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
      >
        {children}
      </div>
      {hint ? <div className="eng-diagram-hint">{hint}</div> : null}
      {overlay}
    </div>
  );
}
