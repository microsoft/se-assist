import { useState, useMemo } from 'react';
import { Input, Button } from '@fluentui/react-components';
import { SearchRegular, OpenRegular } from '@fluentui/react-icons';
import {
  MICROSOFT_PRODUCTS,
  PRODUCT_LABELS,
  labelColor,
  learnUrl,
} from '../lib/microsoftProducts';
import { openExternal } from '../electronBridge';

// Chip used for a capability label (M365, AI, Azure, …). Colored per-label so the
// eye can scan the catalog by lens quickly.
function LabelChip({ label, active, onClick, interactive }) {
  const color = labelColor(label);
  const style = {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    lineHeight: '16px',
    border: `1px solid ${color}${active === false ? '55' : ''}`,
    background: active === false ? 'transparent' : `${color}18`,
    color,
    cursor: interactive ? 'pointer' : 'default',
    opacity: active === false ? 0.5 : 1,
  };
  return (
    <span
      className="prod-label-chip"
      style={style}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
    >
      {label}
    </span>
  );
}

export default function Products() {
  const [search, setSearch] = useState('');
  const [activeLabels, setActiveLabels] = useState(() => new Set());

  const toggleLabel = (key) => {
    setActiveLabels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return MICROSOFT_PRODUCTS.filter((p) => {
      // Label filter: product must carry EVERY selected label (AND semantics).
      if (activeLabels.size > 0) {
        for (const key of activeLabels) {
          if (!p.labels.includes(key)) return false;
        }
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.labels.some((l) => l.toLowerCase().includes(q))
      );
    });
  }, [search, activeLabels]);

  // Preserve catalog order, grouped by category.
  const grouped = useMemo(() => {
    const order = [];
    const map = new Map();
    for (const p of filtered) {
      if (!map.has(p.category)) {
        map.set(p.category, []);
        order.push(p.category);
      }
      map.get(p.category).push(p);
    }
    return order.map((cat) => ({ category: cat, items: map.get(cat) }));
  }, [filtered]);

  return (
    <div>
      <div className="page-header">
        <h2>Microsoft Products</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {filtered.length} of {MICROSOFT_PRODUCTS.length} products
        </span>
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '-8px 0 16px' }}>
        Catalog of Microsoft products tagged by capability. Filter by one or more labels
        (products must match all selected labels) or search by name.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Input
          contentBefore={<SearchRegular />}
          placeholder="Search products…"
          value={search}
          onChange={(_, d) => setSearch(d.value)}
          style={{ minWidth: 260 }}
        />
        {activeLabels.size > 0 && (
          <Button size="small" appearance="subtle" onClick={() => setActiveLabels(new Set())}>
            Clear labels
          </Button>
        )}
      </div>

      {/* Label legend / filter row */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        {PRODUCT_LABELS.map((l) => (
          <LabelChip
            key={l.key}
            label={l.name}
            interactive
            active={activeLabels.size === 0 ? true : activeLabels.has(l.key)}
            onClick={() => toggleLabel(l.key)}
          />
        ))}
      </div>

      {grouped.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>No products match your filter.</p>
      ) : (
        grouped.map((g) => (
          <div key={g.category} style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: 0.4, color: 'var(--text-muted)', margin: '0 0 10px',
            }}>
              {g.category} <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}>· {g.items.length}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {g.items.map((p) => {
                const url = learnUrl(p.name);
                return (
                  <div className="card" key={p.name} style={{ padding: 14, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>{p.name}</div>
                    <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                      {p.description}
                    </p>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {p.labels.map((l) => (
                        <LabelChip key={l} label={l} />
                      ))}
                    </div>
                    {url && (
                      <div style={{ marginTop: 'auto', paddingTop: 10 }}>
                        <Button
                          size="small"
                          appearance="subtle"
                          icon={<OpenRegular />}
                          onClick={() => openExternal(url)}
                          style={{ color: 'var(--accent)', paddingLeft: 0 }}
                        >
                          Microsoft Learn
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
