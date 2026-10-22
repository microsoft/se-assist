import {
  HomeRegular, PeopleRegular, FlagRegular, OrganizationRegular,
  TaskListSquareLtrRegular, SettingsRegular, LightbulbRegular, DataTrendingRegular,
  PeopleTeamRegular, AppsListDetailRegular, GanttChartRegular,
  BookRegular, ClipboardTaskListLtrRegular, PeopleSearchRegular, GaugeRegular, DocumentSearchRegular,
  ChartMultipleRegular,
} from '@fluentui/react-icons';

// Single source of truth for the left-hand navigation. Rendered by App.jsx and
// listed (for show/hide customization) by the User Home page. Entries with a
// `section` key are group headers; the rest are navigable tabs. A tab with a
// `parent` is a sub-page: list it directly after that parent tab. The sidebar
// indents it, and the parent gets an arrow that expands or collapses its sub-pages.
export const NAV = [
  { section: 'Workspaces' },
  { path: '/action-center', icon: ClipboardTaskListLtrRegular, label: 'Action Center' },
  { path: '/deep-research', icon: DocumentSearchRegular, label: 'Deep Research', parent: '/action-center' },
  { path: '/', icon: HomeRegular, label: 'Excellence Metrics' },
  { path: '/consumption', icon: DataTrendingRegular, label: 'Azure Consumption' },
  { path: '/powerbi-reports', icon: GaugeRegular, label: 'Model Quotas', parent: '/consumption' },
  { path: '/foundry-deep-dives', icon: ChartMultipleRegular, label: 'Foundry Deep-Dives', parent: '/consumption' },
  { section: 'Explore Data' },
  { path: '/email', icon: PeopleRegular, label: 'Customers' },
  { path: '/milestones', icon: FlagRegular, label: 'Milestones' },
  { path: '/milestone-map', icon: OrganizationRegular, label: 'Milestone Map', parent: '/milestones' },
  { path: '/milestone-timeline', icon: GanttChartRegular, label: 'Milestone Timeline', parent: '/milestones' },
  { path: '/hok-activities', icon: TaskListSquareLtrRegular, label: 'HoK Activities' },
  { path: '/my-org', icon: PeopleTeamRegular, label: 'My Org' },
  { path: '/influence-map', icon: PeopleSearchRegular, label: 'Influence Map' },
  { section: 'Reference' },
  { path: '/settings', icon: SettingsRegular, label: 'User Home' },
  { path: '/products', icon: AppsListDetailRegular, label: 'Microsoft Products' },
  { path: '/accelerators', icon: LightbulbRegular, label: 'Solutions' },
  { path: '/documentation', icon: BookRegular, label: 'Documentation' },
];

// Tabs that can never be hidden. User Home hosts the navigation customizer, so it
// must always remain reachable from the sidebar — otherwise a user who hides it
// would have no way to un-hide anything.
export const LOCKED_PATHS = ['/settings'];

// Pseudo nav key for the persistent "Guided Tour" launcher (below the Guided Setup button).
// It is not a route — it lives only in the hidden-nav preference set so the User Home
// "Customize navigation" panel can hide/show the launcher like any tab.
export const GUIDED_TOUR_NAV_KEY = '#guided-tour';
