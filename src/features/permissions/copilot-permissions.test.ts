import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RULESYNC_PERMISSIONS_FILE_NAME,
  RULESYNC_RELATIVE_DIR_PATH,
} from "../../constants/rulesync-paths.js";
import { createMockLogger } from "../../test-utils/mock-logger.js";
import { setupTestDirectory } from "../../test-utils/test-directories.js";
import { ensureDir, fileExists, writeFileContent } from "../../utils/file.js";
import { CopilotPermissions } from "./copilot-permissions.js";
import { RulesyncPermissions } from "./rulesync-permissions.js";

describe("CopilotPermissions", () => {
  let testDir: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ testDir, cleanup } = await setupTestDirectory());
    vi.spyOn(process, "cwd").mockReturnValue(testDir);
  });

  afterEach(async () => {
    await cleanup();
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create instance with valid JSON content", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({ "editor.tabSize": 2 }),
      });
      expect(instance).toBeInstanceOf(CopilotPermissions);
      expect(instance.getRelativeDirPath()).toBe(".vscode");
      expect(instance.getRelativeFilePath()).toBe("settings.json");
    });

    it("should default to empty object when fileContent is undefined", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: undefined,
      });
      expect(instance.getFileContent()).toBe("{}");
    });
  });

  describe("getSettablePaths", () => {
    it("should return .vscode/settings.json paths", () => {
      const paths = CopilotPermissions.getSettablePaths();
      expect(paths.relativeDirPath).toBe(".vscode");
      expect(paths.relativeFilePath).toBe("settings.json");
    });
  });

  describe("isDeletable", () => {
    it("should return false because settings.json is a shared file", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: "{}",
      });
      expect(instance.isDeletable()).toBe(false);
    });
  });

  describe("forDeletion", () => {
    it("should create an instance with empty content and return false for isDeletable", () => {
      const instance = CopilotPermissions.forDeletion({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
      });
      expect(instance).toBeInstanceOf(CopilotPermissions);
      expect(instance.getFileContent()).toBe("{}");
      expect(instance.isDeletable()).toBe(false);
    });
  });

  describe("validate", () => {
    it("should always return success for valid content", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({ ok: true }),
      });
      const result = instance.validate();
      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
    });

    it("should return failure for invalid JSONC content", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: '{ "invalid": true, }',
      });
      const result = instance.validate();
      expect(result.success).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error?.message).toContain("Failed to parse");
      expect(result.error?.message).toContain(".vscode/settings.json");
    });
  });

  describe("fromFile", () => {
    it("should create instance from existing settings.json", async () => {
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      await writeFileContent(
        join(settingsDir, "settings.json"),
        JSON.stringify({ "chat.mcp.access": "all" }),
      );

      const instance = await CopilotPermissions.fromFile({});

      expect(instance).toBeInstanceOf(CopilotPermissions);
      expect(JSON.parse(instance.getFileContent())["chat.mcp.access"]).toBe("all");
    });

    it("should use empty object when file does not exist", async () => {
      const instance = await CopilotPermissions.fromFile({});
      expect(instance.getFileContent()).toBe("{}");
    });

    it("should propagate logger so toRulesyncPermissions emits lossy warnings", async () => {
      const logger = createMockLogger();
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      await writeFileContent(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          "chat.mcp.access": "none",
          "chat.tools.edits.autoApprove": { "src/**": true },
        }),
      );

      const instance = await CopilotPermissions.fromFile({ logger });
      instance.toRulesyncPermissions();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Imported Copilot .vscode/settings.json with lossy mapping"),
      );
    });
  });

  describe("fromRulesyncPermissions / buildTerminalApprove", () => {
    it("should convert bash allow rules to true and deny to false", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            bash: { "git *": "allow", "rm -rf *": "deny" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.tools.terminal.autoApprove"]).toEqual({
        "git *": true,
        "rm -rf *": false,
      });
    });

    it("should warn and skip 'ask' rules", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            bash: { "git *": "allow", "*": "ask" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.tools.terminal.autoApprove"]).toEqual({ "git *": true });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipped 1 'ask' rules for Copilot"),
      );
    });

    it("should not emit chat.tools.terminal.autoApprove when all bash rules are 'ask'", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            bash: { "git *": "ask", "npm *": "ask" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content).not.toHaveProperty("chat.tools.terminal.autoApprove");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipped 2 'ask' rules for Copilot"),
      );
    });
  });

  describe("fromRulesyncPermissions / buildEditsApprove", () => {
    it("should merge edit and write categories into edits.autoApprove", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            edit: { "src/**": "allow" },
            write: { "docs/**": "allow" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.tools.edits.autoApprove"]).toEqual({
        "src/**": true,
        "docs/**": true,
      });
    });

    it("should prefer edit over write on conflict and warn", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            edit: { "**/.env": "deny" },
            write: { "**/.env": "allow" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.tools.edits.autoApprove"]).toEqual({ "**/.env": false });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Conflict on pattern '**/.env'"),
      );
    });
  });

  describe("fromRulesyncPermissions / buildUrlsApprove", () => {
    it("should convert webfetch rules to urls.autoApprove with boolean values", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            webfetch: { "https://github.com/*": "allow", "*": "deny" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.tools.urls.autoApprove"]).toEqual({
        "https://github.com/*": true,
        "*": false,
      });
    });
  });

  describe("fromRulesyncPermissions / buildMcpAccess", () => {
    it("should emit 'all' when all mcp__* rules are allow", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            mcp__server1__tool1: { "*": "allow" },
            mcp__server2__tool2: { "*": "allow" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.mcp.access"]).toBe("all");
    });

    it("should overwrite existing 'none' to 'all' when all mcp__* rules are allow", async () => {
      // Regression test for correctness bug: previously allow-only emitted
      // undefined, so a pre-existing "none" in settings.json remained and
      // silently blocked all MCP servers despite the rulesync rule saying allow.
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      await writeFileContent(
        join(settingsDir, "settings.json"),
        JSON.stringify({ "chat.mcp.access": "none" }),
      );
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { mcp__server1__tool1: { "*": "allow" } },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.mcp.access"]).toBe("all");
    });

    it("should count ask actions in mcp__* rules and skip emitting mcp.access when only ask", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            mcp__server1__tool1: { "*": "ask" },
            mcp__server2__tool2: { "*": "ask" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.mcp.access"]).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipped 2 'ask' rules for Copilot"),
      );
    });

    it("should emit 'none' when all mcp__* rules are deny", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            mcp__server1__tool1: { "*": "deny" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.mcp.access"]).toBe("none");
    });

    it("should emit 'none' with warn when mcp__* rules mix allow and deny (fail-closed)", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            mcp__server1__tool1: { "*": "allow" },
            mcp__server2__tool2: { "*": "deny" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.mcp.access"]).toBe("none");
      const warnCall = (logger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(warnCall).toBeDefined();
      const message = String(warnCall?.[0]);
      expect(message).toContain("Mixed allow/deny in mcp__* rules");
      expect(message).toContain("deny intent honored");
    });

    it("should emit 'all' and count 'ask' when mcp__* rules mix allow and ask (no deny)", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            mcp__server1__tool1: { "*": "allow" },
            mcp__server2__tool2: { "*": "ask" },
          },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.mcp.access"]).toBe("all");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Skipped 1 'ask' rules for Copilot"),
      );
    });
  });

  describe("fromRulesyncPermissions / unsupported categories", () => {
    it("should warn once aggregating all unsupported categories", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            read: { ".env": "deny", "*.secret": "deny" },
            websearch: { "*": "allow" },
          },
        }),
      });
      await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Following categories are skipped for Copilot v1"),
      );
      const message = (logger.warn as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("Following categories"));
      expect(message).toContain("read (2 rules)");
      expect(message).toContain("websearch (1 rule");
    });

    it("should not warn when no unsupported categories have rules", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });
      await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const messages = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        String(c[0]),
      );
      expect(messages.some((m) => m.includes("Following categories"))).toBe(false);
    });
  });

  describe("fromRulesyncPermissions / no filesystem side effects (dry-run safety)", () => {
    it("should not create .vscode/ or settings.json when the directory is absent", async () => {
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });

      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
      });

      // The merged content is still computed in-memory ...
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.tools.terminal.autoApprove"]).toEqual({ "git *": true });

      // ... but nothing is written to disk until the writer runs.
      expect(await fileExists(join(testDir, ".vscode"))).toBe(false);
      expect(await fileExists(join(testDir, ".vscode", "settings.json"))).toBe(false);
    });
  });

  describe("fromRulesyncPermissions / existing settings preservation", () => {
    it("should preserve unrelated keys", async () => {
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      await writeFileContent(
        join(settingsDir, "settings.json"),
        JSON.stringify({ "editor.tabSize": 2, "files.autoSave": "onFocusChange" }),
      );
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["editor.tabSize"]).toBe(2);
      expect(content["files.autoSave"]).toBe("onFocusChange");
      expect(content["chat.tools.terminal.autoApprove"]).toEqual({ "git *": true });
    });

    it("should preserve JSONC comments", async () => {
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      const sourceJsonc = `{
  // My editor setting
  "editor.tabSize": 2
}`;
      await writeFileContent(join(settingsDir, "settings.json"), sourceJsonc);
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
      });
      expect(instance.getFileContent()).toContain("// My editor setting");
    });

    it("should merge patterns and warn on conflict", async () => {
      const logger = createMockLogger();
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      await writeFileContent(
        join(settingsDir, "settings.json"),
        JSON.stringify({
          "chat.tools.terminal.autoApprove": { "my-tool": true, "git *": false },
        }),
      );
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.tools.terminal.autoApprove"]).toEqual({
        "my-tool": true,
        "git *": true,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Overwriting existing pattern 'git *'"),
      );
    });
  });

  describe("fromRulesyncPermissions / existing settings with parse errors", () => {
    it("should warn when existing settings.json has invalid JSONC", async () => {
      const logger = createMockLogger();
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      await writeFileContent(join(settingsDir, "settings.json"), '{ "editor.tabSize": 2, }');
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });
      await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("JSONC parse errors in .vscode/settings.json"),
      );
    });

    it("applyKey should skip merge and preserve corrupted content verbatim", async () => {
      const logger = createMockLogger();
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      const corruptedContent = '{ "editor.tabSize": 2, missingQuote }';
      await writeFileContent(join(settingsDir, "settings.json"), corruptedContent);
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      // The corrupted content must be preserved verbatim — no overwrite.
      expect(instance.getFileContent()).toBe(corruptedContent);
      // A warning mentioning skip/parse error must have been emitted.
      const warnMessages = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
        String(c[0]),
      );
      expect(
        warnMessages.some(
          (m) => m.includes("JSONC parse errors") && m.includes(".vscode/settings.json"),
        ),
      ).toBe(true);
    });
  });

  describe("toRulesyncPermissions / parse-error fail-safe", () => {
    it("should return empty permissions and warn instead of throwing when content is corrupted", async () => {
      const logger = createMockLogger();
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      const corruptedContent =
        '{ "chat.tools.terminal.autoApprove": { "git *": true }, missingQuote }';
      await writeFileContent(join(settingsDir, "settings.json"), corruptedContent);

      const instance = await CopilotPermissions.fromFile({ outputRoot: testDir, logger });
      const result = instance.toRulesyncPermissions();
      const config = JSON.parse(result.getFileContent());

      // All permission categories must be empty.
      expect(config.permission).toEqual({});
      // A warn must have been emitted mentioning the parse error.
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to parse"));
    });
  });

  describe("toRulesyncPermissions / parseTerminalApprove", () => {
    it("should convert boolean values to allow/deny", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.terminal.autoApprove": { "git *": true, "rm *": false },
        }),
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission.bash).toEqual({ "git *": "allow", "rm *": "deny" });
    });

    it("should support {approve} object form", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.terminal.autoApprove": {
            "git *": { approve: true },
            "rm *": { approve: false, matchCommandLine: true },
          },
        }),
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission.bash).toEqual({ "git *": "allow", "rm *": "deny" });
    });

    it("should skip null entries", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.terminal.autoApprove": { "git *": true, rm: null },
        }),
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission.bash).toEqual({ "git *": "allow" });
    });
  });

  describe("toRulesyncPermissions / parseEditsApprove", () => {
    it("should convert edits.autoApprove to edit category only", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.edits.autoApprove": { "src/**": true, "**/.env": false },
        }),
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission.edit).toEqual({ "src/**": "allow", "**/.env": "deny" });
      expect(config.permission.write).toBeUndefined();
    });

    it("should emit the lossy warning exactly once even for multiple patterns", () => {
      const logger = createMockLogger();
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.edits.autoApprove": {
            "src/**": true,
            "docs/**": true,
            "**/.env": false,
          },
        }),
        logger,
      });
      instance.toRulesyncPermissions();
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
      const lossyMessages = warnCalls.filter((c) => String(c[0]).includes("Imported Copilot"));
      expect(lossyMessages).toHaveLength(1);
      expect(String(lossyMessages[0]?.[0])).toContain("3 patterns mapped to 'edit' category only");
    });
  });

  describe("toRulesyncPermissions / parseUrlsApprove", () => {
    it("should convert boolean values to webfetch allow/deny", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.urls.autoApprove": { "github.com/*": true, "*": false },
        }),
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission.webfetch).toEqual({
        "github.com/*": "allow",
        "*": "deny",
      });
    });

    it("should use approveRequest and drop approveResponse", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.urls.autoApprove": {
            "api.example.com/*": { approveRequest: true, approveResponse: false },
          },
        }),
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission.webfetch).toEqual({ "api.example.com/*": "allow" });
    });
  });

  describe("toRulesyncPermissions / mcp.access skip", () => {
    it("should not produce mcp__* categories from mcp.access value", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({ "chat.mcp.access": "none" }),
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission).toEqual({});
    });
  });

  describe("toRulesyncPermissions / parse errors", () => {
    it("should return empty permissions and warn (not throw) when JSONC contains parse errors", () => {
      const logger = createMockLogger();
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: '{ "chat.tools.terminal.autoApprove": { "git *": true, } }',
        logger,
      });
      const result = instance.toRulesyncPermissions();
      const config = JSON.parse(result.getFileContent());
      expect(config.permission).toEqual({});
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to parse"));
    });
  });

  describe("toRulesyncPermissions / malformed input tolerance", () => {
    it("should return empty RulesyncPermissions when root is a number", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: "123",
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission).toEqual({});
    });

    it("should return empty RulesyncPermissions when root is a string", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: '"hello"',
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission).toEqual({});
    });

    it("should return empty RulesyncPermissions when root is a boolean", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: "true",
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission).toEqual({});
    });

    it("should return empty RulesyncPermissions when root is null", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: "null",
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission).toEqual({});
    });

    it("should return empty RulesyncPermissions when root is an array", () => {
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: "[]",
      });
      const rulesync = instance.toRulesyncPermissions();
      const config = JSON.parse(rulesync.getFileContent());
      expect(config.permission).toEqual({});
    });
  });

  describe("roundtrip / fromRulesyncPermissions → toRulesyncPermissions", () => {
    it("should preserve bash/edit/webfetch allow & deny entries", async () => {
      const originalPermission = {
        bash: { "git *": "allow", "rm *": "deny" },
        edit: { "src/**": "allow", "**/.env": "deny" },
        webfetch: { "https://github.com/*": "allow", "https://evil.example/*": "deny" },
      };
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({ permission: originalPermission }),
      });
      const copilot = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
      });
      const roundtripped = JSON.parse(copilot.toRulesyncPermissions().getFileContent());
      expect(roundtripped.permission).toEqual(originalPermission);
    });

    it("should drop 'ask' actions on roundtrip (Copilot has no equivalent)", async () => {
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow", "*": "ask" } },
        }),
      });
      const copilot = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
      });
      const roundtripped = JSON.parse(copilot.toRulesyncPermissions().getFileContent());
      expect(roundtripped.permission.bash).toEqual({ "git *": "allow" });
    });

    it("should merge edit and write into edit only on roundtrip", async () => {
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            edit: { "src/**": "allow" },
            write: { "docs/**": "allow" },
          },
        }),
      });
      const copilot = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
      });
      const roundtripped = JSON.parse(copilot.toRulesyncPermissions().getFileContent());
      expect(roundtripped.permission.edit).toEqual({
        "src/**": "allow",
        "docs/**": "allow",
      });
      expect(roundtripped.permission.write).toBeUndefined();
    });

    it("should round-trip write-only rules into 'edit' on import (no separate write category)", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: {
            write: { "src/**": "allow", "**/.env": "deny" },
          },
        }),
      });
      const copilot = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
      });
      const exported = JSON.parse(copilot.getFileContent());
      expect(exported["chat.tools.edits.autoApprove"]).toEqual({
        "src/**": true,
        "**/.env": false,
      });

      const copilotWithLogger = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: copilot.getFileContent(),
        logger,
      });
      const roundtripped = JSON.parse(copilotWithLogger.toRulesyncPermissions().getFileContent());
      expect(roundtripped.permission.edit).toEqual({
        "src/**": "allow",
        "**/.env": "deny",
      });
      expect(roundtripped.permission.write).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("2 patterns mapped to 'edit' category only"),
      );
    });
  });

  describe("toRulesyncPermissions / lossy aggregation warn", () => {
    it("should warn once when lossy import occurs", () => {
      const logger = createMockLogger();
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.edits.autoApprove": { "src/**": true },
          "chat.tools.urls.autoApprove": {
            "api.example.com": { approveRequest: true, approveResponse: false },
          },
          "chat.mcp.access": "none",
          "chat.tools.terminal.autoApprove": {
            "git *": { approve: true, matchCommandLine: true },
          },
        }),
        logger,
      });
      instance.toRulesyncPermissions();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Imported Copilot .vscode/settings.json with lossy mapping"),
      );
    });

    it("should not warn when no lossy mapping occurs", () => {
      const logger = createMockLogger();
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent: JSON.stringify({
          "chat.tools.terminal.autoApprove": { "git *": true },
        }),
        logger,
      });
      instance.toRulesyncPermissions();
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("fromRulesyncPermissions / regex-style bash keys", () => {
    it("should warn when a bash pattern looks like a regex key but still emit it literally", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "/^git (status|log)/": "allow" } },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const content = JSON.parse(instance.getFileContent());
      expect(content["chat.tools.terminal.autoApprove"]).toEqual({
        "/^git (status|log)/": true,
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("looks like a regular-expression key"),
      );
    });

    it("should not warn for ordinary glob-style bash patterns", async () => {
      const logger = createMockLogger();
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });
      await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("looks like a regular-expression key"),
      );
    });
  });

  describe("BOM tolerance", () => {
    it("fromRulesyncPermissions should parse a BOM-prefixed settings.json, preserve unrelated keys, and emit BOM-free output", async () => {
      const logger = createMockLogger();
      const settingsDir = join(testDir, ".vscode");
      await ensureDir(settingsDir);
      await writeFileContent(
        join(settingsDir, "settings.json"),
        "﻿" + JSON.stringify({ "editor.tabSize": 2 }),
      );
      const rulesyncPermissions = new RulesyncPermissions({
        relativeDirPath: RULESYNC_RELATIVE_DIR_PATH,
        relativeFilePath: RULESYNC_PERMISSIONS_FILE_NAME,
        fileContent: JSON.stringify({
          permission: { bash: { "git *": "allow" } },
        }),
      });
      const instance = await CopilotPermissions.fromRulesyncPermissions({
        outputRoot: testDir,
        rulesyncPermissions,
        logger,
      });
      const raw = instance.getFileContent();
      expect(raw.charCodeAt(0)).not.toBe(0xfeff);
      const content = JSON.parse(raw);
      expect(content["editor.tabSize"]).toBe(2);
      expect(content["chat.tools.terminal.autoApprove"]).toEqual({ "git *": true });
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("JSONC parse errors"),
      );
    });

    it("toRulesyncPermissions should parse a BOM-prefixed settings.json without a parse-error warning", () => {
      const logger = createMockLogger();
      const instance = new CopilotPermissions({
        relativeDirPath: ".vscode",
        relativeFilePath: "settings.json",
        fileContent:
          "﻿" +
          JSON.stringify({ "chat.tools.terminal.autoApprove": { "git *": true } }),
        logger,
      });
      const rulesync = JSON.parse(instance.toRulesyncPermissions().getFileContent());
      expect(rulesync.permission.bash).toEqual({ "git *": "allow" });
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse Copilot permissions content"),
      );
    });
  });
});
