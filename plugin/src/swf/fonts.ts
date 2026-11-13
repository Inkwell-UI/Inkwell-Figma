// The game's font aliases and the Figma family/style each one is drawn in (the editor's FIGMA_FACES, `Inkwell-Editor/src/shared/fonts.ts`; keep in sync).
export const FACES: Record<string, [family: string, style: string]> = {
  $EverywhereFont: ["Everywhere", "Light"], $DialogueFont: ["Everywhere", "Light"],
  $EverywhereMediumFont: ["Everywhere", "Medium"], $StartMenuFont: ["Everywhere", "Medium"],
  $EverywhereBoldFont: ["Everywhere", "Bold"],
  $DragonFont: ["Dragon", "Regular"], $HandwrittenFont: ["Handwritten", "Regular"], $HandwrittenBold: ["Handwritten", "Regular"],
  $FalmerFont: ["Falmer", "Regular"], $DwemerFont: ["Dwemer", "Regular"], $DaedricFont: ["Daedric", "Regular"], $MageScriptFont: ["MageScript", "Regular"],
  $SkyrimSymbolsFont: ["SkyrimSymbols", "Regular"], $SkyrimBooks: ["SkyrimBooks", "Regular"], $SkyrimBooks_UnreadableFont: ["SkyrimBooksUnreadable", "Regular"],
  $CClub_Font: ["CreationClub", "Regular"], $CClub_Font_Bold: ["CreationClub", "Bold"],
  ControllerButtons: ["ControllerButtons", "Regular"], ControllerButtonsInverted: ["ControllerButtonsInverted", "Regular"],
};

/** Fonts to try for a SWF font, best first: the game's face, then the name as a Figma family (Bold/Italic as the SWF says), then Inter. */
export function fontCandidates(name: string, bold: boolean, italic: boolean): { family: string; style: string }[] {
  const style = bold && italic ? "Bold Italic" : bold ? "Bold" : italic ? "Italic" : "Regular";
  const out: { family: string; style: string }[] = [];
  const face = FACES[name];
  if (face) out.push({ family: face[0], style: face[1] });
  if (name) out.push({ family: name, style }, { family: name, style: "Regular" });
  out.push({ family: "Inter", style: bold ? "Bold" : "Regular" }, { family: "Inter", style: "Regular" });
  return out;
}
