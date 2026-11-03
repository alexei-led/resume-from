/** One line of text, whatever the input contained. Shared by every adapter that previews text. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
