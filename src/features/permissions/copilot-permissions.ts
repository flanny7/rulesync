import { join } from "node:path";

import {
  modify,
  applyEdits,
  type Edit,
  parse as jsoncParse,
  type ParseError,
  printParseErrorCode,
} from "jsonc-parser";

import type { AiFileParams, ValidationResult } from "../../types/ai-file.js";
import type { PermissionAction, PermissionsConfig } from "../../types/permissions.js";
import { readFileContentOrNull } from "../../utils/file.js";
import type { Logger } from "../../utils/logger.js";
import { isRecordStringUnknown } from "../../utils/types.js";
import { RulesyncPermissions } from "./rulesync-permissions.js";
import {
  ToolPermissions,
  type ToolPermissionsForDeletionParams,
  type ToolPermissionsFromFileParams,
  type ToolPermissionsFromRulesyncPermissionsParams,
  type ToolPermissionsSettablePaths,
} from "./tool-permissions.js";

const COPILOT_KEY_TERMINAL = "chat.tools.terminal.autoApprove";
const COPILOT_KEY_EDITS = "chat.tools.edits.autoApprove";
const COPILOT_KEY_URLS = "chat.tools.urls.autoApprove";
const COPILOT_KEY_MCP_ACCESS = "chat.mcp.access";

const NON_SUPPORTED_CATEGORIES_V1 = [
  "read",
  "websearch",
  "grep",
  "glob",
  "notebookedit",
  "agent",
] as const;

export class CopilotPermissions extends ToolPermissions {
  private readonly logger?: Logger;

  constructor(
    params: Omit<AiFileParams, "fileContent"> & { fileContent?: string } & { logger?: Logger },
  ) {
    super({
      ...params,
      fileContent: params.fileContent ?? "{}",
    });
    this.logger = params.logger;
  }

  override isDeletable(): boolean {
    return false;
  }

  static getSettablePaths(): ToolPermissionsSettablePaths {
    return {
      relativeDirPath: ".vscode",
      relativeFilePath: "settings.json",
    };
  }

  static async fromFile({
    outputRoot = process.cwd(),
    validate = true,
    logger,
  }: ToolPermissionsFromFileParams): Promise<CopilotPermissions> {
    const paths = CopilotPermissions.getSettablePaths();
    const filePath = join(outputRoot, paths.relativeDirPath, paths.relativeFilePath);
    const fileContent = (await readFileContentOrNull(filePath)) ?? "{}";
    return new CopilotPermissions({
      outputRoot,
      relativeDirPath: paths.relativeDirPath,
      relativeFilePath: paths.relativeFilePath,
      fileContent,
      validate,
      logger,
    });
  }

  static async fromRulesyncPermissions({
    outputRoot = process.cwd(),
    rulesyncPermissions,
    logger,
  }: ToolPermissionsFromRulesyncPermissionsParams): Promise<CopilotPermissions> {
    const paths = CopilotPermissions.getSettablePaths();
    const filePath = join(outputRoot, paths.relativeDirPath, paths.relativeFilePath);
    // Use null-fallback (instead of readOrInitializeFileContent) so generation has no
    // filesystem side effects when .vscode/ does not yet exist (important for dry-run).
    // .vscode/settings.json is shared with VS Code itself, so eagerly creating it on a
    // dry run would be a destructive change. Mirrors qwencode-permissions.ts.
    const existingContent = (await readFileContentOrNull(filePath)) ?? "{}";

    const config = rulesyncPermissions.getJson();
    const askCounter: AskCounter = { count: 0 };

    const terminalApprove = buildTerminalApprove(config.permission.bash, askCounter);
    const editsApprove = buildEditsApprove(
      config.permission.edit,
      config.permission.write,
      askCounter,
      logger,
    );
    const urlsApprove = buildUrlsApprove(config.permission.webfetch, askCounter);
    const mcpAccess = buildMcpAccess(config.permission, askCounter, logger);

    let updated = existingContent;
    if (terminalApprove !== undefined) {
      updated = applyKey(updated, COPILOT_KEY_TERMINAL, terminalApprove, logger);
    }
    if (editsApprove !== undefined) {
      updated = applyKey(updated, COPILOT_KEY_EDITS, editsApprove, logger);
    }
    if (urlsApprove !== undefined) {
      updated = applyKey(updated, COPILOT_KEY_URLS, urlsApprove, logger);
    }
    if (mcpAccess !== undefined) {
      updated = applyKey(updated, COPILOT_KEY_MCP_ACCESS, mcpAccess, logger);
    }

    if (askCounter.count > 0 && logger) {
      logger.warn(`Skipped ${askCounter.count} 'ask' rules for Copilot (no equivalent)`);
    }

    collectUnsupportedCategories(config.permission, logger);

    return new CopilotPermissions({
      outputRoot,
      relativeDirPath: paths.relativeDirPath,
      relativeFilePath: paths.relativeFilePath,
      fileContent: updated,
      validate: true,
      logger,
    });
  }

