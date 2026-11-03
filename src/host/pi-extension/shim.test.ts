import { describe, expect, it, vi } from "vitest";

const activatePiExtension = vi.hoisted(() => vi.fn());

vi.mock("resume-from", () => ({ activatePiExtension }));

type EntryRenderer = (
  entry: { data?: unknown },
  options: { expanded: boolean },
  theme: { fg(name: string, text: string): string },
) => { render(width: number): string[]; invalidate(): void };
type ShimFactory = (pi: {
  registerEntryRenderer(customType: string, renderer: EntryRenderer): void;
  registerCommand(name: string, definition: unknown): void;
}) => void;

type OuterCommandContext = {
  cwd: string;
  hasUI: boolean;
  ui: {
    notify(message: string, level: string): void;
    confirm(title: string, question: string): Promise<boolean>;
    select(title: string, options: string[]): Promise<string | undefined>;
  };
  switchSession(path: string, options: unknown): Promise<unknown>;
};

type OuterCommandHandler = (rawArgs: string, context: OuterCommandContext) => Promise<void>;
type MockPiActivation = {
  home: string | null;
  registrar: {
    registerCommand(definition: { name: string; description: string; run: unknown }): void;
  };
};

async function loadOuterCommand(): Promise<OuterCommandHandler> {
  const shimUrl = new URL("../../../shims/pi/extensions/resume-from.js", import.meta.url).href;
  const module = (await import(shimUrl)) as { default: ShimFactory };
  let handler: OuterCommandHandler | undefined;

  module.default({
    registerEntryRenderer() {},
    registerCommand(_name, definition) {
      handler = (definition as { handler: OuterCommandHandler }).handler;
    },
  });

  if (handler === undefined) throw new Error("resume-from shim did not register its command");
  return handler;
}

describe("Pi package shim provenance", () => {
  it("registers provenance as a transcript renderer instead of a persistent widget", async () => {
    const shimUrl = new URL("../../../shims/pi/extensions/resume-from.js", import.meta.url).href;
    const module = (await import(shimUrl)) as { default: ShimFactory };
    let renderer: EntryRenderer | undefined;

    module.default({
      registerEntryRenderer(customType, candidate) {
        expect(customType).toBe("resume-from-provenance");
        renderer = candidate;
      },
      registerCommand() {},
    });

    expect(renderer).toBeDefined();
    const component = renderer?.(
      { data: { lines: ["Imported from pi", "Source session: source-1", "Dropped: 57"] } },
      { expanded: false },
      { fg: (_name, text) => text },
    );
    expect(component?.render(80)).toEqual(["Imported from pi"]);

    const paints: string[] = [];
    renderer?.(
      { data: { lines: ["Imported from pi", "Source session: source-1", "Dropped: 57"] } },
      { expanded: false },
      {
        fg: (name, text) => {
          paints.push(name);
          return text;
        },
      },
    )?.render(80);
    expect(paints).toEqual(["dim"]);

    const expanded = renderer?.(
      { data: { lines: ["Imported from pi", "Source session: source-1", "Dropped: 57"] } },
      { expanded: true },
      { fg: (_name, text) => text },
    );
    expect(expanded?.render(80)).toEqual([
      "Imported from pi",
      "Source session: source-1",
      "Dropped: 57",
    ]);

    const unsafe = renderer?.(
      { data: { lines: ["Imported from pi\u001b[31m", "Dropped: 57"] } },
      { expanded: true },
      { fg: (_name, text) => text },
    );
    expect(unsafe?.render(80)[0]).toBe("Imported from pi ");
    expect(unsafe?.render(10)).toEqual(["Imported f\u001b[0m", "Dropped: 5\u001b[0m"]);

    const wide = renderer?.(
      { data: { lines: ["界界界界界", "Dropped: 57"] } },
      { expanded: true },
      { fg: (_name, text) => text },
    );
    expect(wide?.render(5)).toEqual(["界界\u001b[0m", "Dropp\u001b[0m"]);
  });
});

describe("Pi package shim command boundary", () => {
  it("uses one absolute home and preserves a path containing spaces as one argument", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = "relative-pi-home";
    const run = vi.fn().mockResolvedValue(undefined);
    activatePiExtension.mockImplementation(async (deps: MockPiActivation) => {
      deps.registrar.registerCommand({
        name: "resume-from",
        description: "test",
        run,
      });
    });

    try {
      const handler = await loadOuterCommand();
      const context: OuterCommandContext = {
        cwd: "/repo",
        hasUI: true,
        ui: {
          notify: vi.fn(),
          confirm: vi.fn().mockResolvedValue(true),
          select: vi.fn().mockResolvedValue(undefined),
        },
        switchSession: vi.fn().mockResolvedValue({ cancelled: false }),
      };

      await handler(" 'sessions/my session.jsonl' ", context);

      const activation = activatePiExtension.mock.calls.at(-1)?.[0] as MockPiActivation | undefined;
      expect(activation?.home).toMatch(/\/relative-pi-home$/);
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0].home).toBe(activation?.home);
      expect(run.mock.calls[0]?.[1]).toEqual(["sessions/my session.jsonl"]);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});
