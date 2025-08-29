// Figma Search and Select Plugin
// Allows searching through layers using a special syntax with symbols:
// # = Page, $ = Section, @ = Frame, ! = Instance, ? = Component, & = Image, % = Shape, = = Text

figma.showUI(__html__, { width: 380, height: 320, themeColors: true });

// Performance optimization: skip invisible instance children for better performance
figma.skipInvisibleInstanceChildren = true;

// Keys for persistent storage
const LAST_QUERY_KEY = 'lastQuery';
let cachedLastQuery: string | null = null;
const lastQueryLoad = (async () => {
  try {
    const v = await figma.clientStorage.getAsync(LAST_QUERY_KEY);
    cachedLastQuery = (typeof v === 'string' && v.length > 0) ? v : null;
  } catch {}
})();

// Global search state flags
let STOP_ON_FIRST = false;  // Stop at first match (--f modifier)
let FOUND_ONE = false;      // Track if a match was found
let SEARCH_CANCELLED = false; // Allow cancelling long searches

// Performance optimization: cache search results for heavy files
const searchCache = new Map<string, SearchResult[]>();
const nodeCache = new Map<string, SceneNode[]>();

// Cooperative yielding to keep UI responsive during heavy searches.
// We explicitly yield inside long loops and large batches to allow the cancel button
// and UI updates to process; the cadence is tighter when flags that include hidden
// content are active because those traversals are much heavier.
const YIELD_INTERVAL = 300; // default yield cadence
function yieldControl(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function getYieldEvery(modifiers?: SearchModifiers): number {
  return (modifiers?.hiddenOnly || modifiers?.allLayers) ? 50 : YIELD_INTERVAL;
}

function getCachedTypePool(
  parent: PageNode | SectionNode | FrameNode | InstanceNode | ComponentNode | ComponentSetNode,
  types: string[],
  fastMode: boolean
): readonly SceneNode[] {
  // Do not cache the heavy "all" traversal pools (flags mode) to avoid memory bloat and slowdowns
  let pool = (parent as any).findAllWithCriteria({ types }) as readonly SceneNode[];
  // In fast mode, prune hidden nodes (including those under hidden ancestors)
  if (fastMode) {
    pool = (pool as SceneNode[]).filter(n => isEffectivelyVisible(n)) as any;
  }
  if (!fastMode) return pool;

  const parentId = (parent as any).id || 'root';
  const key = `${parentId}::${types.join(',')}::fast`;
  const cached = nodeCache.get(key);
  if (cached) return cached as readonly SceneNode[];
  nodeCache.set(key, pool as SceneNode[]);
  if (nodeCache.size > 50) {
    const firstKey = nodeCache.keys().next().value;
    if (firstKey) nodeCache.delete(firstKey);
  }
  return pool;
}

function findMatchingDeep(
  root: ChildrenMixin,
  type: string,
  nameLower: string,
  includeHidden: boolean = false
): readonly SceneNode[] {
  const gate = gateFor(type);
  return (root as any).findAll((n: SceneNode) => {
    if (!includeHidden && !isEffectivelyVisible(n)) return false;
    if (type === 'SHAPE' && gateImage(n)) return false;
    if (type === 'IMAGE' && !gateImage(n)) return false;
    return gate(n) && ((n.name || '').toLowerCase().indexOf(nameLower) !== -1);
  }) as readonly SceneNode[];
}

// Checks effective visibility by walking up ancestors (true only if all are visible)
function isEffectivelyVisible(node: SceneNode): boolean {
  let cur: BaseNode | null = node;
  while (cur && 'visible' in cur) {
    const v = (cur as unknown as { visible: boolean }).visible;
    if (!v) return false;
    cur = cur.parent;
  }
  return true;
}

/**
 * Returns the symbol prefix for a given node type
 * Used for displaying search results and building paths
 */
function symbolFor(n: BaseNode): string {
  if (n.type === 'PAGE') return '#';
  if (n.type === 'SECTION') return '$';
  if (n.type === 'FRAME') return '@';
  if (n.type === 'INSTANCE') return '!';
  if (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') return '?';
  // IMAGE/SHAPE/TEXT are derived, not node types; symbols set when pushing results.
  return '';
}

/**
 * Collects the valid search scope anchors from current selection
 * Returns the selected nodes and their valid ancestors (Page, Section, Frame, Instance)
 * Used for determining where to search when layers are selected
 */
function selectionAnchors(): (PageNode | SectionNode | FrameNode | InstanceNode)[] {
  const sel = figma.currentPage.selection as SceneNode[];
  if (!sel.length) return [figma.currentPage];

  const keep = new Map<string, PageNode|SectionNode|FrameNode|InstanceNode>();
  for (const n of sel) {
    // Add the selected node itself if it's a valid anchor type
    if (n.type === 'SECTION' || n.type === 'FRAME' || n.type === 'INSTANCE') {
      keep.set(n.id, n as any);
    }
    
    // Also add all valid ancestors of this selected node
    let a: BaseNode | null = n;
    while (a && !(
      a.type === 'PAGE' || a.type === 'SECTION' || a.type === 'FRAME' || a.type === 'INSTANCE'
    )) a = a.parent;
    const anchor = (a as any) || figma.currentPage;
    keep.set((anchor as any).id ?? 'page', anchor);
  }
  return Array.from(keep.values());
}

/**
 * Updates the UI to show the current search scope
 * Displays which layers/areas are currently selected for searching
 */
function sendSelectionLabel() {
  const anchors = selectionAnchors();
  const labels = anchors.map(a => `${symbolFor(a)}${a.name}`);
  figma.ui.postMessage({ type: 'selection', label: `Inside: ${labels.join(', ')}` });
}

// Update scope label on plugin load and when selection changes
sendSelectionLabel();
figma.on('selectionchange', sendSelectionLabel);

interface SearchResult {
  node: SceneNode | PageNode | SectionNode;
  path: string;
}

interface SearchModifiers {
  firstMatch: boolean;
  firstMatchEach: boolean;
  hiddenOnly: boolean;
  allLayers: boolean;
  cleanQuery: string;
  // --# (e.g., --3): global index selection across all matches (1-based)
  indexPick?: number | null;
  // --#e (e.g., --3e): per-scope index selection on the final part (1-based)
  indexPickEach?: number | null;
}

/**
 * Parses search modifiers from the query string.
 * Recognized modifiers:
 *  - --f     Stop at the first match overall.
 *  - --fe    Stop at the first match within each scope on the last part.
 *  - --h     Only include hidden nodes on the final part; intermediate parts include both.
 *  - --a     Include both hidden and visible nodes for all parts.
 *  - --#     Global index across all matched layers (e.g. --3 picks the 3rd overall).
 *  - --#e    Per-scope index on the last part (e.g. --2e picks 2nd inside each scope).
 * Returns the modifiers and the cleaned query without modifiers. Modifiers may appear in any order.
 */
function parseModifiers(query: string): SearchModifiers {
  const modifiers = {
    firstMatch: false,      // --f: stop at first match overall
    firstMatchEach: false,  // --fe: stop at first match in each scope
    hiddenOnly: false,      // --h: search only hidden layers
    allLayers: false,       // --a: search both hidden and visible layers
    cleanQuery: query,
    indexPick: null as number | null,
    indexPickEach: null as number | null
  };
  
  let cleanQuery = query.trim();
  
  // Handle --fe as a special case first to avoid regex conflicts
  if (cleanQuery.includes('--fe')) {
    modifiers.firstMatchEach = true;
    cleanQuery = cleanQuery.replace(/\s*--fe\s*/g, '').trim();
  }
  // Extract --#e (numeric) per-scope index for the last part FIRST (so we don't consume the number as --#)
  const idxEachPattern = /--(\d+)e/g;
  let im: RegExpExecArray | null;
  let lastIndexPickEach: number | null = null;
  while ((im = idxEachPattern.exec(cleanQuery)) !== null) {
    const num = parseInt(im[1], 10);
    if (!Number.isNaN(num) && num >= 1) lastIndexPickEach = num;
  }
  if (lastIndexPickEach !== null) modifiers.indexPickEach = lastIndexPickEach;
  // Remove all occurrences of --#e
  cleanQuery = cleanQuery.replace(/\s*--\d+e\s*/g, ' ').trim();

  // Extract --# (numeric) global index (e.g., --3). If multiple, the last wins.
  const idxNumPattern = /--(\d+)/g;
  let lastIndexPick: number | null = null;
  while ((im = idxNumPattern.exec(cleanQuery)) !== null) {
    const num = parseInt(im[1], 10);
    if (!Number.isNaN(num) && num >= 1) lastIndexPick = num;
  }
  if (lastIndexPick !== null) modifiers.indexPick = lastIndexPick;
  // Remove all occurrences of --#
  cleanQuery = cleanQuery.replace(/\s*--\d+\s*/g, ' ').trim();
  
  const modifierPattern = /\s*--([fha])\s*/g;
  let match;
  
  while ((match = modifierPattern.exec(cleanQuery)) !== null) {
    const modifier = match[1];
    switch (modifier) {
      case 'f':
        modifiers.firstMatch = true;
        break;
      case 'h':
        modifiers.hiddenOnly = true;
        break;
      case 'a':
        modifiers.allLayers = true;
        break;
    }
  }
  
  // Remove all remaining modifiers from the query
  cleanQuery = cleanQuery.replace(/\s*--[fha]\s*/g, '').trim();
  
  modifiers.cleanQuery = cleanQuery;
  return modifiers;
}

figma.ui.onmessage = async (msg: { type: string; query?: string }) => {
  if (msg.type === 'search' && msg.query) {
    let originalSkipInvisible = figma.skipInvisibleInstanceChildren;
    try {
      // Persist the last executed query
      try { await figma.clientStorage.setAsync(LAST_QUERY_KEY, msg.query); } catch {}

      // Reset cancel flag
      SEARCH_CANCELLED = false;
      
      // Parse modifiers from the end of the query
      const modifiers = parseModifiers(msg.query);
      // Ensure hidden nodes inside instances are traversed for --h and --a
      const needAllChildren = modifiers.hiddenOnly || modifiers.allLayers;
      if (needAllChildren && figma.skipInvisibleInstanceChildren) {
        figma.skipInvisibleInstanceChildren = false;
      }
      STOP_ON_FIRST = modifiers.firstMatch;
      FOUND_ONE = false;
      const q = modifiers.cleanQuery;

      // Show progress for heavy files
      figma.ui.postMessage({ type: 'searchProgress', message: 'Starting search...' });

      let movedToPage = false;

      // Helper to cleanup state before closing or finishing
      const cleanup = () => {
        try { figma.skipInvisibleInstanceChildren = originalSkipInvisible; } catch {}
        try { searchCache.clear(); } catch {}
        try { nodeCache.clear(); } catch {}
        STOP_ON_FIRST = false;
        FOUND_ONE = false;
        SEARCH_CANCELLED = false;
      };

      // Detect leading "#Page ..." and switch pages first
      const m = q.match(/^\s*#([^/]+)/);
      if (m) {
        const targetName = m[1].trim().toLowerCase();
        const target = figma.root.children.find(
          p => p.type === 'PAGE' && p.name.toLowerCase().indexOf(targetName) !== -1
        );
        if (target) {
          await figma.setCurrentPageAsync(target as PageNode);
          // Don't load page content for page search - it's unnecessary and slow
          movedToPage = true;
        }
      }

      const results = await performSearch(q, movedToPage, modifiers);

      let selectableNodes = results
        .map(r => r.node)
        .filter(node => 'id' in node && node.type !== 'PAGE') as SceneNode[];

      if (!movedToPage) {
        const pageResult = results.find(r => r.node.type === 'PAGE');
        if (pageResult) {
          await figma.setCurrentPageAsync(pageResult.node as PageNode);
          movedToPage = true;
        }
      }

      if (SEARCH_CANCELLED) {
        figma.ui.postMessage({ type: 'searchComplete', count: 0, total: 0, message: 'Search cancelled' });
      } else if (selectableNodes.length > 0) {
        figma.currentPage.selection = selectableNodes;
        figma.viewport.scrollAndZoomIntoView(selectableNodes);
        const msg = movedToPage
          ? `Found page and selected ${selectableNodes.length} ${selectableNodes.length === 1 ? 'layer' : 'layers'}`
          : `Found and selected ${selectableNodes.length} ${selectableNodes.length === 1 ? 'layer' : 'layers'}`;
        cleanup();
        figma.closePlugin(msg);
      } else if (movedToPage) {
        cleanup();
        figma.closePlugin('Found page');
      } else {
        figma.ui.postMessage({ type: 'searchComplete', count: 0, total: 0 });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      figma.ui.postMessage({ type: 'searchComplete', count: 0, total: 0, message: `Error: ${errorMessage}` });
    } finally {
      // If we didn't close the plugin above, ensure cleanup now
      try { figma.skipInvisibleInstanceChildren = originalSkipInvisible; } catch {}
      try { searchCache.clear(); } catch {}
      try { nodeCache.clear(); } catch {}
      STOP_ON_FIRST = false;
      FOUND_ONE = false;
      SEARCH_CANCELLED = false;
    }
  } else if (msg.type === 'cancel') {
    SEARCH_CANCELLED = true;
    figma.ui.postMessage({ type: 'searchComplete', count: 0, total: 0, message: 'Search cancelled' });
  } else if (msg.type === 'clearSelection') {
    // ESC/Clear: if something is selected, deselect; if nothing is selected, close the plugin
    try {
      if ((figma.currentPage.selection as SceneNode[]).length === 0) {
        figma.closePlugin();
      } else {
        figma.currentPage.selection = [];
        figma.ui.postMessage({ type: 'selection', label: 'Inside: #'+figma.currentPage.name });
      }
    } catch {}
  } else if (msg.type === 'updateLastQuery') {
    try {
      await figma.clientStorage.setAsync(LAST_QUERY_KEY, msg.query ?? '');
      cachedLastQuery = msg.query ?? '';
    } catch {}
  } else if (msg.type === 'uiReady') {
    // UI is ready: send back the last saved query (if any)
    if (cachedLastQuery) {
      figma.ui.postMessage({ type: 'initQuery', query: cachedLastQuery });
    } else {
      try {
        await lastQueryLoad;
        if (cachedLastQuery) {
          figma.ui.postMessage({ type: 'initQuery', query: cachedLastQuery });
        }
      } catch {}
    }
  }
};

/**
 * Determines the initial search scope based on current selection
 * @param excludeSelectedLayers - When true (for /@ queries), excludes selected layers from search scope
 * @returns Array of nodes to search within
 */
function getInitialScopes(excludeSelectedLayers: boolean = false): (SceneNode | PageNode | SectionNode)[] {
  const sel = figma.currentPage.selection as SceneNode[];
  if (!sel.length) return [figma.currentPage];

  // Build search scope from selected layers and their ancestors
  const scopes = new Map<string, SceneNode>();
  
  // Add all selected nodes and their valid ancestors
  for (const n of sel) {
    // Always add selected nodes as scope roots; matching is skipped for scope nodes when using child search
    scopes.set(n.id, n);
    
    // For non-child-only searches, also add valid ancestors as additional scopes
    if (!excludeSelectedLayers) {
      let a: BaseNode | null = n;
      while (
        a && !(
          a.type === 'PAGE' ||
          a.type === 'SECTION' ||
          a.type === 'FRAME' ||
          a.type === 'INSTANCE' ||
          a.type === 'COMPONENT' ||
          a.type === 'COMPONENT_SET'
        )
      ) a = a.parent;
      if (a && a.type !== 'PAGE') scopes.set((a as SceneNode).id, a as SceneNode);
    }
  }
  
  const out = Array.from(scopes.values());
  
  // Return all scopes (no artificial limit to ensure all selected layers are searched)
  return out.length ? out : [figma.currentPage];
}

/**
 * Checks if a node's name matches the search query
 * Performs case-insensitive substring matching
 * @param n - The node to check
 * @param q - The search query
 * @returns true if the node name contains the query (or if query is empty)
 */
function matchesName(n: SceneNode, q: string): boolean {
  const nm = (n.name || '').toLowerCase();
  const qq = q.toLowerCase();
  return qq ? nm.indexOf(qq) !== -1 : true; // Empty query matches everything
}

// Type filtering functions - determine if a node matches a specific search type
const gateSection = (n: SceneNode) => n.type === 'SECTION';
const gateFrame   = (n: SceneNode) => n.type === 'FRAME' || n.type === 'GROUP';
const gateInst    = (n: SceneNode) => n.type === 'INSTANCE';
const gateComp    = (n: SceneNode) => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET';
const gateShape   = (n: SceneNode) => (
  n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || n.type === 'POLYGON' ||
  n.type === 'STAR' || n.type === 'LINE' || n.type === 'VECTOR'
);
const gateImage   = (n: SceneNode) => {
  const anyFill = (x:any)=> Array.isArray(x) && x.some((f:any)=>f?.type === 'IMAGE');
  return ('fills' in n && anyFill((n as any).fills));
};
const gateText    = (n: SceneNode) => n.type === 'TEXT';

/**
 * Returns the appropriate type filter function based on search type
 * @param type - The search type (SECTION, FRAME, INSTANCE, etc.)
 * @returns A function that filters nodes by the specified type
 */
function gateFor(type: string): (n: SceneNode)=>boolean {
  if (type === 'SECTION')   return gateSection;
  if (type === 'FRAME')     return gateFrame;
  if (type === 'INSTANCE')  return gateInst;
  if (type === 'COMPONENT') return gateComp;
  if (type === 'SHAPE')     return gateShape;
  if (type === 'IMAGE')     return gateImage;
  if (type === 'TEXT')      return gateText;
  return () => true; // ANY - matches all node types
}

/**
 * Iteratively walks through a node tree with batch processing for performance
 * Handles visibility filtering based on search modifiers
 * @param root - The root node to start walking from
 * @param step - Function called for each node, returns true to continue descending
 * @param modifiers - Search modifiers that affect visibility filtering
 * @param isFinalPart - Whether this is the final part of the search query (for --h modifier)
 */
async function walk(root: ChildrenMixin, step:(n:SceneNode)=>boolean, modifiers?: SearchModifiers, isFinalPart: boolean = false) {
  const stack: SceneNode[] = 'children' in root ? Array.from(root.children as readonly SceneNode[]) : [];
  const batchSize = (modifiers?.hiddenOnly || modifiers?.allLayers) ? 400 : 2000; // smaller batches in heavy mode
  
  while (stack.length) {
    if (STOP_ON_FIRST && FOUND_ONE) break;
    if (SEARCH_CANCELLED) break;
    
    // Process in batches for heavy files
    const batch = stack.splice(0, Math.min(batchSize, stack.length));
    
    for (let i = 0; i < batch.length; i++) {
      const n = batch[i];
      if (STOP_ON_FIRST && FOUND_ONE) break;
      if (SEARCH_CANCELLED) break;
      
      // Apply visibility filters based on search modifiers
      if (modifiers?.allLayers) {
        // Include all nodes regardless of visibility (--a)
      } else if (!modifiers?.hiddenOnly && !n.visible) {
        // Skip hidden nodes by default (unless --h or --a is specified)
        continue;
      }
      // Note: --h constraint is applied later when checking if a node matches
      
      const descend = step(n);
      if (descend && 'children' in n) {
        stack.push(...Array.from(n.children as readonly SceneNode[]));
      }

      // Periodically yield to allow UI events (cancel button) to process
      const yieldEvery = getYieldEvery(modifiers);
      if (i % yieldEvery === 0) {
        // eslint-disable-next-line no-await-in-loop
        await yieldControl();
        if (SEARCH_CANCELLED) break;
      }
    }
    
    // Yield control periodically to prevent UI blocking
    if (stack.length > batchSize) {
      // Small delay to prevent blocking
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}

/**
 * Main search function that processes multi-part queries
 * Handles nested searches (e.g., "@Frame/!Instance") and applies search modifiers
 * @param query - The search query (may contain modifiers like --f, --h, etc.)
 * @param movedToPage - Whether we've already switched to a target page
 * @param modifiers - Parsed search modifiers
 * @returns Array of search results with node and path information
 */
async function performSearch(query: string, movedToPage: boolean = false, modifiers?: SearchModifiers): Promise<SearchResult[]> {
  // Visual order comparator used by --fe/--#e and by global --#.
  // It prioritizes visible positioning over paint/z-order:
  //  - If both nodes share an Auto Layout ancestor, use that ancestor's axis
  //    (VERTICAL => absolute Y ascending; HORIZONTAL => absolute X ascending).
  //  - Otherwise fall back to absolute Y, then absolute X ascending.
  //  - Final tie-breaker: paint order (frontmost-first) at the nearest common ancestor.
  const getAbsXY = (n: SceneNode): { ax: number; ay: number } => {
    const m = ((n as any).absoluteTransform || [[1,0,0],[0,1,0]]) as [[number,number,number],[number,number,number]];
    return { ax: m[0][2], ay: m[1][2] };
  };
  const getSize = (n: SceneNode): { w: number; h: number } => {
    const w = ("width" in (n as any)) ? (n as any).width as number : 0;
    const h = ("height" in (n as any)) ? (n as any).height as number : 0;
    return { w: (isFinite(w) ? w : 0), h: (isFinite(h) ? h : 0) };
  };
  const buildRowComparator = (nodes: SceneNode[]): ((a: SceneNode, b: SceneNode) => number) => {
    const heights: number[] = nodes.map(n => getSize(n).h || 0);
    const avgH = heights.length ? (heights.reduce((s, v) => s + v, 0) / heights.length) : 0;
    const rowEps = Math.max(8, Math.round(0.35 * (avgH || 24)));
    const sameRow = (a: SceneNode, b: SceneNode): boolean => {
      const { ay: yA } = getAbsXY(a);
      const { ay: yB } = getAbsXY(b);
      const hA = getSize(a).h || avgH || 24;
      const hB = getSize(b).h || avgH || 24;
      const cA = yA + hA / 2;
      const cB = yB + hB / 2;
      return Math.abs(cA - cB) <= rowEps;
    };
    return (a: SceneNode, b: SceneNode): number => {
      if (a === b) return 0;
      const { ax: xA, ay: yA } = getAbsXY(a);
      const { ax: xB, ay: yB } = getAbsXY(b);
      if (sameRow(a, b)) {
        if (Math.abs(xA - xB) > 0.5) return xA - xB; // left-to-right within row
        // tie-breaker: z-order via nearest common ancestor
        const lca = nearestCommonAncestor(a, b);
        if (lca && 'children' in lca) {
          const kids = (lca.children as readonly BaseNode[]);
          return kids.indexOf(b) - kids.indexOf(a);
        }
        return 0;
      }
      // Different rows: top rows first by minY
      if (Math.abs(yA - yB) > 0.5) return yA - yB;
      // If extremely close, fall back to x
      if (Math.abs(xA - xB) > 0.5) return xA - xB;
      return 0;
    };
  };
  const buildAncestorList = (n: BaseNode): any[] => {
    const list: any[] = [];
    let cur: any = n;
    while (cur) {
      list.unshift(cur);
      cur = cur.parent || null;
      if (!cur || !('children' in cur)) break;
    }
    return list;
  };
  const nearestCommonAutoLayout = (a: SceneNode, b: SceneNode): { parent: any; mode: 'VERTICAL'|'HORIZONTAL'|null } | null => {
    const aa = buildAncestorList(a);
    const mm = new Map<string, 'VERTICAL'|'HORIZONTAL'>();
    for (const x of aa) {
      const lm = (typeof x?.layoutMode === 'string') ? x.layoutMode : 'NONE';
      if (lm === 'VERTICAL' || lm === 'HORIZONTAL') mm.set(x.id || String(x), lm);
    }
    const bb = buildAncestorList(b);
    for (const y of bb) {
      const lm = (typeof y?.layoutMode === 'string') ? y.layoutMode : 'NONE';
      if ((lm === 'VERTICAL' || lm === 'HORIZONTAL') && mm.has(y.id || String(y))) {
        return { parent: y, mode: lm };
      }
    }
    return null;
  };
  const nearestCommonAncestor = (a: SceneNode, b: SceneNode): any | null => {
    const aa = buildAncestorList(a);
    const set = new Set(aa);
    const bb = buildAncestorList(b);
    for (const y of bb) {
      if (set.has(y)) return y;
    }
    return null;
  };
  const depthFrom = (scope: any, node: SceneNode): number => {
    let depth = 0;
    let cur: any = node;
    while (cur && cur !== scope) {
      cur = cur.parent;
      if (!cur) break;
      depth++;
    }
    return depth;
  };
  const compareWithinScope = (scope: any, a: SceneNode, b: SceneNode): number => {
    const scopeMode = (typeof scope?.layoutMode === 'string') ? scope.layoutMode : 'NONE';
    if (scopeMode === 'VERTICAL' || scopeMode === 'HORIZONTAL') {
      // 1) Prioritize visual axis ordering when the last scope is Auto Layout
      const pa: any = (a as any).parent;
      const pb: any = (b as any).parent;
      const ma = (typeof pa?.layoutMode === 'string') ? pa.layoutMode : 'NONE';
      const mb = (typeof pb?.layoutMode === 'string') ? pb.layoutMode : 'NONE';
      const { ax: axA, ay: ayA } = getAbsXY(a);
      const { ax: axB, ay: ayB } = getAbsXY(b);
      // Combined top-left score for axis priority
      const sA = axA + ayA;
      const sB = axB + ayB;
      const ds = sA - sB;
      if (Math.abs(ds) > 0.5) return ds;
      // 2) If axis order ties, prefer direct children (shallower depth from the specified scope)
      const da = depthFrom(scope, a);
      const db = depthFrom(scope, b);
      if (da !== db) return da - db;
      // 3) Fall back to z-order: nearest common ancestor paint order (frontmost-first)
      const lca = nearestCommonAncestor(a, b);
      if (lca && 'children' in lca) {
        const path = (root: any, node: any): number[] => {
          const p: number[] = [];
          let cur: any = node;
          while (cur && cur !== root) {
            const par: any = cur.parent;
            if (!par || !('children' in par)) break;
            const idx = (par.children as readonly BaseNode[]).indexOf(cur);
            p.unshift(idx);
            cur = par;
          }
          return p;
        };
        const paIdx = path(lca, a);
        const pbIdx = path(lca, b);
        const len = Math.max(paIdx.length, pbIdx.length);
        for (let i = 0; i < len; i++) {
          const aHas = i < paIdx.length;
          const bHas = i < pbIdx.length;
          if (!aHas && bHas) return -1;
          if (aHas && !bHas) return 1;
          if (aHas && bHas) {
            if (paIdx[i] !== pbIdx[i]) return pbIdx[i] - paIdx[i];
          }
        }
      }
      return 0;
    }
    // If scope is not Auto Layout, defer to general visual comparator
    return compareVisual(a, b);
  };

  const compareZFirstWithinScope = (scope: any, a: SceneNode, b: SceneNode): number => {
    // 1) Paint order relative to nearest common ancestor (frontmost-first)
    const lca = nearestCommonAncestor(a, b);
    if (lca && 'children' in lca) {
      const path = (root: any, node: any): number[] => {
        const p: number[] = [];
        let cur: any = node;
        while (cur && cur !== root) {
          const par: any = cur.parent;
          if (!par || !('children' in par)) break;
          const idx = (par.children as readonly BaseNode[]).indexOf(cur);
          p.unshift(idx);
          cur = par;
        }
        return p;
      };
      const paIdx = path(lca, a);
      const pbIdx = path(lca, b);
      const len = Math.max(paIdx.length, pbIdx.length);
      for (let i = 0; i < len; i++) {
        const aHas = i < paIdx.length;
        const bHas = i < pbIdx.length;
        if (!aHas && bHas) return -1; // shallower first
        if (aHas && !bHas) return 1;  // deeper later
        if (aHas && bHas) {
          if (paIdx[i] !== pbIdx[i]) return pbIdx[i] - paIdx[i]; // frontmost-first
        }
      }
    }
    // 2) Fallback to absolute XY (top-left-first) when z-order is identical/ambiguous
    const { ax: axA, ay: ayA } = getAbsXY(a);
    const { ax: axB, ay: ayB } = getAbsXY(b);
    const sA = axA + ayA;
    const sB = axB + ayB;
    const ds = sA - sB; if (Math.abs(ds) > 0.5) return ds;
    return 0;
  };
  const compareVisual = (a: SceneNode, b: SceneNode): number => {
    if (a === b) return 0;
    const pa: any = (a as any).parent;
    const pb: any = (b as any).parent;

    // Prefer immediate-parent rules
    if (pa && pa === pb && 'children' in pa) {
      const mode = (typeof pa.layoutMode === 'string') ? pa.layoutMode : 'NONE';
      const kids = pa.children as readonly BaseNode[];
      if (mode === 'VERTICAL' || mode === 'HORIZONTAL') {
        const { ax: axA, ay: ayA } = getAbsXY(a);
        const { ax: axB, ay: ayB } = getAbsXY(b);
        const sA = axA + ayA;
        const sB = axB + ayB;
        const ds = sA - sB;
        if (Math.abs(ds) > 0.5) return ds; // top-left (smaller x+y) first
        // tie-breaker within same parent by paint order (frontmost-first)
        return kids.indexOf(b) - kids.indexOf(a);
      }
      // Same non-Auto Layout parent → paint order decides (frontmost-first)
      return kids.indexOf(b) - kids.indexOf(a);
    }

    // Different parents: if immediate parents use Auto Layout (one or both), use visual axis ordering
    const modeA = (typeof pa?.layoutMode === 'string') ? pa.layoutMode : 'NONE';
    const modeB = (typeof pb?.layoutMode === 'string') ? pb.layoutMode : 'NONE';
    const axisMode = modeA !== 'NONE' ? modeA : (modeB !== 'NONE' ? modeB : 'NONE');
    if (axisMode !== 'NONE') {
      const { ax: axA, ay: ayA } = getAbsXY(a);
      const { ax: axB, ay: ayB } = getAbsXY(b);
      const sA = axA + ayA;
      const sB = axB + ayB;
      const ds = sA - sB;
      if (Math.abs(ds) > 0.5) return ds; // top-left first
      // fall through to LCA paint order tie-breaker
    }

    // Different parents without both using Auto Layout: use nearest common ancestor paint order when possible
    const lca = nearestCommonAncestor(a, b);
    if (lca && 'children' in lca) {
      const indexPathFrom = (root: any, node: any): number[] => {
        const path: number[] = [];
        let cur: any = node;
        while (cur && cur !== root) {
          const par: any = cur.parent;
          if (!par || !('children' in par)) break;
          const idx = (par.children as readonly BaseNode[]).indexOf(cur);
          path.unshift(idx);
          cur = par;
        }
        return path;
      };
      const paIdx = indexPathFrom(lca, a);
      const pbIdx = indexPathFrom(lca, b);
      const maxLen = Math.max(paIdx.length, pbIdx.length);
      for (let i = 0; i < maxLen; i++) {
        const aHas = i < paIdx.length;
        const bHas = i < pbIdx.length;
        if (!aHas && bHas) return -1; // shallower first
        if (aHas && !bHas) return 1;  // deeper later
        if (aHas && bHas) {
          if (paIdx[i] !== pbIdx[i]) return pbIdx[i] - paIdx[i]; // frontmost-first at branch
        }
      }
    }

    // Final fallback: absolute position
    const { ax: axA, ay: ayA } = getAbsXY(a);
    const { ax: axB, ay: ayB } = getAbsXY(b);
    const dy = ayA - ayB; if (Math.abs(dy) > 0.5) return dy;
    const dx = axA - axB; if (Math.abs(dx) > 0.5) return dx;
    return 0;
  };
  // Parse query parts, handling // as a special separator for direct children
  const parts: { part: string; isDirectChild: boolean }[] = [];
  const segments = query.split('/');
  
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i].trim();
    if (segment.length === 0) continue;
    
    // Check if this segment is followed by an empty segment (indicating //)
    const isDirectChild = i < segments.length - 1 && segments[i + 1].trim().length === 0;
    
    parts.push({ part: segment, isDirectChild });
    
    // Skip the next empty segment if this is a direct child search
    if (isDirectChild) {
      i++;
    }
  }

  // If the query ends with // or /, add an implicit ANY part to search children with or without direct restriction
  const trimmedQuery = query.trim();
  const endsWithDirect = /\/\/\s*$/.test(trimmedQuery);
  const endsWithNested = !endsWithDirect && /\/\s*$/.test(trimmedQuery);
  if (endsWithDirect || endsWithNested) {
    parts.push({ part: '', isDirectChild: endsWithDirect });
  }

  // If the query starts with //, mark the first real part as direct-child
  if (/^\s*\/{2}/.test(trimmedQuery) && parts.length > 0) {
    parts[0].isDirectChild = true;
  }

  // Propagate the direct-child indicator to the following part (so it applies to the child search term)
  for (let i = parts.length - 2; i >= 0; i--) {
    if (parts[i].isDirectChild) {
      parts[i + 1].isDirectChild = true;
      parts[i].isDirectChild = false;
    }
  }
  
  if (!parts.length) return [];

  // Check cache first for performance on heavy files
  const isFastMode = !(modifiers?.hiddenOnly || modifiers?.allLayers);
  const cacheKey = isFastMode ? `${figma.currentPage.id}:${query}` : `FLAGS-NO-CACHE`;
  if (isFastMode && searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey)!;
  }

  // Fast path for simple page searches (e.g., "#PageName")
  if (query.trim().startsWith('#') && !query.includes('/')) {
    const pageName = query.trim().substring(1).toLowerCase();
    const target = figma.root.children.find(p => 
      p.type === 'PAGE' && p.name.toLowerCase().indexOf(pageName) !== -1
    );
    if (target) {
      const result = [{ node: target, path: `#${target.name}` }];
      searchCache.set(cacheKey, result);
      return result;
    } else {
      searchCache.set(cacheKey, []);
      return [];
    }
  }

  let results: SearchResult[] = [];
  let currentScope: (SceneNode | PageNode | SectionNode)[] = [];

  for (let i = 0; i < parts.length; i++) {
    if (SEARCH_CANCELLED) break;
    
    const partInfo = parts[i];
    const part = partInfo.part;
    const isDirectChild = partInfo.isDirectChild;
    const isLastPart = i === parts.length - 1;
    const stopThisPart = modifiers?.firstMatch || false; // --f: stop at first match overall
    const stopThisPartEach = modifiers?.firstMatchEach && !modifiers?.firstMatch && isLastPart || false; // --fe: only apply to last part
    const rawPart = part;
    const isRoot = i === 0;

    const searchType = getSearchType(rawPart);
    const searchName = getSearchName(rawPart);

    FOUND_ONE = false;

    if (isRoot) {
      if (searchType === 'PAGE') {
        // Page search should have been handled by the fast path above
        // This is just a fallback for complex queries
        const nameLower = searchName.toLowerCase();
        const target = figma.root.children.find(p => p.name.toLowerCase().indexOf(nameLower) !== -1);
        if (!target) { results = []; currentScope = []; break; }
        results = [{ node: target, path: `#${target.name}` }];
        currentScope = [target];
      } else {
        // Determine if this is a child-only search (starts with /)
        const isChildSearch = query.trim().startsWith('/');
        const scopes = getInitialScopes(isChildSearch);
        const rootResults: SearchResult[] = [];

        const fastMode = !(modifiers?.hiddenOnly || modifiers?.allLayers);
        // Special global-selection indexed pick: when selection contains leaf nodes that match the query,
        // pick Nth across the selection regardless of parent scopes.
        const selected = (figma.currentPage.selection as SceneNode[]) || [];
        const indexToPickGlobal = (modifiers?.indexPick ?? null);
        if (isLastPart && !modifiers?.firstMatch && !isChildSearch && indexToPickGlobal) {
          const gate = gateFor(searchType);
          const qLower = searchName.toLowerCase();
          const selMatches = selected.filter(ch => {
            // consider only leaf-like or directly matched nodes; visibility flags apply
            if (!gate(ch)) return false;
            if (((ch.name || '').toLowerCase().indexOf(qLower)) === -1) return false;
            if (modifiers?.hiddenOnly && ch.visible) return false;
            if (!modifiers?.allLayers && !modifiers?.hiddenOnly && !ch.visible) return false;
            return true;
          });
          if (selMatches.length > 0) {
            const sortedSel = selMatches.slice().sort(buildRowComparator(selMatches));
            const pick = sortedSel[Math.max(0, indexToPickGlobal - 1)] || null;
            if (pick) {
              const sym = pick.type === 'SECTION' ? '$'
                : (pick.type === 'FRAME' || pick.type === 'GROUP') ? '@'
                : pick.type === 'INSTANCE' ? '!'
                : pick.type === 'TEXT' ? '='
                : (pick.type === 'COMPONENT' || pick.type === 'COMPONENT_SET') ? '?'
                : searchType === 'IMAGE' ? '&'
                : searchType === 'SHAPE' ? '%' : '';
              rootResults.push({ node: pick, path: getNodePath(pick) });
              results = rootResults;
              currentScope = rootResults.map(r => r.node);
              // Skip normal per-scope processing; we already produced the indexed selection
              return results;
            }
          }
        }

        for (const s of scopes) {
          if (SEARCH_CANCELLED) break;
          
          // Per-scope pick for --fe (first in each scope) or --#e (Nth in each scope) on the last part.
          if (isLastPart && !modifiers?.firstMatch && (modifiers?.firstMatchEach || (modifiers?.indexPickEach ?? null))) {
            const gate = gateFor(searchType);
            const qLower = searchName.toLowerCase();
            const indexToPick = (modifiers?.indexPickEach ?? 1);

            const matches: SceneNode[] = [];
            // Consider the scope node itself if it matches and allowed by flags
            if (!isChildSearch) {
              const scopeMatches = s.type !== 'PAGE' && gate(s as SceneNode) && ((s.name || '').toLowerCase().indexOf(qLower) !== -1);
              if (scopeMatches) {
                const isVisible = (s as SceneNode).visible;
                let includeScope = true;
                if (modifiers?.hiddenOnly) includeScope = !isVisible;
                else if (!modifiers?.allLayers) includeScope = isVisible;
                if (includeScope) matches.push(s as SceneNode);
              }
            }

            if ('children' in s && s.children && s.children.length > 0) {
              if (isDirectChild) {
                const children = (s as any).children as readonly SceneNode[];
                for (const ch of children) {
                  if (SEARCH_CANCELLED) break;
                  if (!modifiers?.allLayers && !modifiers?.hiddenOnly && !ch.visible) continue;
                  if (searchType === 'SHAPE' && gateImage(ch)) continue;
                  if (searchType === 'IMAGE' && !gateImage(ch)) continue;
                  if (!gate(ch)) continue;
                  if (((ch.name || '').toLowerCase().indexOf(qLower)) === -1) continue;
                  if (modifiers?.hiddenOnly && ch.visible) continue;
                  matches.push(ch);
                }
              } else {
                if (searchType === 'SECTION' || searchType === 'FRAME' || searchType === 'INSTANCE' || searchType === 'COMPONENT') {
                  const types =
                    searchType === 'SECTION'   ? ['SECTION'] :
                    searchType === 'FRAME'     ? ['FRAME','GROUP'] :
                    searchType === 'INSTANCE'  ? ['INSTANCE'] :
                                                 ['COMPONENT','COMPONENT_SET'];
                  const pool = getCachedTypePool(s as any, types, fastMode);
                  for (const n of pool) {
                    if (SEARCH_CANCELLED) break;
                    if (fastMode && !n.visible) continue;
                    if (((n.name || '').toLowerCase().indexOf(qLower)) === -1) continue;
                    let include = true;
                    if (!fastMode) {
                      const isVisible = n.visible;
                      if (modifiers?.hiddenOnly) include = !isVisible;
                      else if (modifiers?.allLayers) include = true;
                      else include = isVisible;
                    }
                    if (include) matches.push(n);
                  }
                } else {
                  const fast = !(modifiers?.hiddenOnly || modifiers?.allLayers);
                  const pool = (s as any).findAll((n: SceneNode) => {
                    if (fast && !n.visible) return false;
                    if (searchType === 'SHAPE' && gateImage(n)) return false;
                    if (searchType === 'IMAGE' && !gateImage(n)) return false;
                    if (!gate(n)) return false;
                    if (((n.name || '').toLowerCase().indexOf(qLower) === -1)) return false;
                    if (modifiers?.hiddenOnly && n.visible) return false;
                    return true;
                  }) as SceneNode[];
                  matches.push(...pool);
                }
              }
            }

            if (matches.length) {
              const sorted = matches.slice().sort(compareVisual);
              const pick = sorted[indexToPick - 1] || null;
              if (pick) {
                const sym = pick.type === 'SECTION' ? '$'
                  : (pick.type === 'FRAME' || pick.type === 'GROUP') ? '@'
                  : pick.type === 'INSTANCE' ? '!'
                  : pick.type === 'TEXT' ? '='
                  : (pick.type === 'COMPONENT' || pick.type === 'COMPONENT_SET') ? '?'
                  : searchType === 'IMAGE' ? '&'
                  : searchType === 'SHAPE' ? '%' : '';
                rootResults.push({ node: pick, path: `${getNodePath(s)}/${sym}${pick.name}` });
                FOUND_ONE = true;
              }
            }
            // Done with per-scope first pick; continue to next scope
            continue;
          }

          // Check if scope node itself matches (only for non-child searches)
          if (!isChildSearch) {
            const scopeMatches = s.type !== 'PAGE' && matchesName(s as SceneNode, searchName) && gateFor(searchType)(s as SceneNode);
            if (scopeMatches) {
              // Fast path: without flags, only include visible nodes
              let shouldInclude = false;
              const isVisible = (s as SceneNode).visible;
              if (fastMode) {
                shouldInclude = isVisible;
              } else if (isLastPart) {
                if (modifiers?.hiddenOnly) {
                  shouldInclude = !isVisible;
                } else if (modifiers?.allLayers) {
                  shouldInclude = true;
                }
              } else {
                // Intermediate steps with flags include both hidden and visible
                shouldInclude = true;
              }
              
              if (shouldInclude) {
                const sym = s.type === 'SECTION' ? '$'
                  : (s.type === 'FRAME' || s.type === 'GROUP') ? '@'
                  : s.type === 'INSTANCE' ? '!' 
                  : (s.type === 'COMPONENT' || s.type === 'COMPONENT_SET') ? '?'
                  : searchType === 'IMAGE' ? '&'
                  : searchType === 'SHAPE' ? '%' : '';
                rootResults.push({ node: s, path: getNodePath(s) });
                FOUND_ONE = true;
                if (stopThisPart) continue;
                if (stopThisPartEach) continue; // Stop searching this scope, but continue with other scopes
              }
            }
          }
          
          // If this scope has children, search within it
          if ('children' in s && s.children && s.children.length > 0) {
            // If this part requested direct-children only, delegate to child search with isDirectChild=true
            if (isDirectChild) {
              const kidsDirect = await searchChildren(
                s as any,
                searchType,
                searchName,
                stopThisPart || stopThisPartEach,
                modifiers,
                true,
                isLastPart
              );
              rootResults.push(...kidsDirect);
              if ((stopThisPart || stopThisPartEach) && FOUND_ONE) break;
              // Continue to next scope; skip deep scans when direct-only
              continue;
            }
            if (searchType === 'SECTION' || searchType === 'FRAME' || searchType === 'INSTANCE' || searchType === 'COMPONENT') {
              const types =
                searchType === 'SECTION'   ? ['SECTION'] :
                searchType === 'FRAME'     ? ['FRAME','GROUP'] :
                searchType === 'INSTANCE'  ? ['INSTANCE'] :
                                             ['COMPONENT','COMPONENT_SET'];

              // Use cached/uncached pool depending on mode
              const pool = getCachedTypePool(s as any, types, fastMode);

              const q = searchName.toLowerCase();
              const yieldEveryPool = getYieldEvery(modifiers);
              for (let idx = 0; idx < pool.length; idx++) {
                const n = pool[idx];
                if (SEARCH_CANCELLED) break;
                if (fastMode && !n.visible) continue;
                if ((n.name || '').toLowerCase().indexOf(q) !== -1) {
                  // Determine inclusion based on visibility and flags
                  let shouldInclude = true;
                  if (!fastMode) {
                    const isVisible = n.visible;
                    if (isLastPart) {
                      if (modifiers?.hiddenOnly) shouldInclude = !isVisible;
                      else if (modifiers?.allLayers) shouldInclude = true;
                      else shouldInclude = isVisible;
                    } else {
                      shouldInclude = true; // include both hidden and visible for intermediate steps with flags
                    }
                  }
                  
                  if (shouldInclude) {
                    const sym = n.type === 'SECTION' ? '$'
                      : (n.type === 'FRAME' || n.type === 'GROUP') ? '@'
                      : n.type === 'INSTANCE' ? '!'
                      : n.type === 'TEXT' ? '='
                      : (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') ? '?' : '';
                    rootResults.push({ node: n, path: `${getNodePath(s)}/${sym}${n.name}` });
                    FOUND_ONE = true;
                    if (stopThisPart) break;
                    if (stopThisPartEach) break; // Stop searching this scope for --fe
                  }
                }
                if (idx % yieldEveryPool === 0) {
                  // eslint-disable-next-line no-await-in-loop
                  await yieldControl();
                  if (SEARCH_CANCELLED) break;
                }
              }
            } else {
              if (fastMode) {
                // Use the built-in fast deep finder in fast mode
                const pool = findMatchingDeep(s as any, searchType, searchName.toLowerCase(), !!(modifiers?.hiddenOnly || modifiers?.allLayers));
                const yieldEveryDeep = getYieldEvery(modifiers);
                for (let idx = 0; idx < pool.length; idx++) {
                  const n = pool[idx];
                  if (SEARCH_CANCELLED) break;
                  if (!modifiers?.allLayers && !modifiers?.hiddenOnly && !isEffectivelyVisible(n)) continue;
                  const sym =
                    searchType === 'IMAGE' ? '&' :
                    searchType === 'SHAPE' ? '%' :
                    n.type === 'SECTION' ? '$' :
                    n.type === 'FRAME'   ? '@' :
                    n.type === 'INSTANCE'? '!' :
                    (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') ? '?' : '';
                  rootResults.push({ node: n, path: `${getNodePath(s)}/${sym}${n.name}` });
                  FOUND_ONE = true;
                  if (stopThisPart) break;
                  if (stopThisPartEach) break;
                  if (idx % yieldEveryDeep === 0) {
                    // eslint-disable-next-line no-await-in-loop
                    await yieldControl();
                    if (SEARCH_CANCELLED) break;
                  }
                }
              } else {
                await searchNodesRecursive(
                  s as any,
                  searchType,
                  searchName,
                  getNodePath(s),
                  rootResults,
                  stopThisPart || stopThisPartEach,
                  modifiers,
                  false,
                  isLastPart
                );
              }
              if (stopThisPart && FOUND_ONE) break;
              // For --fe, continue with other scopes after finding first match in current scope
            }
          }
        }

        results = rootResults;
        currentScope = rootResults.map(r => r.node);
      }
    } else {
      // Special handling for per-scope pick (--fe or --#e) on the final part.
      if (isLastPart && !modifiers?.firstMatch && (modifiers?.firstMatchEach || (modifiers?.indexPickEach ?? null))) {
        const perScope: SearchResult[] = [];
        const gate = gateFor(searchType);
        const qLower = searchName.toLowerCase();

        const indexToPick = (modifiers?.indexPickEach ?? 1);

        for (const parent of currentScope) {
          if (SEARCH_CANCELLED) break;
          const matches: SceneNode[] = [];

          if (isDirectChild) {
            if ('children' in parent) {
              const children = (parent as any).children as readonly SceneNode[];
              for (const ch of children) {
                if (SEARCH_CANCELLED) break;
                if (!modifiers?.allLayers && !modifiers?.hiddenOnly && !ch.visible) continue;
                if (searchType === 'SHAPE' && gateImage(ch)) continue;
                if (searchType === 'IMAGE' && !gateImage(ch)) continue;
                if (!gate(ch)) continue;
                if (((ch.name || '').toLowerCase().indexOf(qLower)) === -1) continue;
                if (modifiers?.hiddenOnly && ch.visible) continue;
                matches.push(ch);
              }
            }
          } else {
            // Collect all matches within this scope (respecting visibility flags similarly to findFirstMatchInScope)
            const fastMode = !(modifiers?.hiddenOnly || modifiers?.allLayers);
            const pool = (parent as any).findAll((n: SceneNode) => {
              if (fastMode && !n.visible) return false;
              if (searchType === 'SHAPE' && gateImage(n)) return false;
              if (searchType === 'IMAGE' && !gateImage(n)) return false;
              if (!gate(n)) return false;
              if (((n.name || '').toLowerCase().indexOf(qLower) === -1)) return false;
              if (modifiers?.hiddenOnly && n.visible) return false;
              return true;
            }) as SceneNode[];
            matches.push(...pool);
          }

          if (matches.length) {
            // If the last specified scope is Auto Layout, apply scope-aware rules:
            const parentLayout = (typeof (parent as any)?.layoutMode === 'string') ? (parent as any).layoutMode : 'NONE';
            // Always prioritize XY first; use z-order as tie-breaker via scope-aware or general rules
            const rowCmp = buildRowComparator(matches);
            const sorted = matches.slice().sort((x, y) => {
              const scopeMode = (typeof (parent as any)?.layoutMode === 'string') ? (parent as any).layoutMode : 'NONE';
              if (scopeMode === 'VERTICAL' || scopeMode === 'HORIZONTAL') {
                // Row-major inside last Auto Layout scope
                const r = rowCmp(x, y);
                if (r !== 0) return r;
                return compareWithinScope(parent, x, y);
              }
              // Non Auto Layout: keep Z-first behavior with row-major only as a secondary signal
              const z = compareZFirstWithinScope(parent, x, y);
              if (z !== 0) return z;
              return rowCmp(x, y);
            });
            const pick = sorted[indexToPick - 1] || null;
            if (pick) {
              const sym =
                searchType === 'IMAGE' ? '&' :
                searchType === 'SHAPE' ? '%' :
                pick.type === 'TEXT' ? '=' :
                pick.type === 'SECTION' ? '$' :
                pick.type === 'FRAME'   ? '@' :
                pick.type === 'INSTANCE'? '!' :
                (pick.type === 'COMPONENT' || pick.type === 'COMPONENT_SET') ? '?' : '';
              perScope.push({ node: pick, path: `${getNodePath(parent)}/${sym}${pick.name}` });
            }
          }
        }

        results = perScope;
        currentScope = perScope.map(r => r.node);
      } else {
        const childResults: SearchResult[] = [];
        for (const parent of currentScope) {
          if (SEARCH_CANCELLED) break;
          const kids = await searchChildren(
            parent,
            (part === '' ? 'ANY' : searchType),
            (part === '' ? '' : searchName),
            stopThisPart || stopThisPartEach,
            modifiers,
            isDirectChild,
            isLastPart
          );
          childResults.push(...kids);
          if (stopThisPart && FOUND_ONE) break;
        }
        results = childResults;
        currentScope = childResults.map(r => r.node);
      }
    }

    if (stopThisPart && results.length > 0) {
      results = [results[0]];
      currentScope = [results[0].node as any];
    }
    // For --fe, keep all first matches from each scope (don't limit results)

    if (currentScope.length === 0) break;
  }

  // Cache results for performance on future searches
  // Only cache fast-mode (no flags) results to avoid polluting cache with large hidden-inclusive traversals
  if (isFastMode) {
    searchCache.set(cacheKey, results);
  }
  
  // Limit cache size to prevent memory issues
  if (searchCache.size > 100) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey) {
      searchCache.delete(firstKey);
    }
  }

  // Apply global index (--#) at the very end across all selectable matches, using the same visual order
  if ((modifiers?.indexPick ?? null) && results.length > 0) {
    const selectable = results
      .map(r => r.node)
      .filter(node => 'id' in node && node.type !== 'PAGE') as SceneNode[];
    const sorted = selectable.slice().sort(buildRowComparator(selectable));
    const pick = sorted[Math.max(0, (modifiers!.indexPick as number) - 1)] || null;
    if (pick) {
      return results.filter(r => r.node === pick);
    } else {
      return [];
    }
  }

  return results;
}

function findFirstMatchInScope(
  scope: BaseNode & ChildrenMixin,
  type: string,
  name: string,
  modifiers?: SearchModifiers
): SceneNode | null {
  const gate = gateFor(type);
  const q = name.toLowerCase();
  const fastMode = !(modifiers?.hiddenOnly || modifiers?.allLayers);
  // Use built-in findAll for fast enumeration, then pick first
  const pool = (scope as any).findAll((n: SceneNode) => {
    if (fastMode && !n.visible) return false;
    if (type === 'SHAPE' && gateImage(n)) return false;
    if (type === 'IMAGE' && !gateImage(n)) return false;
    if (!gate(n)) return false;
    if (((n.name || '').toLowerCase().indexOf(q) === -1)) return false;
    if (modifiers?.hiddenOnly && n.visible) return false; // final-part filter for --h per scope-first
    return true;
  }) as SceneNode[];
  return pool.length ? pool[0] : null;
}



/**
 * Extracts the search type from a query part based on its prefix symbol
 * @param part - The query part (e.g., "@Frame", "!Instance")
 * @returns The search type (PAGE, SECTION, FRAME, etc.)
 */
function getSearchType(part: string): string {
  const c = (part.trim()[0] || '');
  if (c === '#') return 'PAGE';
  if (c === '$') return 'SECTION';
  if (c === '@') return 'FRAME';
  if (c === '&') return 'IMAGE';
  if (c === '%') return 'SHAPE';
  if (c === '=') return 'TEXT';
  if (c === '!') return 'INSTANCE';
  if (c === '?') return 'COMPONENT';
  return 'ANY';
}

/**
 * Extracts the search name from a query part by removing the prefix symbol
 * @param part - The query part (e.g., "@Frame", "!Instance")
 * @returns The name without the prefix symbol
 */
function getSearchName(part: string): string {
  const c = (part.trim()[0] || '');
  return (['#','$','@','&','%','=','!','?'].indexOf(c) !== -1 ? part.substring(1) : part).trim();
}

/**
 * Searches for nodes at the root level (pages, sections, or current page)
 * @param type - The type of node to search for
 * @param name - The name to search for
 * @param modifiers - Search modifiers for visibility filtering
 * @returns Array of search results
 */
async function searchAtRoot(type: string, name: string, modifiers?: SearchModifiers): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const nameLower = name.toLowerCase();
  
  if (type === 'PAGE') {
    // Search through all pages in the document
    const pages = figma.root.children;
    for (const page of pages) {
      if (page.name.toLowerCase().includes(nameLower)) {
        results.push({ node: page, path: `#${page.name}` });
      }
    }
  } else if (type === 'SECTION') {
    // For sections, search only in the current page
    const currentPage = figma.currentPage;
    
    for (const child of currentPage.children) {
      if (child.type === 'SECTION' && child.name.toLowerCase().includes(nameLower)) {
        results.push({ node: child, path: `#${currentPage.name}/${child.name}` });
      }
    }
  } else {
    // For other types, search in the current page
    const currentPage = figma.currentPage;
    const pageResults = await searchInPage(currentPage, type, name, modifiers);
    results.push(...pageResults);
  }
  
  return results;
}

/**
 * Searches for nodes within a specific page
 * @param page - The page to search in
 * @param type - The type of node to search for
 * @param name - The name to search for
 * @param modifiers - Search modifiers for visibility filtering
 * @returns Array of search results
 */
async function searchInPage(page: PageNode, type: string, name: string, modifiers?: SearchModifiers): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const q = name.toLowerCase();

  if (type === 'SECTION' || type === 'FRAME' || type === 'INSTANCE' || type === 'COMPONENT') {
    const types =
      type === 'SECTION'   ? ['SECTION'] :
      type === 'FRAME'     ? ['FRAME','GROUP'] :
      type === 'INSTANCE'  ? ['INSTANCE'] :
      /* COMPONENT */        ['COMPONENT','COMPONENT_SET'];

    const fastMode = !(modifiers?.hiddenOnly || modifiers?.allLayers);
    const pool = getCachedTypePool(page as any, types, fastMode);
    for (const n of pool) {
      if ((n.name || '').toLowerCase().indexOf(q) !== -1) {
        // Respect visibility flags similar to other code paths
        let shouldInclude = false;
        const isVisible = n.visible;
        // As this is a root-level search within a page (first part), treat as intermediate unless it's the only part
        const isLastPartAssumed = true; // searchInPage is used when no further parts are parsed at this stage
        if (isLastPartAssumed) {
          if (modifiers?.hiddenOnly) {
            shouldInclude = !isVisible;
          } else if (modifiers?.allLayers) {
            shouldInclude = true;
          } else {
            shouldInclude = isVisible;
          }
        } else {
          if (modifiers?.hiddenOnly || modifiers?.allLayers) {
            shouldInclude = true;
          } else {
            shouldInclude = isVisible;
          }
        }
        if (shouldInclude) {
          const sym = n.type === 'SECTION' ? '$' :
                      (n.type === 'FRAME' || n.type === 'GROUP') ? '@' :
                      n.type === 'INSTANCE' ? '!' :
                      n.type === 'TEXT' ? '=' :
                      (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') ? '?' : '';
          results.push({ node: n, path: `#${page.name}/${sym}${n.name}` });
        }
      }
    }
    return results;
  }

  // For IMAGE, SHAPE, and ANY types, use gated walk
  const gate = gateFor(type);
  const fastMode = !(modifiers?.hiddenOnly || modifiers?.allLayers);
  await walk(page, (n) => {
    if (fastMode && !n.visible) return true; // prune hidden early in fast mode
    if (type === 'SHAPE' && gateImage(n)) return true;
    if (type === 'IMAGE' && !gateImage(n)) return true;

    if (gate(n) && ((n.name || '').toLowerCase().indexOf(q) !== -1)) {
      const sym =
        type === 'IMAGE' ? '&' :
        type === 'SHAPE' ? '%' :
        type === 'TEXT' ? '=' :
        n.type === 'SECTION' ? '$' :
        n.type === 'FRAME'   ? '@' :
        n.type === 'INSTANCE'? '!' :
        (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') ? '?' : '';
      results.push({ node: n, path: `#${page.name}/${sym}${n.name}` });
      return false; // Don't search children of matching nodes
    }
    return true;
  }, modifiers);

  return results;
}

/**
 * Searches for child nodes within a parent node
 * @param parent - The parent node to search within
 * @param type - The type of node to search for
 * @param name - The name to search for
 * @param stopOnFirst - Whether to stop at the first match
 * @param modifiers - Search modifiers for visibility filtering
 * @param isDirectChild - Whether to search only direct children (one level deep)
 * @returns Array of search results
 */
async function searchChildren(parent: SceneNode|PageNode|SectionNode, type: string, name: string, stopOnFirst: boolean, modifiers?: SearchModifiers, isDirectChild: boolean = false, isFinalPart: boolean = false): Promise<SearchResult[]> {
  const results: SearchResult[] = [];
  const basePath = getNodePath(parent);
  if ('children' in parent) {
    const firstEachFinal = !!(stopOnFirst && modifiers?.firstMatchEach && isFinalPart);

    // If we are in --fe mode on the final part and not restricted to direct children,
    // pick only the first match within this specific parent scope and move on.
    if (firstEachFinal && !isDirectChild) {
      const match = findFirstMatchInScope(parent as any, type, name, modifiers);
      if (match) {
        const sym =
          type === 'IMAGE' ? '&' :
          type === 'SHAPE' ? '%' :
          match.type === 'SECTION' ? '$' :
          match.type === 'FRAME'   ? '@' :
          match.type === 'INSTANCE'? '!' :
          (match.type === 'COMPONENT' || match.type === 'COMPONENT_SET') ? '?' :
          match.type === 'TEXT' ? '=' : '';
        results.push({ node: match, path: `${basePath}/${sym}${match.name}` });
        return results;
      }
      return results;
    }

    // Optimized path for non-direct child searches of common types
    const fastMode = !(modifiers?.hiddenOnly || modifiers?.allLayers);
    if (!isDirectChild && (type === 'SECTION' || type === 'FRAME' || type === 'INSTANCE' || type === 'COMPONENT')) {
      const types =
        type === 'SECTION'   ? ['SECTION'] :
        type === 'FRAME'     ? ['FRAME','GROUP'] :
        type === 'INSTANCE'  ? ['INSTANCE'] :
                               ['COMPONENT','COMPONENT_SET'];

      const pool = getCachedTypePool(parent as any, types, fastMode);
      const q = name.toLowerCase();
      const yieldEvery = getYieldEvery(modifiers);
      for (let idx = 0; idx < pool.length; idx++) {
        const n = pool[idx];
        if (SEARCH_CANCELLED) break;
        if (fastMode && !isEffectivelyVisible(n)) continue;
        if ((n.name || '').toLowerCase().indexOf(q) !== -1) {
          // Determine inclusion based on visibility and flags
          let shouldInclude = true;
          if (!fastMode) {
            const isVisible = n.visible;
            if (isFinalPart) {
              if (modifiers?.hiddenOnly) shouldInclude = !isVisible;
              else if (modifiers?.allLayers) shouldInclude = true;
              else shouldInclude = isVisible;
            } else {
              shouldInclude = true; // include both hidden and visible for intermediate steps with flags
            }
          }

          if (shouldInclude) {
            const sym = n.type === 'SECTION' ? '$'
              : (n.type === 'FRAME' || n.type === 'GROUP') ? '@'
              : n.type === 'INSTANCE' ? '!'
              : n.type === 'TEXT' ? '='
              : (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') ? '?' : '';
            results.push({ node: n, path: `${basePath}/${sym}${n.name}` });
            if (stopOnFirst) {
              if (modifiers?.firstMatch) {
                FOUND_ONE = true;
                break;
              } else if (modifiers?.firstMatchEach) {
                break; // stop after first for this parent scope
              }
            }
          }
        }
        if (idx % yieldEvery === 0) {
          // eslint-disable-next-line no-await-in-loop
          await yieldControl();
          if (SEARCH_CANCELLED) break;
        }
      }
    } else {
      await searchNodesRecursive(parent as any, type, name, basePath, results, stopOnFirst, modifiers, isDirectChild, isFinalPart);
    }
  }
  return results;
}

/**
 * Recursively searches for nodes within a parent node
 * Handles the --f and --fe modifiers for stopping at first matches
 * @param node - The node to search within
 * @param type - The type of node to search for
 * @param name - The name to search for
 * @param currentPath - The current path for building result paths
 * @param results - Array to collect search results
 * @param stopOnFirst - Whether to stop at the first match
 * @param modifiers - Search modifiers for visibility filtering
 * @param isDirectChild - Whether to search only direct children (one level deep)
 * @param isFinalPart - Whether this is the final part of the search query (for --h modifier)
 */
async function searchNodesRecursive(
  node: BaseNode & ChildrenMixin,
  type: string,
  name: string,
  currentPath: string,
  results: SearchResult[],
  stopOnFirst: boolean = false,
  modifiers?: SearchModifiers,
  isDirectChild: boolean = false,
  isFinalPart: boolean = false
): Promise<void> {
  const gate = gateFor(type);
  let foundInThisScope = false;
  
  if (isDirectChild) {
    // For direct children, only search immediate children of the node
    if ('children' in node) {
      for (let ci = 0; ci < node.children.length; ci++) {
        const child = node.children[ci];
        if (SEARCH_CANCELLED) break;
        
        // Apply visibility filters
        if (!modifiers?.allLayers && !modifiers?.hiddenOnly && !child.visible) continue;
        
        if (type === 'SHAPE' && gateImage(child)) continue;
        if (type === 'IMAGE' && !gateImage(child)) continue;
        
        const isMatch = gate(child) && matchesName(child, name);
        // Apply --h constraint only to final part when checking matches
        if (isMatch && isFinalPart && modifiers?.hiddenOnly && child.visible) continue;
        if (isMatch) {
          const sym =
            type === 'IMAGE' ? '&' :
            type === 'SHAPE' ? '%' :
            type === 'TEXT' ? '=' :
            child.type === 'SECTION' ? '$' :
            child.type === 'FRAME'   ? '@' :
            child.type === 'INSTANCE'? '!' :
            (child.type === 'COMPONENT' || child.type === 'COMPONENT_SET') ? '?' : '';
          results.push({ node: child, path: `${currentPath}/${sym}${child.name}` });

          if (stopOnFirst) {
            if (modifiers?.firstMatch) {
              FOUND_ONE = true;
            } else if (modifiers?.firstMatchEach) {
              foundInThisScope = true;
              break; // Stop searching this scope
            }
          }
        }

        if (ci % YIELD_INTERVAL === 0) {
          // eslint-disable-next-line no-await-in-loop
          await yieldControl();
          if (SEARCH_CANCELLED) break;
        }
      }
    }
  } else {
    // Use the existing recursive walk for deep searches
    await walk(node, (n) => {
    if (type === 'SHAPE' && gateImage(n)) return true;
    if (type === 'IMAGE' && !gateImage(n)) return true;

    const isMatch = gate(n) && matchesName(n, name);
    // Apply --h constraint only to final part when checking matches
    if (isMatch && isFinalPart && modifiers?.hiddenOnly && n.visible) return true; // Skip this match but continue searching
    if (isMatch) {
      const sym =
        type === 'IMAGE' ? '&' :
        type === 'SHAPE' ? '%' :
        n.type === 'SECTION' ? '$' :
        n.type === 'FRAME'   ? '@' :
        n.type === 'INSTANCE'? '!' :
        (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') ? '?' : '';
      results.push({ node: n, path: `${currentPath}/${sym}${n.name}` });

      if (stopOnFirst) {
        if (modifiers?.firstMatch) {
          FOUND_ONE = true;   // Global stop for --f
        } else if (modifiers?.firstMatchEach) {
          foundInThisScope = true; // Local stop for --fe
          return false; // Stop searching this scope
        }
      }
      return false;                        // still prune this node’s children
    }
    return true;
  }, modifiers, isFinalPart);
  }
  
  // For --fe, don't set global FOUND_ONE to allow continuing with other scopes
}

/**
 * Builds a path string representing the hierarchy to a node
 * @param node - The node to build a path for
 * @returns A path string like "#Page/$Section/@Frame"
 */
function getNodePath(node: SceneNode | PageNode | SectionNode): string {
  const parts: string[] = [];
  let current: BaseNode | null = node;
  
  while (current) {
    let symbol = '';
    if (current.type === 'PAGE') symbol = '#';
    else if (current.type === 'SECTION') symbol = '$';
    else if (current.type === 'FRAME') symbol = '@';
    else if (current.type === 'INSTANCE') symbol = '!';
    else if (current.type === 'COMPONENT') symbol = '?';
    else if (current.type === 'TEXT') symbol = '=';
    
    if (symbol) {
      parts.unshift(`${symbol}${current.name}`);
    }
    
    current = current.parent;
  }
  
  return parts.join('/');
}

