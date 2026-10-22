import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '@fluentui/react-components';
import { DismissRegular, ArrowRightRegular, ArrowLeftRegular, CheckmarkCircleFilled } from '@fluentui/react-icons';
import { TOUR_STEPS } from '../lib/tourSteps';

// Padding around the spotlighted element (px) and how long to wait for a step's target to
// appear before falling back to a centered card.
const SPOT_PAD = 8;
const TARGET_TIMEOUT_MS = 2500;
const CARD_GAP = 14;
const VP_MARGIN = 12; // keep the card at least this far from every viewport edge

// GuidedTour — a spotlight product tour. Navigates to each step's page, waits for its target
// element, deep-darkens the screen except a cutout around the target, and shows a direction
// card. Advance with the arrow (or by clicking the highlighted control when the step allows).
// Rendered by App and toggled by the sidebar "Guided Tour" button. onClose unmounts it.
export default function GuidedTour({ steps = TOUR_STEPS, onClose }) {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState(null);   // spotlight target rect (viewport coords) or null
  const [subRects, setSubRects] = useState([]); // secondary highlight boxes inside the target
  const [ready, setReady] = useState(false); // target resolved (found or timed out)
  const [locating, setLocating] = useState(false); // shown only when a target is genuinely slow
  const [revealed, setRevealed] = useState(false); // one-way: fade the spotlight in on first resolve
  // Real load tracking for `loading` steps: 'loading' while the page's loadingSelector is present,
  // 'loaded' once its readySelector appears, or null when unknown/not applicable.
  const [loadState, setLoadState] = useState(null);
  const targetElRef = useRef(null);
  const cardRef = useRef(null);
  const subMeasureRef = useRef(null); // latest step's sub-box measurer, for scroll/resize reflow
  const [cardPos, setCardPos] = useState(null); // measured, viewport-clamped {top,left}
  const step = steps[index];
  const last = index === steps.length - 1;

  const goNext = useCallback(() => {
    setIndex((i) => (i < steps.length - 1 ? i + 1 : i));
  }, [steps.length]);
  const goBack = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Resolve the current step: navigate to its page, then poll for the target element. When
  // found, scroll it into view and measure it; if it never appears, show a centered card.
  useEffect(() => {
    let cancelled = false;
    let settleTimer = 0;
    setReady(false);
    setLocating(false);
    setSubRects([]); // secondary boxes are step-specific — never carry the prior step's over
    // NOTE: deliberately do NOT clear `rect` here. Keeping the previous step's spotlight on
    // screen while the next target is being located lets the ring + card GLIDE to the new
    // position (CSS transitions) instead of flashing a centered card through the middle of the
    // screen between every step. `rect` is only set to null on a genuine not-found timeout below.
    targetElRef.current = null;
    // Measure the step's secondary highlight boxes (the bulleted sub-areas). Each sub-target rect
    // is CLIPPED to the panel's visible box so a box never floats over a section that's scrolled
    // out of the modal's internal overflow — an off-panel sub-target simply yields no box.
    const measureSubs = (panelRect) => {
      if (!step.subTargets || !step.subTargets.length || !panelRect) { setSubRects([]); return; }
      const px = panelRect.left;
      const py = panelRect.top;
      const pr = panelRect.left + panelRect.width;
      const pb = panelRect.top + panelRect.height;
      const out = [];
      step.subTargets.forEach((sel, i) => {
        const el = document.querySelector(sel);
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const left = Math.max(r.left, px);
        const top = Math.max(r.top, py);
        const right = Math.min(r.right, pr);
        const bottom = Math.min(r.bottom, pb);
        if (right - left < 4 || bottom - top < 8) return; // not meaningfully visible in the panel
        out.push({ n: i + 1, top, left, width: right - left, height: bottom - top });
      });
      setSubRects(out);
    };
    subMeasureRef.current = measureSubs;
    const locateHint = setTimeout(() => { if (!cancelled) setLocating(true); }, 320);
    const done = () => {
      if (cancelled) return;
      clearTimeout(locateHint);
      setLocating(false);
      setReady(true);
      setRevealed(true);
    };

    // Navigate first (HashRouter is synchronous enough that the page mounts next tick).
    if (step.page) {
      try { navigate(step.page); } catch { /* ignore */ }
    }

    // Popup coordination for the Action Center + detail-popup steps:
    //  • non-popup steps → close any open meeting/milestone/workload/glance popup so the spotlight
    //    lands on the page beneath, not a leftover modal.
    //  • openMeetingFirst → ensure the meeting detail panel is open (click the first calendar event).
    //  • openWorkloadFirst → ensure a workload popup is open (click the reader's "Open" button).
    //  • expandWorkloadsSection → close the workload popup and expand the embedded Workloads section.
    //  • openGlanceFirst → ensure the account "glance" popup is open (click the first customer card).
    //  • openMilestoneFirst → ensure a milestone detail popup is open (click the first milestone row).
    // The meeting/milestone panels close on click; the workload + glance modals close on mousedown —
    // dispatch both so either kind of popup goes away.
    const closeOpenPopups = () => {
      document.querySelectorAll('.eng-detail-backdrop, .ca-modal-backdrop').forEach((b) => {
        try { b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); b.click(); } catch { /* ignore */ }
      });
    };
    if (step.openMeetingFirst) {
      if (!document.querySelector('.eng-detail-card')) {
        const ev = document.querySelector('.ac-cal-event');
        if (ev) { try { ev.click(); } catch { /* ignore */ } }
      }
    } else if (step.openWorkloadFirst) {
      if (!document.querySelector('.wl-modal-card')) {
        const open = document.querySelector('[data-tour="wl-open"]');
        if (open) { try { open.click(); } catch { /* ignore */ } }
      }
    } else if (step.expandWorkloadsSection) {
      closeOpenPopups();
      if (!document.querySelector('#ac-workloads .ac-embed-body')) {
        const head = document.querySelector('#ac-workloads .ac-section-head-clickable');
        if (head) { try { head.click(); } catch { /* ignore */ } }
      }
    } else if (step.openGlanceFirst) {
      // The page (/email) may need a beat to mount, then open the first account's glance popup.
      setTimeout(() => {
        if (cancelled || document.querySelector('.ca-modal')) return;
        const card = document.querySelector('.ca-card');
        if (card) { try { card.click(); } catch { /* ignore */ } }
      }, 120);
    } else if (step.openMilestoneFirst) {
      setTimeout(() => {
        if (cancelled || document.querySelector('[data-tour="ms-panel"]')) return;
        const row = document.querySelector('[data-tour="ms-row"]');
        if (row) { try { row.click(); } catch { /* ignore */ } }
      }, 120);
    } else {
      closeOpenPopups();
    }

    // Intentionally centered step (no target) — show the card in the middle immediately.
    if (!step.target) {
      const t = setTimeout(() => { if (!cancelled) { setRect(null); done(); } }, 60);
      return () => { cancelled = true; clearTimeout(t); clearTimeout(locateHint); };
    }

    const start = Date.now();
    let raf = 0;
    const fullyInView = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0
        && r.top >= 0 && r.left >= 0
        && r.bottom <= window.innerHeight && r.right <= window.innerWidth;
    };
    // Commit the resolved target: adopt it as the tracked element AND measure it in one shot, then
    // reveal. targetElRef is assigned HERE (not the moment the element is found) so the reflow
    // listener never tracks the target WHILE it is still scrolling into view — that mid-scroll
    // tracking made the spotlight jump onto the new element and chase it up the page (the 7->8
    // "not smooth"). Until commit, the previous step's spotlight stays frozen, then glides once.
    const commit = (el) => {
      if (cancelled) return;
      targetElRef.current = el;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      measureSubs(r);
      done();
      settle(el);
    };
    // After the first measure, keep re-measuring briefly: a popup/modal target (e.g. the workload
    // AI buttons) can still be sliding/reflowing into its centered position when we first measure,
    // which left the ring misaligned "sometimes" (step 9). Each correction is a tiny value change
    // the `gliding` transition animates, so the ring smoothly snaps onto the settled target.
    const settle = (el) => {
      let n = 0;
      const tick = () => {
        if (cancelled || !el || !document.contains(el)) return;
        const r = el.getBoundingClientRect();
        setRect((prev) => (prev
          && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5
          && Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5)
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height });
        measureSubs(r);
        if (++n < 8) settleTimer = setTimeout(tick, 60); // ~480ms of settling
      };
      settleTimer = setTimeout(tick, 60);
    };
    const poll = () => {
      if (cancelled) return;
      const el = step.target ? document.querySelector(step.target) : null;
      if (el) {
        if (fullyInView(el)) {
          // Already on screen — glide straight to it, no scroll, no beat.
          requestAnimationFrame(() => commit(el));
        } else {
          // Instant (not smooth) scroll: the screen is mostly darkened so the content jump is
          // barely visible, and the spotlight then does ONE clean glide to the settled position —
          // far smoother than chasing a smooth-scroll's moving target frame by frame.
          try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch { /* ignore */ }
          requestAnimationFrame(() => requestAnimationFrame(() => commit(el)));
        }
        return;
      }
      if (Date.now() - start > TARGET_TIMEOUT_MS) {
        setRect(null);          // fall back to centered card
        done();
        return;
      }
      raf = requestAnimationFrame(poll);
    };
    // Give the navigation a beat to mount the page before polling.
    const kick = setTimeout(poll, 60);

    return () => { cancelled = true; cancelAnimationFrame(raf); clearTimeout(kick); clearTimeout(locateHint); clearTimeout(settleTimer); };
  }, [index, step.page, step.target, navigate]);

  // Keep the spotlight aligned on scroll/resize while a target is resolved.
  useEffect(() => {
    if (!rect || !targetElRef.current) return undefined;
    const reflow = () => {
      const el = targetElRef.current;
      if (!el || !document.contains(el)) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      if (subMeasureRef.current) subMeasureRef.current(r);
    };
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    return () => {
      window.removeEventListener('resize', reflow);
      window.removeEventListener('scroll', reflow, true);
    };
  }, [rect]);

  // Click-to-advance: when a step opts in, clicking the highlighted element also advances the
  // tour (so performing the real action moves forward). Capture-phase so it fires even if the
  // element stops propagation.
  useEffect(() => {
    if (!step.clickAdvances || !ready) return undefined;
    const el = targetElRef.current;
    if (!el) return undefined;
    const handler = () => { setTimeout(goNext, 120); };
    el.addEventListener('click', handler, { capture: true, once: true });
    return () => el.removeEventListener('click', handler, { capture: true });
  }, [step.clickAdvances, ready, index, goNext]);

  // Real load-state tracking for `loading` steps. Polls the step's loadingSelector / readySelector
  // so the loading note truthfully reflects the page's actual fetch: 'loading' while the load
  // marker is present, 'loaded' once the ready marker appears (and stays — the data is cached).
  // Poll (rather than observe) keeps it simple and robust across the page's async renders.
  useEffect(() => {
    setLoadState(null);
    if (!step.loading || (!step.loadingSelector && !step.readySelector)) return undefined;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (step.readySelector && document.querySelector(step.readySelector)) {
        setLoadState('loaded'); // data has loaded (and cached) — stop polling
        return;
      }
      setLoadState('loading'); // ready marker not present yet → still loading
      timer = setTimeout(tick, 600);
    };
    let timer = setTimeout(tick, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [index, step.loading, step.loadingSelector, step.readySelector]);

  // Keyboard: Esc closes, ←/→ navigate.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, goNext, goBack]);

  // Card position: measured against the REAL rendered card so it never runs off an edge — the
  // fixed-width/fixed-height estimate previously clipped the taller bullet cards at the right/
  // bottom (step 12). Runs in a layout effect (before paint) so there's no visible reposition.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (!rect) {
      setCardPos({ top: Math.max(VP_MARGIN, (vh - h) / 2), left: Math.max(VP_MARGIN, (vw - w) / 2) });
      return;
    }
    // cardAnchor pins the card to a fixed viewport corner instead of hugging the target — used when
    // the target fills most of the screen (e.g. the expanded Workloads section) so no target-relative
    // placement can avoid overlapping it. The sub-boxes still point at the features on the target.
    if (step.cardAnchor === 'top-right') {
      setCardPos({ top: VP_MARGIN, left: Math.max(VP_MARGIN, vw - w - VP_MARGIN) });
      return;
    }
    let left;
    let top;
    if (step.placement === 'right') { left = rect.left + rect.width + CARD_GAP; top = rect.top; }
    else if (step.placement === 'left') { left = rect.left - w - CARD_GAP; top = rect.top; }
    else if (step.placement === 'top') { left = rect.left; top = rect.top - CARD_GAP - h; }
    else { left = rect.left; top = rect.top + rect.height + CARD_GAP; } // bottom (default)
    // Clamp against the MEASURED size so the whole card stays on-screen on every edge.
    left = Math.max(VP_MARGIN, Math.min(left, vw - w - VP_MARGIN));
    top = Math.max(VP_MARGIN, Math.min(top, vh - h - VP_MARGIN));
    setCardPos({ top, left });
  }, [rect, index, step.placement, step.cardAnchor, step.title, step.body, step.bullets, step.loading, step.narrow, loadState]);

  // Until measured, park the card off-screen (it's opacity:0 pre-reveal anyway) to avoid a flash
  // at the top-left corner on the very first frame.
  const cardStyle = cardPos
    ? { top: cardPos.top, left: cardPos.left }
    : { top: -9999, left: -9999 };

  // Four transparent click-blocker panels framing the cutout (block interaction outside the
  // target). Visible darkening is handled by the ring's box-shadow, not these panels. Only built
  // when there's a rect; the no-rect (centered) case renders a single full-screen scrim instead.
  const panels = [];
  if (rect) {
    const x = rect.left - SPOT_PAD;
    const y = rect.top - SPOT_PAD;
    const w = rect.width + SPOT_PAD * 2;
    const h = rect.height + SPOT_PAD * 2;
    panels.push({ key: 't', style: { top: 0, left: 0, right: 0, height: Math.max(0, y) } });
    panels.push({ key: 'b', style: { top: y + h, left: 0, right: 0, bottom: 0 } });
    panels.push({ key: 'l', style: { top: y, left: 0, width: Math.max(0, x), height: h } });
    panels.push({ key: 'r', style: { top: y, left: x + w, right: 0, height: h } });
  }

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="Guided tour">
      {rect ? (
        <>
          {/* Transparent click-blockers around the cutout (block interaction outside the target).
              The visible darkening is the ring's box-shadow — a SINGLE element — so there are no
              seams between dark panels to flash a thin line mid-glide (the 9->10 "weird line"). */}
          {panels.map((p) => (
            <div key={p.key} className="tour-block" style={p.style} onClick={() => { /* swallow outside clicks */ }} />
          ))}
          <div
            className={`tour-ring${step.clickAdvances ? ' clickable' : ''}${revealed ? ' revealed' : ''}${revealed ? ' gliding' : ''}`}
            style={{
              top: rect.top - SPOT_PAD, left: rect.left - SPOT_PAD,
              width: rect.width + SPOT_PAD * 2, height: rect.height + SPOT_PAD * 2,
            }}
          />
          {/* Secondary accent boxes on the bulleted sub-areas inside the target, numbered to match
              the card's bullets. They sit in the lit cutout (not darkened) so they read as gentle
              call-outs pointing to where each bulleted feature lives. */}
          {revealed ? subRects.map((s) => (
            <div
              key={s.n}
              className="tour-subring"
              style={{ top: s.top - 3, left: s.left - 3, width: s.width + 6, height: s.height + 6 }}
            >
              <span className="tour-subring-num">{s.n}</span>
            </div>
          )) : null}
        </>
      ) : (
        <div className="tour-scrim-full" onClick={() => { /* swallow outside clicks */ }} />
      )}

      <div ref={cardRef} className={`tour-card${revealed ? ' revealed' : ''}${revealed ? ' gliding' : ''}${step.narrow ? ' tour-card-narrow' : ''}`} style={cardStyle}>
        <div className="tour-card-head">
          <span className="tour-step-count">{index + 1} / {steps.length}</span>
          <button type="button" className="tour-close" title="End tour" onClick={onClose}><DismissRegular /></button>
        </div>
        <div className="tour-card-title">{step.title}</div>
        <div className="tour-card-body">{step.body}</div>
        {step.bullets ? (
          <ul className={`tour-card-bullets${step.subTargets ? ' numbered' : ''}`}>
            {step.bullets.map((b, i) => (
              <li key={b.label}>
                {step.subTargets ? <span className="tour-bullet-num">{i + 1}</span> : null}
                <strong>{b.label}</strong> — {b.text}
              </li>
            ))}
          </ul>
        ) : null}
        {step.loading ? (
          loadState === 'loaded' ? (
            <div className="tour-loading-note loaded">
              <CheckmarkCircleFilled /> Loaded and cached — next time it opens instantly.
            </div>
          ) : (
            <div className="tour-loading-note">
              <Spinner size="tiny" /> Loading live data — first load ~{step.loadingMinutes || 'a minute'}. It caches locally, so later visits are instant.
            </div>
          )
        ) : null}
        {locating ? (
          <div className="tour-locating"><Spinner size="tiny" /> Locating…</div>
        ) : null}
        {step.clickAdvances && ready && rect ? (
          <div className="tour-hint">Tip: click the highlighted control to continue, or use the arrow.</div>
        ) : null}
        <div className="tour-card-foot">
          <button type="button" className="tour-skip" onClick={onClose}>End tour</button>
          <div className="tour-nav">
            {index > 0 ? (
              <button type="button" className="tour-btn tour-btn-ghost" onClick={goBack}><ArrowLeftRegular /> Back</button>
            ) : null}
            <button type="button" className="tour-btn tour-btn-primary" onClick={last ? onClose : goNext}>
              {last ? 'Done' : <>Next <ArrowRightRegular /></>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
