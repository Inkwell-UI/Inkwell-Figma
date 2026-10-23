figma.showUI(__html__, { width: 320, height: 220 });

function postSelection() {
  figma.ui.postMessage({
    type: "selection",
    nodes: figma.currentPage.selection.map((n) => ({ id: n.id, name: n.name })),
  });
}
figma.on("selectionchange", postSelection);
postSelection();
