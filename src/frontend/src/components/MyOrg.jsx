import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import {
  Button, Select, Input, Textarea, Spinner, Field, Checkbox,
} from '@fluentui/react-components';
import {
  ChevronRightRegular, ChevronDownRegular, SearchRegular,
  ArrowClockwiseRegular, PersonRegular, DismissRegular,
  PeopleTeamRegular, CalendarLtrRegular,
} from '@fluentui/react-icons';
import { useDbQuery } from '../hooks/useDb';
import {
  orgGetTree, orgGetReports, orgSearchPeople, orgCustomerTeam, orgProductSearch,
  orgPersonActivity, orgCustomerRelationships,
} from '../electronBridge';
import PanZoomViewport from './PanZoomViewport';
import { useForceLayout } from '../hooks/useForceLayout';
import { formatLocalDate } from '../lib/datetime';

function PersonCard({ person, focus, muted, sub, right, onInspect }) {
  const name = person?.displayName || person?.name || '(unknown)';
  const clickable = typeof onInspect === 'function' && person?.id;
  const openDetail = clickable ? () => onInspect(person) : undefined;
  return (
    <div className={`org-person${focus ? ' is-focus' : ''}${muted ? ' is-muted' : ''}`}>
      <div
        className="org-person-main"
        style={{ cursor: clickable ? 'pointer' : undefined }}
        onClick={openDetail}
        title={clickable ? 'View customer contacts & activity' : undefined}
      >
        <div className="org-person-name">{name}</div>
        {person?.jobTitle ? <div className="org-person-title">{person.jobTitle}</div> : null}
        {sub ? <div className="org-person-sub">{sub}</div> : null}
      </div>
      {right}
    </div>
  );
}