  toRulesyncPermissions(): RulesyncPermissions {
    const parseErrors: ParseError[] = [];
    const parsed: unknown = jsoncParse(stripBom(this.getFileContent()), parseErrors);

    // Unlike peer Permissions classes which throw on parse errors, Copilot warns and
    // returns empty here. .vscode/settings.json is a user-shared workspace file with
    // non-Copilot content, so we must not abort import or callers risk losing
    // unrelated settings on a subsequent generate.
    if (parseErrors.length > 0) {
      this.logger?.warn(
        `Failed to parse Copilot permissions content in ${join(this.getRelativeDirPath(), this.getRelativeFilePath())}: ${parseErrors.map((e) => printParseErrorCode(e.error)).join(", ")} — returning empty rulesync permissions`,
      );
      return this.toRulesyncPermissionsDefault({
        fileContent: JSON.stringify({ permission: {} }, null, 2),
      });
    }

    const settings = isRecordStringUnknown(parsed) ? parsed : {};

    const lossy: LossyCounters = {
      matchCommandLineDropped: 0,
      approveResponseDropped: 0,
      editsApprovePatternsImportedAsEditOnly: 0,
      mcpAccessSkipped: { skipped: false, value: undefined },
    };

    const permission: Record<string, Record<string, PermissionAction>> = {};

    const bash = parseTerminalApprove(settings[COPILOT_KEY_TERMINAL], lossy);
    if (bash) permission.bash = bash;

    const edit = parseEditsApprove(settings[COPILOT_KEY_EDITS], lossy);
    if (edit) permission.edit = edit;

    const webfetch = parseUrlsApprove(settings[COPILOT_KEY_URLS], lossy);
    if (webfetch) permission.webfetch = webfetch;

    const mcpAccessValue = settings[COPILOT_KEY_MCP_ACCESS];
    if (mcpAccessValue !== undefined) {
      lossy.mcpAccessSkipped = { skipped: true, value: mcpAccessValue };
    }

    const config: PermissionsConfig = { permission };

    const lossyMessages: string[] = [];
    if (lossy.editsApprovePatternsImportedAsEditOnly > 0) {
      lossyMessages.push(
        `${lossy.editsApprovePatternsImportedAsEditOnly} patterns mapped to 'edit' category only — Copilot does not expose a separate 'write' category`,
      );
    }
    if (lossy.approveResponseDropped > 0) {
      lossyMessages.push(
        `${lossy.approveResponseDropped} urls.autoApprove approveResponse fields dropped`,
      );
    }
    if (lossy.mcpAccessSkipped.skipped) {
      lossyMessages.push(
        `mcp.access (${JSON.stringify(lossy.mcpAccessSkipped.value)}) skipped (no per-server mapping)`,
      );
    }
    if (lossy.matchCommandLineDropped > 0) {
      lossyMessages.push(
        `${lossy.matchCommandLineDropped} terminal.autoApprove matchCommandLine fields dropped`,
      );
    }
    if (lossyMessages.length > 0 && this.logger) {
      this.logger.warn(
        `Imported Copilot .vscode/settings.json with lossy mapping:\n - ${lossyMessages.join("\n - ")}`,
      );
    }

    return this.toRulesyncPermissionsDefault({
      fileContent: JSON.stringify(config, null, 2),
    });
  }

  validate(): ValidationResult {
    const parseErrors: ParseError[] = [];
    jsoncParse(stripBom(this.getFileContent()), parseErrors);
    if (parseErrors.length > 0) {
      return {
        success: false,
        error: new Error(
          `Failed to parse Copilot permissions content in ${join(this.getRelativeDirPath(), this.getRelativeFilePath())}: ${parseErrors.map((e) => printParseErrorCode(e.error)).join(", ")}`,
        ),
      };
    }
    return { success: true, error: null };
  }

