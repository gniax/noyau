// One native clipboard read per user gesture; never poll or persist clipboard data.
export async function readNativeClipboard(clipboard, { imageOnly = false } = {}) {
  const { type, value } = await clipboard.read();
  if (!value) throw new Error("Presse-papiers vide.");
  if (type?.startsWith("image/") && value.startsWith("data:image/")) {
    const blob = await (await fetch(value)).blob();
    const ext = type.split("/")[1]?.replace("jpeg", "jpg") || "png";
    return { kind: "image", blob, type, ext };
  }
  if (!imageOnly && (type?.startsWith("text/") || !type)) return { kind: "text", value };
  throw new Error(imageOnly ? "Aucune image dans le presse-papiers." : "Contenu du presse-papiers non pris en charge.");
}
