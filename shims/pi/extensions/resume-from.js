import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { activatePiExtension } from "resume-from";
import { formatRow, safeLines, safeText } from "resume-from/pi-extension";

const COMMAND_NAME = "resume-from";
const DESCRIPTION =
  "Continue another session. Use /resume-from --help for accepted arguments.";
const PROVENANCE_CUSTOM_TYPE = "resume-from-provenance";

function provenanceLines(data) {
  const lines = data?.lines;
  return Array.isArray(lines) && lines.every((line) => typeof line === "string")
    ? lines
    : null;
}

function renderProvenance(entry, { expanded }, theme) {
  const lines = provenanceLines(entry.data);
  const visible =
    lines === null
      ? ["Imported session"]
      : expanded
        ? lines
        : [`${lines[0] ?? "Imported session"} · ${lines.at(-1) ?? ""}`];
  return {
    render(width) {
      return visible.map((line) =>
        theme.fg("dim", truncateToWidth(safeText(line), Math.max(0, width), "")),
      );
    },
    invalidate() {},
  };
}

function agentHome() {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === undefined) return join(homedir(), ".pi", "agent");
  return isAbsolute(configured) ? configured : resolve(configured);
}

/** Split the raw command line on whitespace, honouring simple single and double quotes. */
function commandArgs(raw) {
  const args = [];
  let current = "";
  let quote = null;
  let started = false;
  for (const character of raw) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        args.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (started) args.push(current);
  return args;
}

function uiFor(context) {
  return {
    show(lines) {
      context.ui.notify(safeLines(lines).join("\n"), "info");
    },
    async confirm(question) {
      return (await context.ui.confirm("Resume session", safeText(question)))
        ? "selected"
        : "cancelled";
    },
  };
}

function pickerFor(context) {
  return {
    async pick(listing) {
      if (!context.hasUI) return { choice: "cancelled", selected: null };

      const options = listing.rows.map((row, index) =>
        safeText(`${index + 1}. ${formatRow(row)}`),
      );
      const selected = await context.ui.select(
        "Select a session to import",
        options,
      );
      const row =
        listing.rows[selected === undefined ? -1 : options.indexOf(selected)];
      return row === undefined
        ? { choice: "cancelled", selected: null }
        : { choice: "selected", selected: row };
    },
  };
}

export default function resumeFrom(pi) {
  // Provenance is already persisted as a custom entry. Render it in the transcript,
  // not as a widget, so it scrolls away and never occupies the footer/editor area.
  pi.registerEntryRenderer(PROVENANCE_CUSTOM_TYPE, renderProvenance);

  pi.registerCommand(COMMAND_NAME, {
    description: DESCRIPTION,
    async handler(rawArgs, context) {
      const home = agentHome();
      let command;
      await activatePiExtension({
        agent: "pi",
        registrar: { registerCommand: (definition) => (command = definition) },
        ui: uiFor(context),
        picker: pickerFor(context),
        home,
        cwd: context.cwd,
      });

      if (command === undefined) {
        throw new Error(
          "resume-from: extension activation did not register /resume-from.",
        );
      }

      await command.run(
        {
          cwd: context.cwd,
          home,
          switchSession: (path, options) =>
            context.switchSession(path, options),
        },
        commandArgs(rawArgs),
      );
    },
  });
}
