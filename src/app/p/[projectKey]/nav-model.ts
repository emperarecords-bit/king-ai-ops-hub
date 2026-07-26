/**
 * The workspace navigation model — the single source of truth for how routes map to the
 * operating cycle (HUB-PRODUCT.md). Both the rail (which domain/destination is active) and the
 * breadcrumb (where am I) derive from this, so "you are here" is answered by the *mental model*,
 * not by exact-URL matching. A nested or detail route inherits its parent domain here rather
 * than being patched page by page.
 */

export interface NavItem {
  slug: string;
  label: string;
}
export interface NavDomain {
  key: string;
  label: string;
  /** Cycle domains are emphasized; supporting domains render quieter. Fixed, never adaptive. */
  primary: boolean;
  items: NavItem[];
}

export const NAV_DOMAINS: NavDomain[] = [
  { key: 'direction', label: 'Direction', primary: true, items: [{ slug: 'objectives', label: 'Objectives' }] },
  {
    key: 'execution',
    label: 'Execution',
    primary: true,
    items: [
      { slug: 'work', label: 'Work' },
      { slug: 'approvals', label: 'Approvals' },
    ],
  },
  {
    key: 'knowledge',
    label: 'Knowledge',
    primary: true,
    items: [
      { slug: 'knowledge', label: 'Knowledge' },
      { slug: 'decisions', label: 'Decisions' },
      { slug: 'documents', label: 'Documents' },
      { slug: 'artifacts', label: 'Artifacts' },
    ],
  },
  {
    // "Team" is the operator-facing label; the underlying domain is broader (people + providers
    // + future AI agents/tools/integrations). Operator language over taxonomic precision.
    key: 'team',
    label: 'Team',
    primary: false,
    items: [
      { slug: 'agents', label: 'Employees' },
      { slug: 'providers', label: 'Providers' },
    ],
  },
  {
    key: 'governance',
    label: 'Governance',
    primary: false,
    items: [
      { slug: 'usage', label: 'Usage' },
      { slug: 'audit', label: 'Audit' },
      { slug: 'settings', label: 'Settings' },
    ],
  },
];

/**
 * Routes that belong to a domain but are not a rail destination. AI tasks are reached through
 * operational work, so a task page lives under Execution even though "Tasks" isn't a rail item.
 * (The child label can evolve when the Tasks-vs-Work model is reviewed.)
 */
const ROUTE_ALIASES: Record<string, { domainKey: string; sectionLabel: string }> = {
  tasks: { domainKey: 'execution', sectionLabel: 'AI work' },
};

export interface NavLocation {
  isLobby: boolean;
  domainKey: string | null;
  domainLabel: string | null;
  /** The rail item to highlight, if the route maps to one. */
  itemSlug: string | null;
  /** Breadcrumb section label (item label, or an alias's section). */
  sectionLabel: string | null;
}

/** Resolve the current location from the path below the `/p/<key>` base (e.g. "/objectives/1"). */
export function resolveLocation(subpath: string): NavLocation {
  const seg = subpath.replace(/^\/+/, '').split('/')[0] ?? '';
  if (seg === '') {
    return { isLobby: true, domainKey: null, domainLabel: null, itemSlug: null, sectionLabel: null };
  }
  for (const d of NAV_DOMAINS) {
    const item = d.items.find((i) => i.slug === seg);
    if (item) {
      return { isLobby: false, domainKey: d.key, domainLabel: d.label, itemSlug: item.slug, sectionLabel: item.label };
    }
  }
  const alias = ROUTE_ALIASES[seg];
  if (alias) {
    const d = NAV_DOMAINS.find((x) => x.key === alias.domainKey);
    return {
      isLobby: false,
      domainKey: alias.domainKey,
      domainLabel: d ? d.label : null,
      itemSlug: null,
      sectionLabel: alias.sectionLabel,
    };
  }
  return { isLobby: false, domainKey: null, domainLabel: null, itemSlug: null, sectionLabel: null };
}
