import { useMemo } from 'react';

// Deterministic force-directed layout (repulsion + springs + centering). Runs a fixed
// number of iterations inside a memo rather than animating, so the web settles to the
// same arrangement every render — no simulation loop, no extra dependency.
// Nodes need an `id`; edges need `source`, `target` and a numeric `total` weight.
export function useForceLayout(nodes, edges, width, height, iterations = 320) {
  return useMemo(() => {
    const count = nodes.length;
    if (!count) return new Map();
    // Seed on a circle so the starting state (and therefore the result) is stable.
    const points = nodes.map((node, i) => {
      const angle = (i / count) * Math.PI * 2;
      const radius = Math.min(width, height) * 0.32;
      return {
        id: node.id,
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      };
    });
    const indexById = new Map(points.map((p, i) => [p.id, i]));
    const links = edges
      .map((edge) => ({ a: indexById.get(edge.source), b: indexById.get(edge.target), weight: edge.total }))
      .filter((link) => link.a != null && link.b != null);
    // Tuned against a real dense account (50 contacts / ~200 links): a larger ideal
    // distance with softer springs spreads the web across the canvas instead of
    // collapsing it into an unreadable ball.
    const ideal = Math.sqrt((width * height) / count) * 1.3;

    for (let iter = 0; iter < iterations; iter += 1) {
      const alpha = 1 - iter / iterations;
      for (let i = 0; i < count; i += 1) {
        for (let j = i + 1; j < count; j += 1) {
          let dx = points[i].x - points[j].x;
          let dy = points[i].y - points[j].y;
          let dist2 = dx * dx + dy * dy;
          if (dist2 < 0.01) { dx = (i - j) || 1; dy = 1; dist2 = dx * dx + dy * dy; }
          const dist = Math.sqrt(dist2);
          const force = ((ideal * ideal) / dist2) * 0.9;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          points[i].vx += fx; points[i].vy += fy;
          points[j].vx -= fx; points[j].vy -= fy;
        }
      }
      for (const link of links) {
        const a = points[link.a];
        const b = points[link.b];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        // Stronger ties pull a little tighter, so frequent collaborators cluster.
        const strength = Math.min(1, 0.5 + Math.log2(link.weight + 1) / 4);
        const force = ((dist - ideal) / ideal) * 1.5 * strength;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      for (const point of points) {
        point.vx += (width / 2 - point.x) * 0.005;
        point.vy += (height / 2 - point.y) * 0.005;
        point.x += Math.max(-30, Math.min(30, point.vx * alpha));
        point.y += Math.max(-30, Math.min(30, point.vy * alpha));
        point.vx *= 0.82; point.vy *= 0.82;
        point.x = Math.max(46, Math.min(width - 46, point.x));
        point.y = Math.max(46, Math.min(height - 46, point.y));
      }
    }
    return new Map(points.map((p) => [p.id, { x: p.x, y: p.y }]));
  }, [nodes, edges, width, height, iterations]);
}

export default useForceLayout;
