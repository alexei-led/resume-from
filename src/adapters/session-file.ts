/**
 * The one read-and-time step every adapter uses to describe a session file.
 *
 * An adapter owns the format; this file owns the two facts outside it: the bytes, and the
 * modification time used when the file records no usable timestamp. A file that cannot be read
 * is a skipped row, never a failed listing.
 */

import { readFile, stat } from "node:fs/promises";
import type { SessionDescriptor } from "../session/contract.js";

export async function describeFileOnDisk(
  filePath: string,
  describe: (text: string, modified: string) => SessionDescriptor,
): Promise<SessionDescriptor | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const modified = (await stat(filePath)).mtime.toISOString();
    return describe(text, modified);
  } catch {
    return null;
  }
}
