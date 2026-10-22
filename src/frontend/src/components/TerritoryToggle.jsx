import { useTerritory } from '../territoryContext';

// Shared oval toggle that scopes the milestone views (Milestone Map, Milestones table,
// Milestone Timeline). Cycles through three states: All Milestones → My Milestones →
// Discover Mode → (back to All). "Discover Mode" surfaces milestones owned by your configured
// SSPs that you're not already on the deal team of (candidates to join). Reads/writes the
// global territory context so every page stays in sync. Placed in each page's top-right header.
export default function TerritoryToggle() {
  const { scope, cycleScope, currentUserName } = useTerritory();
  const suffix = currentUserName ? ` - ${currentUserName}` : '';
  const label = scope === 'mine'
    ? `Showing My Milestones${suffix}`
    : scope === 'discover'
      ? 'Discover Mode - My SSPs'
      : 'Showing All Milestones';
  const stateClass = scope === 'mine' ? ' my' : scope === 'discover' ? ' discover' : ' all';
  return (
    <button
      type="button"
      className={`territory-toggle${stateClass}`}
      onClick={cycleScope}
      disabled={!currentUserName}
      title={currentUserName
        ? 'Cycle scope: All Milestones → My Milestones → Discover Mode (milestones owned by your configured SSPs that you\u2019re not already on). Affects the Milestone Map, Milestones, and Milestone Timeline.'
        : 'Sync from CRM to enable (your identity is not yet known)'}
    >
      {label}
    </button>
  );
}