// Recursive, lazily-expandable subtree rooted at `person`.
function TreeNode({ person, childrenById, expandedIds, loadingIds, focusId, onToggle, onInspect }) {
  const id = person.id;
  const loaded = Object.prototype.hasOwnProperty.call(childrenById, id);
  const kids = childrenById[id] || [];
  const expanded = expandedIds.has(id);
  const busy = loadingIds.has(id);
  const canExpand = !loaded || kids.length > 0;

  const toggle = (
    <button
      type="button"
      className="org-expand-btn"
      onClick={() => onToggle(person)}
      disabled={busy || (loaded && kids.length === 0)}
      title={loaded && kids.length === 0 ? 'No direct reports' : (expanded ? 'Collapse' : 'Expand reports')}
    >
      {busy ? <Spinner size="tiny" />
        : expanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
    </button>
  );

  return (
    <div className="org-node">
      <PersonCard
        person={person}
        focus={id === focusId}
        sub={person.department || person.officeLocation || person.city || ''}
        right={canExpand ? toggle : null}
        onInspect={onInspect}
      />
      {expanded && kids.length > 0 && (
        <div className="org-children">
          {kids.map((kid) => (
            <TreeNode
              key={kid.id}
              person={kid}
              childrenById={childrenById}
              expandedIds={expandedIds}
              loadingIds={loadingIds}
              focusId={focusId}
              onToggle={onToggle}
              onInspect={onInspect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Org map (pan/zoom diagram) ────────────────────────────────────────────────
// A card styled like the milestone-map nodes, used inside the pan/zoom viewport.
function PersonMapCard({ person, focus, muted, sub, expandControl, onInspect, dragRef }) {
  const name = person?.displayName || person?.name || '(unknown)';
  const clickable = typeof onInspect === 'function' && person?.id;
  const openDetail = clickable
    ? () => { if (!dragRef?.current?.moved) onInspect(person); }
    : undefined;
  return (
    <div className={`org-map-node${focus ? ' is-focus' : ''}${muted ? ' is-muted' : ''}`}>
      <div
        className="org-map-body"
        style={{ cursor: clickable ? 'pointer' : undefined }}
        onClick={openDetail}
        title={clickable ? 'View customer contacts & activity' : undefined}
      >
        <div className="org-map-name">{name}</div>
        {person?.jobTitle ? <div className="org-map-title">{person.jobTitle}</div> : null}
        {sub ? <div className="org-map-sub">{sub}</div> : null}
      </div>
      {expandControl}
    </div>
  );
}

// Recursive node for the org map: renders an <li> with a card + nested <ul> of reports.
function OrgMapNode({ person, childrenById, expandedIds, loadingIds, focusId, onToggle, onInspect, dragRef }) {
  const id = person.id;
  const loaded = Object.prototype.hasOwnProperty.call(childrenById, id);
  const kids = childrenById[id] || [];
  const expanded = expandedIds.has(id);
  const busy = loadingIds.has(id);
  const canExpand = !loaded || kids.length > 0;

  const expandControl = canExpand ? (
    <button
      type="button"
      className="org-map-expand"
      onClick={() => { if (!dragRef?.current?.moved) onToggle(person); }}
      disabled={busy || (loaded && kids.length === 0)}
      title={loaded && kids.length === 0 ? 'No direct reports' : (expanded ? 'Collapse' : 'Expand reports')}
    >
      {busy ? <Spinner size="tiny" />
        : expanded ? <ChevronDownRegular /> : <ChevronRightRegular />}
    </button>
  ) : null;

  return (
    <li>
      <PersonMapCard
        person={person}
        focus={id === focusId}
        expandControl={expandControl}
        onInspect={onInspect}
        dragRef={dragRef}
      />
      {expanded && kids.length > 0 && (
        <ul>
          {kids.map((kid) => (
            <OrgMapNode
              key={kid.id}
              person={kid}
              childrenById={childrenById}
              expandedIds={expandedIds}
              loadingIds={loadingIds}
              focusId={focusId}
              onToggle={onToggle}
              onInspect={onInspect}
              dragRef={dragRef}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// Org map: pan/zoom diagram mirroring the Milestone Map. Nests the manager reporting
// line above the focus person as a single-child chain when there is one root.
function OrgMap({ roots, managers, childrenById, expandedIds, loadingIds, focusId, onToggle, onInspect }) {
  const dragRef = useRef(null);

  // Content signature so the viewport re-clamps when the tree grows/shrinks.
  const contentKey = useMemo(() => {
    const rootIds = roots.map((r) => r.id).join(',');
    const mgrIds = managers.map((m) => m.id).join(',');
    const expanded = [...expandedIds].join(',');
    const loadedCount = Object.keys(childrenById).length;
    return `${rootIds}|${mgrIds}|${expanded}|${loadedCount}`;
  }, [roots, managers, childrenById, expandedIds]);

  // Focus subtree as a single <li>.
  const focusNodes = roots.map((person) => (
    <OrgMapNode
      key={person.id}
      person={person}
      childrenById={childrenById}
      expandedIds={expandedIds}
      loadingIds={loadingIds}
      focusId={focusId}
      onToggle={onToggle}
      onInspect={onInspect}
      dragRef={dragRef}
    />
  ));

  // When there is a single root and a resolved manager chain, nest managers above it
  // (top of org at the outermost <li>, focus person deepest).
  let topLevel;
  if (roots.length === 1 && managers.length > 0) {
    topLevel = managers.reduceRight((childLi, mgr) => (
      <li key={`mgr-${mgr.id || mgr.displayName}`}>
        <PersonMapCard person={mgr} muted onInspect={mgr.id ? onInspect : undefined} dragRef={dragRef} />
        <ul>{childLi}</ul>
      </li>
    ), focusNodes[0]);
    topLevel = [topLevel];
  } else {
    topLevel = focusNodes;
  }

  return (
    <PanZoomViewport dragStateRef={dragRef} contentKey={contentKey}>
      <ul className="eng-tree org-eng-tree">
        {topLevel}
      </ul>
    </PanZoomViewport>
  );
}

// Customer account map: every on-account team member on a single pan/zoom map.
// The reporting chain is preserved — when one member manages another member, the
// report is nested beneath them (recursively). Only an *external* manager (someone
// who is not themselves on the account team) is surfaced as a muted top node.

// Sub-label for a customer account-team member. Base line is directory dept / email;
// CRM owners get a trailing tag with their owned milestone/opportunity counts so it's
// clear they came from Dynamics ownership rather than (or in addition to) comms signals.
function customerMemberSub(m) {
  const base = m.person ? (m.person.department || m.email) : (m.email || 'no directory match');
  if (!m.crmOwner) return base;
  const parts = [];
  const ms = Number(m.ownedMilestones) || 0;
  const opp = Number(m.ownedOpportunities) || 0;
  if (ms) parts.push(`${ms} milestone${ms === 1 ? '' : 's'}`);
  if (opp) parts.push(`${opp} opp${opp === 1 ? '' : 's'}`);
  const tag = parts.length ? `CRM owner · ${parts.join(', ')}` : 'CRM owner';
  return base ? `${base} · ${tag}` : tag;
}

// Recursive node for the customer map. `node` = { member, children: node[] }.
function CustomerMemberNode({ node, onInspect, dragRef }) {
  const { member, children } = node;
  return (
    <li>
      <PersonMapCard
        person={member.person || { displayName: member.name }}
        sub={customerMemberSub(member)}
        onInspect={member.person?.id ? onInspect : undefined}
        dragRef={dragRef}
      />

      {children.length > 0 && (
        <ul>
          {children.map((c) => (
            <CustomerMemberNode
              key={c.member.person?.id || c.member.email || c.member.name}
              node={c}
              onInspect={onInspect}
              dragRef={dragRef}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function CustomerOrgMap({ groups, onInspect }) {
  const dragRef = useRef(null);

  const contentKey = useMemo(
    () => groups.map((g) => `${g.manager?.id || 'none'}:${g.nodes.length}`).join('|'),
    [groups],
  );

  return (
    <PanZoomViewport dragStateRef={dragRef} contentKey={contentKey}>
      <ul className="eng-tree org-eng-tree">
        {groups.map((g, idx) => (
          <li key={g.manager?.id || `none-${idx}`}>
            {g.manager ? (
              <PersonMapCard
                person={g.manager}
                muted
                sub={`Manager${g.manager.jobTitle ? ` · ${g.manager.jobTitle}` : ''}`}
                onInspect={g.manager.id ? onInspect : undefined}
                dragRef={dragRef}
              />
            ) : (
              <div className="org-map-node is-muted">
                <div className="org-map-body">
                  <div className="org-map-name">Manager not resolved</div>
                </div>
              </div>
            )}
            {g.nodes.length > 0 && (
              <ul>
                {g.nodes.map((n) => (
                  <CustomerMemberNode
                    key={n.member.person?.id || n.member.email || n.member.name}
                    node={n}
                    onInspect={onInspect}
                    dragRef={dragRef}
                  />
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </PanZoomViewport>
  );
}

function nodeRadius(node) {
  return 9 + Math.min(15, Math.log2((node.interactions || 1) + 1) * 3);
}

const EVENT_ICON = { email: '✉', meeting: '📅', teams: '💬' };
const EVENT_LABEL = { email: 'Email', meeting: 'Meeting', teams: 'Teams chat' };

// Ingested timestamps are a mix of Graph naive-UTC (meetings) and offset-carrying
// (email) strings, so reuse the shared parser rather than rolling another one.
function formatEventDate(value) {
  return formatLocalDate(value, { month: 'short', day: 'numeric', year: 'numeric' });
}

// The customer interaction web: customer contacts only, linked to each other by the
// items they share. Each node badges how many Microsoft people it is connected to;
// hovering lists them, clicking opens the full detail panel.
const MAP_WIDTH = 960;

function CustomerRelationshipMap({ graph, selectedId, onSelect }) {
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  const details = graph?.details || {};
  const [hover, setHover] = useState(null); // { id, x, y } — canvas-relative
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const panRef = useRef(null);
  const canvasRef = useRef(null);
  const svgRef = useRef(null);

  const height = Math.max(420, Math.min(760, 300 + nodes.length * 9));
  const positions = useForceLayout(nodes, edges, MAP_WIDTH, height);

  // Neighbours of the hovered/selected node get emphasised; everything else dims.
  const activeId = hover?.id || selectedId || '';
  const neighbourIds = useMemo(() => {
    if (!activeId) return null;
    const set = new Set([activeId]);
    for (const edge of edges) {
      if (edge.source === activeId) set.add(edge.target);
      if (edge.target === activeId) set.add(edge.source);
    }
    return set;
  }, [activeId, edges]);

  // Wheel zoom is attached natively so preventDefault actually works — React's
  // onWheel is passive, so the page would scroll while zooming (same reason
  // PanZoomViewport does this).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      setView((prev) => ({
        ...prev,
        scale: Math.min(3, Math.max(0.4, prev.scale * (e.deltaY < 0 ? 1.12 : 0.89))),
      }));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    // Re-attach when the SVG appears (the empty state renders no <svg> to bind to).
  }, [nodes.length]);

  const onMouseDown = (e) => {
    panRef.current = { startX: e.clientX, startY: e.clientY, originX: view.x, originY: view.y, moved: false };
  };
  const onMouseMove = (e) => {
    const pan = panRef.current;
    if (!pan) return;
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.moved = true;
    setView((prev) => ({ ...prev, x: pan.originX + dx, y: pan.originY + dy }));
  };
  const endPan = () => { panRef.current = null; };

  if (!nodes.length) {
    return (
      <div className="org-empty">
        No customer contacts have been observed yet. Ingest account-linked emails,
        meetings, or Teams chats to build this map.
      </div>
    );
  }

  const hoveredDetail = hover ? details[hover.id] : null;
  const hoveredNode = hover ? nodes.find((n) => n.id === hover.id) : null;

  return (
    <div className="org-rel-wrap">
      <div className="org-rel-summary">
        <span>
          <i className="org-rel-dot external" /> Customer contacts ({graph.summary?.externalPeople || 0}
          {graph.summary?.truncated ? `, showing top ${graph.summary.externalShown}` : ''})
        </span>
        <span>{graph.summary?.customerConnections || 0} contact-to-contact links</span>
        <span>
          <i className="org-rel-dot internal" /> {graph.summary?.internalPeople || 0} Microsoft people connected
        </span>
        <span>{graph.summary?.interactions || 0} shared items</span>
      </div>

      <div className="org-rel-canvas" ref={canvasRef}>
        <svg
          ref={svgRef}
          className="org-rel-map"
          viewBox={`0 0 ${MAP_WIDTH} ${height}`}
          role="img"
          aria-label="Customer contact interaction web"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endPan}
          onMouseLeave={() => { endPan(); setHover(null); }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            <g className="org-rel-edges">
              {edges.map((edge) => {
                const source = positions.get(edge.source);
                const target = positions.get(edge.target);
                if (!source || !target) return null;
                const dim = neighbourIds && !(neighbourIds.has(edge.source) && neighbourIds.has(edge.target));
                return (
                  <line
                    key={edge.id}
                    className={dim ? 'is-dim' : ''}
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                    strokeWidth={Math.min(6, 1 + Math.log2(edge.total + 1))}
                  >
                    <title>
                      {`${edge.total} shared item${edge.total === 1 ? '' : 's'}: ${edge.emailCount} email, ${edge.meetingCount} meeting, ${edge.teamsCount} Teams`}
                    </title>
                  </line>
                );
              })}
            </g>

            {nodes.map((node) => {
              const point = positions.get(node.id);
              if (!point) return null;
              const radius = nodeRadius(node);
              const dim = neighbourIds && !neighbourIds.has(node.id);
              const isSelected = node.id === selectedId;
              return (
                <g
                  key={node.id}
                  transform={`translate(${point.x} ${point.y})`}
                  className={`org-rel-node external${dim ? ' is-dim' : ''}${isSelected ? ' is-selected' : ''}`}
                  onMouseEnter={(e) => {
                    const box = canvasRef.current?.getBoundingClientRect();
                    setHover({
                      id: node.id,
                      x: box ? e.clientX - box.left : 0,
                      y: box ? e.clientY - box.top : 0,
                    });
                  }}
                  onMouseLeave={() => setHover((prev) => (prev?.id === node.id ? null : prev))}
                  onClick={() => { if (!panRef.current?.moved) onSelect(node.id); }}
                  style={{ cursor: 'pointer' }}
                >
                  <circle r={radius} />
                  {node.microsoftCount > 0 && (
                    <g className="org-rel-badge" transform={`translate(${radius * 0.78} ${-radius * 0.78})`}>
                      <circle r="9" />
                      <text textAnchor="middle" dy="3.5">{node.microsoftCount}</text>
                    </g>
                  )}
                  <text className="org-rel-label" textAnchor="middle" y={radius + 15}>{node.name}</text>
                </g>
              );
            })}
          </g>
        </svg>

        {hover && hoveredNode && (
          <div
            className="org-rel-tooltip"
            style={{
              left: Math.min(hover.x + 16, (canvasRef.current?.clientWidth || MAP_WIDTH) - 260),
              top: hover.y + 16,
            }}
          >
            <div className="org-rel-tooltip-name">{hoveredNode.name}</div>
            {hoveredNode.email && <div className="org-rel-tooltip-mail">{hoveredNode.email}</div>}
            <div className="org-rel-tooltip-head">
              Microsoft contacts ({hoveredDetail?.microsoft?.length || 0})
            </div>
            {hoveredDetail?.microsoft?.length ? (
              <ul className="org-rel-tooltip-list">
                {hoveredDetail.microsoft.slice(0, 8).map((person) => (
                  <li key={person.id}>
                    {person.name}
                    <span className="org-rel-tooltip-count">{person.sharedEvents}</span>
                  </li>
                ))}
                {hoveredDetail.microsoft.length > 8 && (
                  <li className="org-rel-tooltip-more">+{hoveredDetail.microsoft.length - 8} more — click to see all</li>
                )}
              </ul>
            ) : (
              <div className="org-rel-tooltip-empty">No Microsoft contact observed yet.</div>
            )}
          </div>
        )}
      </div>

      <div className="org-rel-hint">
        Each dot is a customer contact; lines are the emails, meetings, and chats they share.
        The badge counts the Microsoft people they have worked with. Scroll to zoom, drag to pan,
        hover for the Microsoft list, and click a contact for full detail.
      </div>
    </div>
  );
}

// Full detail for one customer contact: who else at the customer they are connected
// to, which Microsoft people they work with, and the items backing both.
function CustomerContactDetail({ graph, contactId, onClose, onSelect }) {
  const node = (graph?.nodes || []).find((n) => n.id === contactId);
  const detail = graph?.details?.[contactId];
  const eventsById = useMemo(
    () => new Map((graph?.events || []).map((event) => [event.id, event])),
    [graph],
  );
  if (!node) return null;
  const items = (detail?.eventIds || []).map((id) => eventsById.get(id)).filter(Boolean);
  const hiddenItems = Math.max(0, (detail?.eventTotal || 0) - items.length);

  return (
    <div className="card org-rel-detail">
      <div className="card-header-custom org-rel-detail-head">
        <span>
          <strong>{node.name}</strong>
          {node.email ? <span className="org-rel-detail-mail"> — {node.email}</span> : null}
        </span>
        <Button size="small" appearance="subtle" icon={<DismissRegular />} onClick={onClose} title="Close details" />
      </div>
      <div className="card-body-custom">
        <div className="org-rel-detail-grid">
          <div>
            <div className="org-rel-detail-label">
              Customer contacts ({detail?.customers?.length || 0})
            </div>
            {detail?.customers?.length ? (
              <ul className="org-rel-people">
                {detail.customers.map((person) => (
                  <li key={person.id}>
                    <button type="button" className="org-rel-people-link" onClick={() => onSelect(person.id)}>
                      {person.name}
                    </button>
                    <span className="org-rel-people-count">{person.sharedEvents} shared</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="org-rel-detail-empty">No other customer contact shares an item with them yet.</div>
            )}
          </div>

          <div>
            <div className="org-rel-detail-label">
              Microsoft contacts ({detail?.microsoft?.length || 0})
            </div>
            {detail?.microsoft?.length ? (
              <ul className="org-rel-people">
                {detail.microsoft.map((person) => (
                  <li key={person.id}>
                    <span title={person.email || ''}>{person.name}</span>
                    <span className="org-rel-people-count">{person.sharedEvents} shared</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="org-rel-detail-empty">No Microsoft person has been observed with them yet.</div>
            )}
          </div>

          <div>
            <div className="org-rel-detail-label">
              Emails, meetings &amp; chats ({detail?.eventTotal || 0})
            </div>
            {items.length ? (
              <ul className="org-rel-items">
                {items.map((event) => (
                  <li key={event.id}>
                    <span className="org-rel-item-kind" title={EVENT_LABEL[event.kind] || event.kind}>
                      {EVENT_ICON[event.kind] || '•'}
                    </span>
                    <span className="org-rel-item-title" title={event.title}>{event.title || '(no subject)'}</span>
                    <span className="org-rel-item-date">{formatEventDate(event.date)}</span>
                  </li>
                ))}
                {hiddenItems > 0 && (
                  <li className="org-rel-item-more">+{hiddenItems} older item{hiddenItems === 1 ? '' : 's'} not shown</li>
                )}
              </ul>
            ) : (
              <div className="org-rel-detail-empty">No items recorded.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Person detail drawer for a Microsoft person: the customer contacts they are
// connected to, and the account-linked emails, meetings and Teams chats behind that
// connection. Read from the local ingested datastore (no directory/model call), so
// it answers "what is this person's footprint on our customers?".
function PersonDetail({ person, onClose }) {
  const [loading, setLoading] = useState(false);
  const [activity, setActivity] = useState(null);
  const [error, setError] = useState('');

  const email = (person.mail || person.email || person.userPrincipalName || '').toLowerCase();

  useEffect(() => {
    let cancelled = false;
    setActivity(null); setError('');
    if (!email) {
      setError('This person has no directory email, so their customer activity cannot be looked up.');
      return undefined;
    }
    setLoading(true);
    (async () => {
      try {
        const res = await orgPersonActivity({ email });
        if (cancelled) return;
        if (res?.ok) setActivity(res);
        else setError(res?.error || 'Failed to load customer activity.');
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load customer activity.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [email]);

  const name = person.displayName || person.name || '(unknown)';
  const customers = activity?.customers || [];
  const items = activity?.items || [];

  return (
    <div className="card org-rel-detail">
      <div className="card-header-custom org-rel-detail-head">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span><strong>{name}</strong>{person.jobTitle ? ` — ${person.jobTitle}` : ''}</span>
          {loading && <Spinner size="tiny" />}
        </span>
        <Button size="small" appearance="subtle" icon={<DismissRegular />} onClick={onClose} title="Close details" />
      </div>
      <div className="card-body-custom">
        {error && <div style={{ color: 'var(--warning-text)', fontSize: 12 }}>{error}</div>}
        {!error && activity && (
          <div className="org-rel-detail-grid two">
            <div>
              <div className="org-rel-detail-label">
                <PeopleTeamRegular style={{ fontSize: 14, verticalAlign: '-2px' }} /> Customer contacts ({customers.length})
              </div>
              {customers.length ? (
                <ul className="org-rel-people">
                  {customers.map((contact) => (
                    <li key={contact.id}>
                      <span title={contact.email}>{contact.name}</span>
                      <span className="org-rel-people-count">{contact.sharedEvents} shared</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="org-rel-detail-empty">
                  No customer contact has been observed with this person in the ingested data.
                </div>
              )}
            </div>

            <div>
              <div className="org-rel-detail-label">
                <CalendarLtrRegular style={{ fontSize: 14, verticalAlign: '-2px' }} /> Emails, meetings &amp; chats ({items.length})
              </div>
              {items.length ? (
                <ul className="org-rel-items">
                  {items.map((event) => (
                    <li key={event.id}>
                      <span className="org-rel-item-kind" title={EVENT_LABEL[event.kind] || event.kind}>
                        {EVENT_ICON[event.kind] || '•'}
                      </span>
                      <span className="org-rel-item-title" title={event.title}>{event.title || '(no subject)'}</span>
                      <span className="org-rel-item-date">{formatEventDate(event.date)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="org-rel-detail-empty">No account-linked items found for this person.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function MyOrg() {
  const [mode, setMode] = useState('customer');
  const [layout, setLayout] = useState('map'); // 'map' (pan/zoom diagram) | 'list'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [inspected, setInspected] = useState(null); // person whose detail drawer is open

  // Shared lazy-tree state (individual / product modes).
  const [roots, setRoots] = useState([]);          // person[] shown at the top of the tree
  const [managers, setManagers] = useState([]);    // reporting line above the focus person
  const [managerChain, setManagerChain] = useState(null); // { reachedTop, stoppedReason }
  const [focusId, setFocusId] = useState('');
  const [childrenById, setChildrenById] = useState({});
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [loadingIds, setLoadingIds] = useState(() => new Set());

  const resetTree = useCallback(() => {
    setRoots([]); setManagers([]); setManagerChain(null); setFocusId('');
    setChildrenById({}); setExpandedIds(new Set()); setLoadingIds(new Set());
  }, []);

  // ── Individual hierarchy: load a rooted tree for a person ───────────────────
  // With no userId this resolves the signed-in user, which is the default view.
  const loadTree = useCallback(async (userId, opts = {}) => {
    setLoading(true); setError('');
    try {
      const payload = userId ? { userId } : {};
      if (opts.refresh) payload.refresh = true; // bypass the local cache, re-pull live
      const res = await orgGetTree(payload);
      if (!res?.ok) { setError(res?.error || 'Failed to load org tree.'); resetTree(); return; }
      const { person, managers: mgrs, reports } = res;
      setManagers((mgrs || []).slice().reverse()); // top of org first ... focus last
      setManagerChain(res.managerChain || null);
      setRoots([person]);
      setFocusId(person.id);
      setChildrenById({ [person.id]: reports || [] });
      setExpandedIds(new Set([person.id]));
      setLoadingIds(new Set());
    } catch (err) {
      setError(err?.message || String(err)); resetTree();
    } finally {
      setLoading(false);
    }
  }, [resetTree]);

  // Default view for the individual tab = the signed-in user's own hierarchy.
  const individualLoadedRef = useRef(false);
  useEffect(() => {
    if (mode !== 'individual') { individualLoadedRef.current = false; return; }
    if (individualLoadedRef.current) return;
    individualLoadedRef.current = true;
    loadTree();
  }, [mode, loadTree]);

  const onToggle = useCallback(async (person) => {
    const id = person.id;
    const loaded = Object.prototype.hasOwnProperty.call(childrenById, id);
    if (loaded) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      return;
    }
    setLoadingIds((prev) => new Set(prev).add(id));
    try {
      const res = await orgGetReports({ userId: id });
      const reports = res?.ok ? (res.reports || []) : [];
      setChildrenById((prev) => ({ ...prev, [id]: reports }));
      setExpandedIds((prev) => new Set(prev).add(id));
    } finally {
      setLoadingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, [childrenById]);

  // ── Individual search (typeahead) ────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showDrop, setShowDrop] = useState(false);
  const [selectedPerson, setSelectedPerson] = useState(null);
  const searchTimer = useRef(null);

  const onQueryChange = (val) => {
    setQuery(val);
    setSelectedPerson(null);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (val.trim().length < 3) { setSuggestions([]); setShowDrop(false); return; }
    searchTimer.current = setTimeout(async () => {
      const res = await orgSearchPeople({ query: val.trim() });
      setSuggestions(res?.ok ? (res.people || []) : []);
      setShowDrop(true);
    }, 250);
  };

  const pickSuggestion = (person) => {
    setSelectedPerson(person);
    setQuery(person.displayName);
    setShowDrop(false);
  };

  // ── Customer account team ────────────────────────────────────────────────────
  const { data: customerRows } = useDbQuery(
    "SELECT tpid, name, parenting_level, parent_crm_account_id FROM active_customers WHERE tpid IS NOT NULL AND tpid <> ''",
  );
  const accountOptions = useMemo(() => {
    const byTpid = new Map();
    for (const row of customerRows || []) {
      if (!byTpid.has(row.tpid)) byTpid.set(row.tpid, []);
      byTpid.get(row.tpid).push(row);
    }
    return Array.from(byTpid.entries())
      .map(([tpid, accounts]) => {
        // Match the Customers page: the group is represented by its "top parent"
        // account (parenting_level 861980000 → no parent → first), not the shortest name.
        const topParent = accounts.find((a) => a.parenting_level === 861980000)
          || accounts.find((a) => !a.parent_crm_account_id)
          || accounts[0];
        return { tpid, name: topParent.name };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [customerRows]);
  const [selectedTpid, setSelectedTpid] = useState('');
  const [customerMembers, setCustomerMembers] = useState(null);
  const [customerRelationships, setCustomerRelationships] = useState(null);
  const [relationshipError, setRelationshipError] = useState('');
  const [selectedContactId, setSelectedContactId] = useState(''); // opened customer contact

  const loadCustomerTeam = useCallback(async (tpid) => {
    if (!tpid) return;
    setLoading(true); setError(''); setRelationshipError('');
    setCustomerMembers(null); setCustomerRelationships(null); setSelectedContactId('');
    try {
      const [teamResult, relationshipResult] = await Promise.all([
        orgCustomerTeam({ tpid }),
        orgCustomerRelationships({ tpid }),
      ]);
      if (!teamResult?.ok) {
        setError(teamResult?.error || 'Failed to load account team.');
      } else {
        setCustomerMembers(teamResult.members || []);
      }
      if (!relationshipResult?.ok) {
        setRelationshipError(relationshipResult?.error || 'Failed to load customer interaction data.');
      } else {
        setCustomerRelationships(relationshipResult);
      }
    } catch (err) {
      setError(err?.message || String(err));
      setRelationshipError(err?.message || 'Failed to load customer interaction data.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Group resolved members under their manager for a compact tree view.
  const customerGroups = useMemo(() => {
    if (!customerMembers) return [];
    const groups = new Map();
    for (const m of customerMembers) {
      const mgr = m.manager;
      const key = mgr?.id || '__none__';
      if (!groups.has(key)) groups.set(key, { manager: mgr || null, members: [] });
      groups.get(key).members.push(m);
    }
    return Array.from(groups.values())
      .sort((a, b) => (b.members.length - a.members.length));
  }, [customerMembers]);

  // Build a true reporting tree for the map: nest a member under their manager when
  // that manager is ALSO on the account team, so a manager never appears twice.
  // Only managers who are not themselves on the team become muted top-level nodes.
  const customerForest = useMemo(() => {
    if (!customerMembers) return [];
    const memberById = new Map();
    for (const m of customerMembers) {
      if (m.person?.id) memberById.set(m.person.id, m);
    }

    // Split members into on-team-managed (children) and roots (manager off-team / none).
    const childrenOf = new Map(); // manager member id -> child members
    const roots = [];
    for (const m of customerMembers) {
      const mgrId = m.manager?.id;
      if (mgrId && mgrId !== m.person?.id && memberById.has(mgrId)) {
        if (!childrenOf.has(mgrId)) childrenOf.set(mgrId, []);
        childrenOf.get(mgrId).push(m);
      } else {
        roots.push(m);
      }
    }

    // Recursively materialise nodes (visited guard protects against any manager cycle).
    const seen = new Set();
    const buildNode = (m) => {
      const id = m.person?.id;
      if (id) {
        if (seen.has(id)) return { member: m, children: [] };
        seen.add(id);
      }
      const kids = (id ? (childrenOf.get(id) || []) : []).map(buildNode);
      return { member: m, children: kids };
    };

    // Group roots under their external (off-team) manager so shared managers merge.
    const groups = new Map();
    for (const m of roots) {
      const mgr = m.manager;
      const key = mgr?.id || '__none__';
      if (!groups.has(key)) groups.set(key, { manager: mgr || null, nodes: [] });
      groups.get(key).nodes.push(buildNode(m));
    }
    return Array.from(groups.values())
      .sort((a, b) => (b.nodes.length - a.nodes.length));
  }, [customerMembers]);

  // ── Product search (AI over the org map) ─────────────────────────────────────
  const [productDesc, setProductDesc] = useState('');
  const [productBusy, setProductBusy] = useState(false);
  const [productMatches, setProductMatches] = useState(null);
  const [productNote, setProductNote] = useState('');
  const [selectedProductIds, setSelectedProductIds] = useState(() => new Set());

  const runProductSearch = useCallback(async () => {
    if (productDesc.trim().length < 3) return;
    setProductBusy(true); setError(''); setProductMatches(null); setProductNote('');
    setSelectedProductIds(new Set()); resetTree();
    try {
      const res = await orgProductSearch({ description: productDesc.trim() });
      if (!res?.ok) { setError(res?.error || 'Product search failed.'); return; }
      setProductMatches(res.matches || []);
      setProductNote(res.note || '');
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setProductBusy(false);
    }
  }, [productDesc, resetTree]);

  // Selected product people become the roots of the interactive tree.
  const toggleProductPick = (person) => {
    setSelectedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(person.id)) next.delete(person.id); else next.add(person.id);
      return next;
    });
  };

  useEffect(() => {
    if (mode !== 'product') return;
    const chosen = (productMatches || []).filter((p) => selectedProductIds.has(p.id));
    setRoots(chosen);
    setFocusId('');
  }, [mode, productMatches, selectedProductIds]);

  const switchMode = (m) => {
    setMode(m);
    resetTree();
    setError('');
    setInspected(null);
    setSelectedPerson(null); setQuery(''); setSuggestions([]); setShowDrop(false);
    setSelectedTpid(''); setCustomerMembers(null); setSelectedContactId('');
    setProductDesc(''); setProductMatches(null); setProductNote(''); setSelectedProductIds(new Set());
  };

  const showSharedTree = (mode === 'individual' || mode === 'product') && roots.length > 0;
  const showCustomerMap = mode === 'customer' && customerMembers && customerMembers.length > 0;
  const showLayoutToggle = showSharedTree || showCustomerMap;

  return (
    <div>
      <div className="page-header">
        <h2>My Org</h2>
      </div>

      <div className="org-toolbar">
        <Field label="View">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[
              { value: 'customer', label: 'Search by customer account' },
              { value: 'individual', label: 'Search by individual' },
              { value: 'product', label: 'Search by product' },
            ].map((opt) => (
              <Button
                key={opt.value}
                size="small"
                appearance={mode === opt.value ? 'primary' : 'secondary'}
                onClick={() => switchMode(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </Field>

        {showLayoutToggle && (
          <Field label="Layout" style={{ minWidth: 140 }}>
            <Select value={layout} onChange={(_e, d) => setLayout(d.value)}>
              <option value="map">Map</option>
              <option value="list">List</option>
            </Select>
          </Field>
        )}

        {mode === 'individual' && (
          <>
            <Field label="Find a person" className="org-field-grow">
              <div className="org-typeahead">
                <Input
                  value={query}
                  placeholder="Type at least 3 letters of a name…"
                  contentAfter={<PersonRegular />}
                  onChange={(_e, d) => onQueryChange(d.value)}
                  onFocus={() => { if (suggestions.length) setShowDrop(true); }}
                />
                {showDrop && suggestions.length > 0 && (
                  <div className="org-dropdown">
                    {suggestions.map((p) => (
                      <div key={p.id} className="org-dropdown-item" onMouseDown={() => pickSuggestion(p)}>
                        <div className="org-person-name">{p.displayName}</div>
                        <div className="org-person-title">{p.jobTitle || p.mail}</div>
                      </div>
                    ))}
                  </div>
                )}
                {showDrop && query.trim().length >= 3 && suggestions.length === 0 && (
                  <div className="org-dropdown">
                    <div className="org-dropdown-item" style={{ color: 'var(--text-muted)' }}>No matches</div>
                  </div>
                )}
              </div>
            </Field>
            <Button
              appearance="primary"
              disabled={!selectedPerson || loading}
              onClick={() => loadTree(selectedPerson.id)}
            >
              Apply
            </Button>
            <Button
              disabled={loading}
              onClick={() => {
                setSelectedPerson(null); setQuery(''); setSuggestions([]); setShowDrop(false);
                loadTree();
              }}
              title="Go back to your own hierarchy"
            >
              My hierarchy
            </Button>
            <Button
              icon={<ArrowClockwiseRegular />}
              disabled={loading}
              onClick={() => loadTree(selectedPerson?.id, { refresh: true })}
              title="Re-pull this hierarchy live from the directory (bypasses the local cache)"
            >
              Refresh
            </Button>
          </>
        )}

        {mode === 'customer' && (
          <>
            <Field label="Customer account (TPID)" className="org-field-grow">
              <Select value={selectedTpid} onChange={(_e, d) => setSelectedTpid(d.value)}>
                <option value="">Select an account…</option>
                {accountOptions.map((o) => (
                  <option key={o.tpid} value={o.tpid}>{o.name} · {o.tpid}</option>
                ))}
              </Select>
            </Field>
            <Button
              appearance="primary"
              disabled={!selectedTpid || loading}
              onClick={() => loadCustomerTeam(selectedTpid)}
            >
              Apply
            </Button>
          </>
        )}
      </div>

      {/* Honest note when the reporting line could not be walked all the way up. */}
      {mode === 'individual' && managerChain && !managerChain.reachedTop && managers.length > 0 && (
        <div className="flash-message flash-info">
          The reporting line above {roots[0]?.displayName || 'this person'} could not be resolved all the
          way to the top of the org
          {managerChain.stoppedReason === 'unresolved'
            ? " — the directory did not return the next manager. Try Refresh."
            : ` (stopped: ${managerChain.stoppedReason}).`}
        </div>
      )}

      {mode === 'product' && (
        <div style={{ maxWidth: 720, marginBottom: 18 }}>
          <Field label="Describe the product group you need">
            <Textarea
              value={productDesc}
              rows={2}
              placeholder="e.g. Microsoft Fabric & Power BI specialists for a financial-services data platform"
              onChange={(_e, d) => setProductDesc(d.value)}
            />
          </Field>
          <div style={{ marginTop: 10 }}>
            <Button
              appearance="primary"
              icon={productBusy ? <Spinner size="tiny" /> : <SearchRegular />}
              disabled={productBusy || productDesc.trim().length < 3}
              onClick={runProductSearch}
            >
              {productBusy ? 'Searching the directory…' : 'Search'}
            </Button>
          </div>
        </div>
      )}

      {error && <div className="flash-message flash-error">{error}</div>}

      {loading && (
        <div className="org-empty"><Spinner label="Reading the Microsoft directory…" /></div>
      )}

      {/* Person detail drawer (groups + upcoming meetings) — opens on clicking any person. */}
      {inspected && <PersonDetail person={inspected} onClose={() => setInspected(null)} />}

      {/* Product search results → multi-select checklist */}
      {mode === 'product' && productMatches && !loading && (
        <div style={{ marginBottom: 20 }}>
          {productNote && <div className="flash-message flash-info">{productNote}</div>}
          {productMatches.length === 0 && !productNote && (
            <div className="org-empty">No people matched. Try describing the product differently.</div>
          )}
          {productMatches.length > 0 && (
            <div className="card">
              <div className="card-header-custom">
                {productMatches.length} candidate{productMatches.length === 1 ? '' : 's'} — select people to add to the tree
              </div>
              <div className="card-body-custom" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {productMatches.map((p) => (
                  <label key={p.id} className="org-pick-row">
                    <Checkbox
                      checked={selectedProductIds.has(p.id)}
                      onChange={() => toggleProductPick(p)}
                    />
                    <div className="org-person-main">
                      <div className="org-person-name">{p.displayName}</div>
                      <div className="org-person-title">{p.jobTitle}{p.department ? ` · ${p.department}` : ''}</div>
                      {p.reason ? <div className="org-person-sub">{p.reason}</div> : null}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Customer account team → managers with their on-account members */}
      {mode === 'customer' && customerMembers && !loading && (
        customerMembers.length === 0 ? (
          <div className="org-empty">
            No internal Microsoft team members or CRM milestone/opportunity owners were found for this account.
          </div>
        ) : layout === 'map' ? (
          <CustomerOrgMap groups={customerForest} onInspect={setInspected} />
        ) : (
          <div className="org-tree">
            {customerGroups.map((g, idx) => (
              <div key={g.manager?.id || `none-${idx}`} className="org-node">
                {g.manager
                  ? <PersonCard person={g.manager} muted sub={`Manager · ${g.manager.jobTitle || ''}`} onInspect={setInspected} />
                  : <div className="org-chain-item" style={{ paddingLeft: 4 }}>Manager not resolved</div>}
                <div className="org-children">
                  {g.members.map((m) => (
                    <PersonCard
                      key={m.email || m.name}
                      person={m.person || { displayName: m.name }}
                      sub={customerMemberSub(m)}
                      onInspect={m.person?.id ? setInspected : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {mode === 'customer' && !loading && (customerRelationships || relationshipError) && (
        <section className="org-rel-section card">
          <div className="card-header-custom">
            <div>
              <strong>Customer interaction map</strong>
              <div className="org-rel-subtitle">
                How this account&apos;s people are connected to each other, from account-linked
                email, meetings, and Teams — with the Microsoft people behind each contact.
              </div>
            </div>
          </div>
          <div className="card-body-custom">
            {relationshipError ? <div className="alert-error">{relationshipError}</div> : null}
            {!relationshipError && customerRelationships ? (
              <CustomerRelationshipMap
                graph={customerRelationships}
                selectedId={selectedContactId}
                onSelect={(id) => setSelectedContactId((prev) => (prev === id ? '' : id))}
              />
            ) : null}
          </div>
        </section>
      )}

      {mode === 'customer' && !loading && customerRelationships && selectedContactId && (
        <CustomerContactDetail
          graph={customerRelationships}
          contactId={selectedContactId}
          onClose={() => setSelectedContactId('')}
          onSelect={setSelectedContactId}
        />
      )}

      {/* Shared lazy tree (individual / product) */}
      {showSharedTree && !loading && (
        layout === 'map' ? (
          <OrgMap
            roots={roots}
            managers={managers}
            childrenById={childrenById}
            expandedIds={expandedIds}
            loadingIds={loadingIds}
            focusId={focusId}
            onToggle={onToggle}
            onInspect={setInspected}
          />
        ) : (
          <div>
            {managers.length > 0 && (
              <div className="org-chain">
                {managers.map((m) => (
                  <div
                    key={m.id}
                    className="org-chain-item"
                    onClick={() => m.id && setInspected(m)}
                    style={{ cursor: m.id ? 'pointer' : undefined }}
                    title={m.id ? 'View customer contacts & activity' : undefined}
                  >
                    <span className="org-chain-rail">↳</span>
                    <span><strong>{m.displayName}</strong>{m.jobTitle ? ` — ${m.jobTitle}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="org-tree">
              {roots.map((person) => (
                <TreeNode
                  key={person.id}
                  person={person}
                  childrenById={childrenById}
                  expandedIds={expandedIds}
                  loadingIds={loadingIds}
                  focusId={focusId}
                  onToggle={onToggle}
                  onInspect={setInspected}
                />
              ))}
            </div>
          </div>
        )
      )}

      {mode === 'product' && !productMatches && !productBusy && !loading && !error && (
        <div className="org-empty">
          Describe a product or capability area above. An AI agent scoped to the Microsoft
          directory will find matching specialists you can add to the tree.
        </div>
      )}
    </div>
  );
}
