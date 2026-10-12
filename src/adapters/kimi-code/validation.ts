/**
 * The structural check every serialized Kimi Code session passes before placement (FR-50)
 * and again during read-back. Kimi Code's session index reads `state.json` and its resume
 * replays `wire.jsonl`; a defect in either is a session the agent would not open, and it
 * must be found here, before any byte reaches the disk.
 */

import { isAbsolute } from "node:path";
import type { ValidationDefect } from "./contract.js";
import { KIMI_MAIN_AGENT_ID, KIMI_SESSION_META_VERSION } from "./layout.js";
import { KIMI_RECORD_APPEND_MESSAGE, KIMI_RECORD_METADATA, parseWireText } from "./wire.js";

export interface KimiSessionInspection {
  itemCount: number;
  defects: ValidationDefect[];
}

/** The single inspection used both before placement and during read-back. */
export function inspectKimiWire(text: string): KimiSessionInspection {
  const defects: ValidationDefect[] = [];
  const { records, truncated } = parseWireText(text);
  if (truncated) {
    defects.push({ path: "wire", message: "a wire line is not one whole JSON object" });
  }

  const first = records[0];
  if (first === undefined || first.type !== KIMI_RECORD_METADATA) {
    defects.push({
      path: "wire/0",
      message: "the first record must be wire metadata, or resume cannot resolve the protocol",
    });
  } else if (
    typeof first.record.protocol_version !== "string" ||
    first.record.protocol_version === ""
  ) {
    defects.push({
      path: "wire/0/protocol_version",
      message: "wire metadata needs a protocol version",
    });
  }

  let itemCount = 0;
  let firstUserText = "";
  for (const [index, record] of records.entries()) {
    if (record.type !== KIMI_RECORD_APPEND_MESSAGE) continue;
    itemCount += 1;
    const pointer = `wire/${index}/message`;
    const message = record.record.message;
    if (typeof message !== "object" || message === null) {
      defects.push({ path: pointer, message: "a context message must be an object" });
      continue;
    }
    const messageRecord = message as Record<string, unknown>;
    if (typeof messageRecord.role !== "string" || messageRecord.role === "") {
      defects.push({ path: `${pointer}/role`, message: "a context message needs a role" });
    }
    if (!Array.isArray(messageRecord.content)) {
      defects.push({
        path: `${pointer}/content`,
        message: "a context message needs a content array",
      });
    }
    if (messageRecord.role === "assistant") {
      if (!Array.isArray(messageRecord.toolCalls)) {
        defects.push({
          path: `${pointer}/toolCalls`,
          message: "an assistant message needs a toolCalls array",
        });
      } else {
        for (const [callIndex, call] of messageRecord.toolCalls.entries()) {
          const fn =
            typeof call === "object" && call !== null
              ? (call as Record<string, unknown>).function
              : undefined;
          const name =
            typeof fn === "object" && fn !== null
              ? (fn as Record<string, unknown>).name
              : undefined;
          if (typeof name !== "string" || name === "") {
            defects.push({
              path: `${pointer}/toolCalls/${callIndex}`,
              message: "a tool call needs a function name",
            });
          }
        }
      }
    }
    if (messageRecord.role === "tool") {
      if (typeof messageRecord.toolCallId !== "string" || messageRecord.toolCallId === "") {
        defects.push({
          path: `${pointer}/toolCallId`,
          message: "a tool message needs the toolCallId of the call it answers",
        });
      }
    }
    if (
      firstUserText === "" &&
      messageRecord.role === "user" &&
      Array.isArray(messageRecord.content)
    ) {
      firstUserText = messageRecord.content
        .map((part) =>
          typeof part === "object" && part !== null
            ? (part as Record<string, unknown>).text
            : undefined,
        )
        .filter((text): text is string => typeof text === "string")
        .join("\n");
    }
  }

  if (itemCount === 0 || firstUserText.trim() === "") {
    defects.push({
      path: "wire",
      message:
        "no non-empty user message, so the session index would list a session with nothing to show",
    });
  }

  return { itemCount, defects };
}

/** Inspects the `state.json` half of a serialized session. */
export function inspectKimiState(
  text: string,
  expectedSessionId: string,
  expectedCwd: string | null,
): KimiSessionInspection {
  const defects: ValidationDefect[] = [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { itemCount: 0, defects: [{ path: "state", message: "state.json is not JSON" }] };
  }
  if (typeof value !== "object" || value === null) {
    return { itemCount: 0, defects: [{ path: "state", message: "state.json must be an object" }] };
  }
  const state = value as Record<string, unknown>;
  const need = (condition: boolean, path: string, message: string): void => {
    if (!condition) defects.push({ path, message });
  };
  need(state.id === expectedSessionId, "state/id", "state names a different session");
  need(
    state.version === KIMI_SESSION_META_VERSION,
    "state/version",
    "state must carry the metadata schema version",
  );
  need(typeof state.createdAt === "number", "state/createdAt", "state needs a numeric createdAt");
  need(typeof state.updatedAt === "number", "state/updatedAt", "state needs a numeric updatedAt");
  need(state.archived === false, "state/archived", "an imported session must not start archived");
  need(typeof state.title === "string", "state/title", "state needs a title");
  need(
    typeof state.cwd === "string" && isAbsolute(state.cwd),
    "state/cwd",
    "state needs an absolute cwd",
  );
  if (expectedCwd !== null) {
    need(
      state.cwd === expectedCwd,
      "state/cwd",
      "state cwd differs from the serialization context",
    );
  }
  const agents = state.agents;
  const main =
    typeof agents === "object" && agents !== null
      ? (agents as Record<string, unknown>)[KIMI_MAIN_AGENT_ID]
      : undefined;
  const homedir =
    typeof main === "object" && main !== null
      ? (main as Record<string, unknown>).homedir
      : undefined;
  need(
    typeof homedir === "string" && homedir.endsWith(`agents${"/"}${KIMI_MAIN_AGENT_ID}`),
    "state/agents/main/homedir",
    "agents.main.homedir must point at the session's own agents/main record directory",
  );
  return { itemCount: 0, defects };
}
