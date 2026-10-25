// Editor -> Figma selection (protocol 5 `selectNode`). Does exactly this and nothing else with the payload.
interface Pageish { selection: unknown[]; }
export interface SelectApi {
  getNodeByIdAsync(id: string): Promise<{ id: string; removed?: boolean; type: string; parent: unknown } | null>;
  currentPage: Pageish;
  viewport: { scrollAndZoomIntoView(nodes: unknown[]): void };
}

/** True when the node exists on the current page tree and was selected; false (nothing changed) otherwise. */
export async function selectNode(api: SelectApi, nodeId: string, focus: boolean): Promise<boolean> {
  const n = await api.getNodeByIdAsync(nodeId);
  if (!n || n.removed || n.type === "PAGE" || n.type === "DOCUMENT") return false;
  let p: any = n;
  while (p && p !== api.currentPage) p = p.parent;
  if (!p) return false; // another page
  api.currentPage.selection = [n];
  if (focus) api.viewport.scrollAndZoomIntoView([n]);
  return true;
}
