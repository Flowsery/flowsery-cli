import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setColorEnabled } from "../../src/core/color.js";
import { ApiError, usageError } from "../../src/core/errors.js";
import { ExitCode } from "../../src/core/exit-codes.js";
import {
  detectOutputMode,
  getOutputMode,
  hint,
  initOutput,
  print,
  printError,
  printJson,
  printResult,
  printTable,
  setOutputMode,
  setQuiet,
  success,
  warn,
} from "../../src/core/output.js";

let out: string[];
let err: string[];

beforeEach(() => {
  setColorEnabled(false);
  setQuiet(false);
  setOutputMode("human");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("detectOutputMode", () => {
  it("is human on a TTY with no flag", () => {
    expect(detectOutputMode({ isTTY: true, env: {} })).toBe("human");
  });

  it("is machine when stdout is not a TTY", () => {
    expect(detectOutputMode({ isTTY: false, env: {} })).toBe("machine");
  });

  it("is machine with --json even on a TTY", () => {
    expect(detectOutputMode({ isTTY: true, json: true, env: {} })).toBe("machine");
  });

  it("is machine under CI", () => {
    expect(detectOutputMode({ isTTY: true, env: { CI: "true" } })).toBe("machine");
    expect(detectOutputMode({ isTTY: true, env: { CI: "false" } })).toBe("human");
  });

  it("is machine with <PRODUCT>_JSON=1", () => {
    expect(detectOutputMode({ isTTY: true, envPrefix: "FLOWSERY", env: { FLOWSERY_JSON: "1" } })).toBe(
      "machine",
    );
  });

  it("stays human with <PRODUCT>_FORCE_TTY=1 while piped", () => {
    expect(
      detectOutputMode({ isTTY: false, envPrefix: "FLOWSERY", env: { FLOWSERY_FORCE_TTY: "1" } }),
    ).toBe("human");
  });

  it("lets --json win over FORCE_TTY", () => {
    expect(
      detectOutputMode({ isTTY: false, json: true, envPrefix: "FLOWSERY", env: { FLOWSERY_FORCE_TTY: "1" } }),
    ).toBe("machine");
  });

  it("is applied by initOutput", () => {
    expect(initOutput({ isTTY: false, env: {} })).toBe("machine");
    expect(getOutputMode()).toBe("machine");
  });
});

describe("human mode", () => {
  it("writes text and tables to stdout", () => {
    print("hello");
    printTable([{ id: "a" }], [{ header: "id", value: (row) => row.id }], { width: 40 });
    expect(out.join("")).toBe("hello\nID\na\n");
    expect(err).toEqual([]);
  });

  it("writes success to stdout and hints and warnings to stderr", () => {
    success("Goal tracked");
    hint("see it: flowsery goal list");
    warn("rate limit: 14 of 600 left");
    expect(out.join("")).toBe("✓ Goal tracked\n");
    expect(err.join("")).toBe("see it: flowsery goal list\n⚠ rate limit: 14 of 600 left\n");
  });

  it("writes nothing from printResult", () => {
    printResult("issue.list", [{ id: "a" }]);
    expect(out).toEqual([]);
  });
});

describe("machine mode", () => {
  beforeEach(() => {
    setOutputMode("machine");
  });

  it("writes one JSON document to stdout and nothing else", () => {
    print("hello");
    printTable([{ id: "a" }], [{ header: "id", value: (row) => row.id }]);
    success("Goal tracked");
    printResult("issue.list", [{ id: "iss_9c3e1f" }], { total: 47, limit: 20, offset: 0, hasMore: true });
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toEqual({
      ok: true,
      command: "issue.list",
      data: [{ id: "iss_9c3e1f" }],
      meta: { total: 47, limit: 20, offset: 0, hasMore: true },
    });
  });

  it("uses null data for commands with no payload", () => {
    printResult("goal.delete", null);
    expect(JSON.parse(out[0])).toEqual({ ok: true, command: "goal.delete", data: null });
  });

  it("still writes a raw document through printJson", () => {
    printJson({ a: 1 });
    expect(JSON.parse(out[0])).toEqual({ a: 1 });
  });
});

describe("quiet", () => {
  it("suppresses hints and warnings but never errors", () => {
    setQuiet(true);
    hint("a hint");
    warn("a warning");
    success("Goal tracked");
    expect(err).toEqual([]);
    expect(out.join("")).toBe("✓ Goal tracked\n");

    printError(usageError("bad flag"));
    expect(err.join("")).toContain("bad flag");
  });
});

describe("printError", () => {
  it("prints the message and hint to stderr in human mode", () => {
    const code = printError(
      new ApiError({ status: 404, body: { message: "Issue not found" }, hint: "list issues:  flowsery issue list" }),
      "issue.get",
    );
    expect(code).toBe(ExitCode.NOT_FOUND);
    expect(out).toEqual([]);
    expect(err.join("")).toBe("✗ Issue not found\n\n  list issues:  flowsery issue list\n");
  });

  it("lists flattened validation details", () => {
    printError(
      new ApiError({ status: 400, body: { message: ["text is required", "scheduledAt must be ISO"] } }),
      "post.create",
    );
    expect(err.join("")).toContain("· text is required");
    expect(err.join("")).toContain("· scheduledAt must be ISO");
  });

  it("prints a JSON error to stderr in machine mode", () => {
    setOutputMode("machine");
    const code = printError(new ApiError({ status: 404, body: { message: "Post not found" } }), "issue.get");
    expect(code).toBe(ExitCode.NOT_FOUND);
    expect(out).toEqual([]);
    expect(JSON.parse(err[0])).toEqual({
      ok: false,
      command: "issue.get",
      error: { code: "not_found", status: 404, message: "Post not found", details: null },
    });
  });

  it("returns the usage exit code for a CliError", () => {
    expect(printError(usageError("unknown enum"), "post.create")).toBe(ExitCode.USAGE);
  });
});