  static forDeletion({
    outputRoot = process.cwd(),
    relativeDirPath,
    relativeFilePath,
  }: ToolPermissionsForDeletionParams): CopilotPermissions {
    return new CopilotPermissions({
      outputRoot,
      relativeDirPath,
      relativeFilePath,
      fileContent: "{}",
      validate: false,
    });
  }
}

/**
 * jsonc-parser does not strip a UTF-8 BOM; a BOM-prefixed settings.json is
 * otherwise reported as InvalidSymbol and would silently skip every Copilot
 * write. VS Code itself tolerates a BOM in settings.json, so we strip it before
 * parsing and emit BOM-free content (which VS Code also accepts).
 */
function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function actionToBoolean(action: PermissionAction): boolean | null {
  if (action === "allow") return true;
  if (action === "deny") return false;
  return null; // ask
}

type AskCounter = { count: number };

function buildBooleanRules(
  rules: Record<string, PermissionAction> | undefined,
  askCounter: AskCounter,
): Record<string, boolean> | undefined {
  if (!rules) return undefined;
  const result: Record<string, boolean> = {};
  for (const [pattern, action] of Object.entries(rules)) {
    const v = actionToBoolean(action);
    if (v === null) {
      askCounter.count += 1;
      continue;
    }
    result[pattern] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildTerminalApprove(
  rules: Record<string, PermissionAction> | undefined,
  askCounter: AskCounter,
): Record<string, boolean> | undefined {
  return buildBooleanRules(rules, askCounter);
}

function buildEditsApprove(
  editRules: Record<string, PermissionAction> | undefined,
  writeRules: Record<string, PermissionAction> | undefined,
  askCounter: AskCounter,
  logger?: Logger,
): Record<string, boolean> | undefined {
  if (!editRules && !writeRules) return undefined;
  const result: Record<string, boolean> = {};
  const editEntries = Object.entries(editRules ?? {});
  const writeEntries = Object.entries(writeRules ?? {});
  const editMap = new Map<string, PermissionAction>(editEntries);
  const writeMap = new Map<string, PermissionAction>(writeEntries);
  // Process edit entries first
  for (const [pattern, action] of editEntries) {
    if (writeMap.has(pattern) && writeMap.get(pattern) !== action) {
      logger?.warn(
        `Conflict on pattern '${pattern}': edit=${action} vs write=${writeMap.get(pattern)}, using edit`,
      );
    }
    const v = actionToBoolean(action);
    if (v === null) {
      askCounter.count += 1;
      continue;
    }
    result[pattern] = v;
  }
  // Add write entries that are not present in edit
  for (const [pattern, action] of writeEntries) {
    if (editMap.has(pattern)) continue;
    const v = actionToBoolean(action);
    if (v === null) {
      askCounter.count += 1;
      continue;
    }
    result[pattern] = v;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildUrlsApprove(
  rules: Record<string, PermissionAction> | undefined,
  askCounter: AskCounter,
): Record<string, boolean> | undefined {
  return buildBooleanRules(rules, askCounter);
}

function buildMcpAccess(
  permission: PermissionsConfig["permission"],
  askCounter: AskCounter,
  logger?: Logger,
): "none" | "all" | undefined {
  const mcpCategories = Object.keys(permission).filter((k) => k.startsWith("mcp__"));
  if (mcpCategories.length === 0) return undefined;
  let hasAllow = false;
  let hasDeny = false;
  for (const category of mcpCategories) {
    const rules = permission[category] ?? {};
    for (const action of Object.values(rules)) {
      if (action === "allow") hasAllow = true;
      else if (action === "deny") hasDeny = true;
      else if (action === "ask") askCounter.count += 1;
    }
  }
  if (!hasAllow && !hasDeny) return undefined;
  if (hasAllow && hasDeny) {
    logger?.warn(
      `Mixed allow/deny in mcp__* rules; emitted ${COPILOT_KEY_MCP_ACCESS}='none' (deny intent honored — Copilot's chat.mcp.access is binary and cannot represent per-server policy)`,
    );
    return "none";
  }
  if (hasDeny) return "none";
  // Allow-only: explicitly emit "all" so a previous "none" setting in
  // .vscode/settings.json is overridden (otherwise rulesync would say "allow"
  // while Copilot still blocks every MCP server).
  return "all";
}

function collectUnsupportedCategories(
  permission: PermissionsConfig["permission"],
  logger?: Logger,
): void {
  if (!logger) return;
  const items: string[] = [];
  for (const category of NON_SUPPORTED_CATEGORIES_V1) {
    const rules = permission[category];
    if (!rules) continue;
    const count = Object.keys(rules).length;
    if (count === 0) continue;
    items.push(`${category} (${count} rule${count === 1 ? "" : "s"})`);
  }
  if (items.length > 0) {
    logger.warn(
      `Following categories are skipped for Copilot v1 (not yet supported): ${items.join(", ")}. See docs/reference/file-formats.md for Copilot scope details.`,
    );
  }
}

function applyKey(
  source: string,
  key: string,
  newValue: Record<string, unknown> | string,
  logger?: Logger,
): string {
  const parseErrors: ParseError[] = [];
  const src = stripBom(source);
  const parsed: unknown = jsoncParse(src, parseErrors);
  if (parseErrors.length > 0) {
    // Same rationale as toRulesyncPermissions: warn-and-return preserves unrelated settings.
    // Skip the merge entirely to avoid overwriting corrupted settings.json.
    // Return the original content unchanged so user data is preserved.
    logger?.warn(
      `JSONC parse errors in .vscode/settings.json while applying '${key}': ${parseErrors.map((e) => printParseErrorCode(e.error)).join(", ")} — skipping merge to avoid overwriting corrupted settings.json`,
    );
    return source;
  }
  let existing: unknown;
  if (isRecordStringUnknown(parsed)) {
    existing = parsed[key];
  }
  let merged: unknown = newValue;
  if (isRecordStringUnknown(newValue) && isRecordStringUnknown(existing)) {
    const existingObj = existing;
    const newObj = newValue;
    const result: Record<string, unknown> = { ...existingObj };
    for (const [pattern, value] of Object.entries(newObj)) {
      if (pattern in existingObj && existingObj[pattern] !== value) {
        logger?.warn(
          `Overwriting existing pattern '${pattern}' in ${key}: ${JSON.stringify(existingObj[pattern])} → ${JSON.stringify(value)}`,
        );
      }
      result[pattern] = value;
    }
    merged = result;
  }
  const edits: Edit[] = modify(src, [key], merged, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  return applyEdits(src, edits);
}

type LossyCounters = {
  matchCommandLineDropped: number;
  approveResponseDropped: number;
  editsApprovePatternsImportedAsEditOnly: number;
  mcpAccessSkipped: { skipped: boolean; value: unknown };
};

function parseTerminalApprove(
  value: unknown,
  lossy: LossyCounters,
): Record<string, PermissionAction> | undefined {
  if (!isRecordStringUnknown(value)) return undefined;
  const result: Record<string, PermissionAction> = {};
  for (const [pattern, entry] of Object.entries(value)) {
    if (entry === null) continue;
    if (typeof entry === "boolean") {
      result[pattern] = entry ? "allow" : "deny";
      continue;
    }
    if (isRecordStringUnknown(entry) && typeof entry.approve === "boolean") {
      if (entry.matchCommandLine !== undefined) {
        lossy.matchCommandLineDropped += 1;
      }
      result[pattern] = entry.approve ? "allow" : "deny";
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function parseEditsApprove(
  value: unknown,
  lossy: LossyCounters,
): Record<string, PermissionAction> | undefined {
  if (!isRecordStringUnknown(value)) return undefined;
  const result: Record<string, PermissionAction> = {};
  for (const [pattern, v] of Object.entries(value)) {
    if (typeof v !== "boolean") continue;
    result[pattern] = v ? "allow" : "deny";
  }
  const count = Object.keys(result).length;
  if (count > 0) {
    lossy.editsApprovePatternsImportedAsEditOnly += count;
  }
  return count > 0 ? result : undefined;
}

function parseUrlsApprove(
  value: unknown,
  lossy: LossyCounters,
): Record<string, PermissionAction> | undefined {
  if (!isRecordStringUnknown(value)) return undefined;
  const result: Record<string, PermissionAction> = {};
  for (const [pattern, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") {
      result[pattern] = entry ? "allow" : "deny";
      continue;
    }
    if (isRecordStringUnknown(entry) && typeof entry.approveRequest === "boolean") {
      if (entry.approveResponse !== undefined) {
        lossy.approveResponseDropped += 1;
      }
      result[pattern] = entry.approveRequest ? "allow" : "deny";
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
