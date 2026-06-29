import { RequestError } from "@octokit/request-error";
import { Octokit } from "@octokit/rest";

import { MAX_FILE_SIZE } from "../constants/rulesync-paths.js";
import type {
  GitHubApiError,
  GitHubClientConfig,
  GitHubFileEntry,
  GitHubGist,
  GitHubRelease,
  GitHubRepoInfo,
} from "../types/fetch.js";
import {
  GitHubFileEntrySchema,
  GitHubGistResponseSchema,
  GitHubReleaseSchema,
  GitHubRepoInfoSchema,
} from "../types/fetch.js";
import { formatError } from "../utils/error.js";
import type { Logger } from "../utils/logger.js";

/**
 * Error class for GitHub API errors
 */
export class GitHubClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly apiError?: GitHubApiError,
  ) {
    super(message);
    this.name = "GitHubClientError";
  }
}

/**
 * Log GitHub auth error hints for 401/403 responses.
 */
export function logGitHubAuthHints(params: { error: GitHubClientError; logger: Logger }): void {
  const { error, logger } = params;
  logger.error(`GitHub API Error: ${error.message}`);
  if (error.statusCode === 401 || error.statusCode === 403) {
    logger.info(
      "Tip: Set GITHUB_TOKEN or GH_TOKEN environment variable for private repositories or better rate limits.",
    );
    logger.info(
      "Tip: If you use GitHub CLI, you can use `GITHUB_TOKEN=$(gh auth token) rulesync fetch ...`",
    );
  }
}

/**
 * Client for interacting with GitHub API using Octokit SDK
 */
export class GitHubClient {
  private readonly octokit: Octokit;
  private readonly hasToken: boolean;
  private readonly token: string | undefined;

  constructor(config: GitHubClientConfig = {}) {
    // Validate custom baseUrl uses HTTPS to prevent token exposure
    if (config.baseUrl && !config.baseUrl.startsWith("https://")) {
      throw new GitHubClientError("GitHub API base URL must use HTTPS");
    }

    this.hasToken = !!config.token;
    this.token = config.token;
    this.octokit = new Octokit({
      auth: config.token,
      baseUrl: config.baseUrl,
    });
  }

  /**
   * Get authentication token from various sources
   */
  static resolveToken(explicitToken?: string): string | undefined {
    if (explicitToken) {
      return explicitToken;
    }
    return process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  }

  /**
   * Get the default branch of a repository
   */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const repoInfo = await this.getRepoInfo(owner, repo);
    return repoInfo.default_branch;
  }

  /**
   * Get repository information
   */
  async getRepoInfo(owner: string, repo: string): Promise<GitHubRepoInfo> {
    try {
      const { data } = await this.octokit.repos.get({ owner, repo });
      const parsed = GitHubRepoInfoSchema.safeParse(data);
      if (!parsed.success) {
        throw new GitHubClientError(
          `Invalid repository info response: ${formatError(parsed.error)}`,
        );
      }
      return parsed.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * List contents of a directory in a repository
   */
  async listDirectory(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitHubFileEntry[]> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      // API returns single object for files, array for directories
      if (!Array.isArray(data)) {
        throw new GitHubClientError(`Path "${path}" is not a directory`);
      }

      const entries: GitHubFileEntry[] = [];
      for (const item of data) {
        const parsed = GitHubFileEntrySchema.safeParse(item);
        if (parsed.success) {
          entries.push(parsed.data);
        }
      }
      return entries;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Get raw file content from a repository
   */
  async getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
        mediaType: {
          format: "raw",
        },
      });

      // When using raw format, data is returned as a string
      if (typeof data === "string") {
        return data;
      }

      // Fallback: if data is an object with content (base64 encoded)
      if (!Array.isArray(data) && "content" in data && data.content) {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }

      throw new GitHubClientError(`Unexpected response format for file content`);
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Check if a file exists and is within size limits
   */
  async getFileInfo(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<GitHubFileEntry | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      // Ensure it's a file, not a directory
      if (Array.isArray(data)) {
        return null; // It's a directory
      }

      const parsed = GitHubFileEntrySchema.safeParse(data);
      if (!parsed.success) {
        return null;
      }

      if (parsed.data.size > MAX_FILE_SIZE) {
        throw new GitHubClientError(
          `File "${path}" exceeds maximum size limit of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        );
      }

      return parsed.data;
    } catch (error: unknown) {
      if (error instanceof RequestError && error.status === 404) {
        return null;
      }
      if (error instanceof GitHubClientError && error.statusCode === 404) {
        return null;
      }
      throw this.handleError(error);
    }
  }

  /**
   * Validate that a repository exists and is accessible
   */
  async validateRepository(owner: string, repo: string): Promise<boolean> {
    try {
      await this.getRepoInfo(owner, repo);
      return true;
    } catch (error) {
      if (error instanceof GitHubClientError && error.statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get a Gist revision with complete file contents.
   */
  async getGist(gistId: string, revision?: string): Promise<GitHubGist> {
    try {
      const { data } = revision
        ? await this.octokit.gists.getRevision({ gist_id: gistId, sha: revision })
        : await this.octokit.gists.get({ gist_id: gistId });
      const parsed = GitHubGistResponseSchema.safeParse(data);
      if (!parsed.success) {
        throw new GitHubClientError(`Invalid Gist response: ${formatError(parsed.error)}`);
      }
      if (parsed.data.truncated) {
        throw new GitHubClientError(
          `Gist ${gistId} contains more files than the GitHub API can return. Use transport "git" instead.`,
        );
      }

      const version = revision
        ? parsed.data.history.find((entry) => entry.version.startsWith(revision))?.version
        : parsed.data.history[0]?.version;
      if (!version || !/^[0-9a-f]{40}$/i.test(version)) {
        throw new GitHubClientError(
          `Gist ${gistId} response did not include a valid revision SHA.`,
        );
      }

      const files = await Promise.all(
        Object.values(parsed.data.files).map(async (file) => ({
          filename: file.filename,
          size: file.size,
          content:
            file.size > MAX_FILE_SIZE
              ? ""
              : !file.truncated && file.content !== undefined
                ? file.content
                : await this.getRawGistFileContent({
                    gistId,
                    filename: file.filename,
                    rawUrl: file.raw_url,
                  }),
        })),
      );

      return { version, files };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  private async getRawGistFileContent(params: {
    gistId: string;
    filename: string;
    rawUrl: string | null;
  }): Promise<string> {
    const { gistId, filename, rawUrl } = params;
    if (!rawUrl) {
      throw new GitHubClientError(
        `Gist ${gistId} file "${filename}" has no inline content or raw URL.`,
      );
    }

    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.hostname !== "gist.githubusercontent.com") {
      throw new GitHubClientError(`Gist ${gistId} file "${filename}" has an unsafe raw URL.`);
    }

    const headers: Record<string, string> = { Accept: "application/vnd.github.raw" };
    if (this.token) headers["Authorization"] = `token ${this.token}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new GitHubClientError(
        `Failed to fetch Gist ${gistId} file "${filename}": HTTP ${response.status}`,
        response.status,
      );
    }
    return await response.text();
  }

  /**
   * Resolve a ref (branch, tag, or SHA) to a full commit SHA.
   */
  async resolveRefToSha(owner: string, repo: string, ref: string): Promise<string> {
    try {
      const { data } = await this.octokit.repos.getCommit({
        owner,
        repo,
        ref,
      });
      return data.sha;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Get the latest release from a repository
   */
  async getLatestRelease(owner: string, repo: string): Promise<GitHubRelease> {
    try {
      const { data } = await this.octokit.repos.getLatestRelease({ owner, repo });
      const parsed = GitHubReleaseSchema.safeParse(data);
      if (!parsed.success) {
        throw new GitHubClientError(`Invalid release info response: ${formatError(parsed.error)}`);
      }
      return parsed.data;
    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Handle errors from Octokit and convert to GitHubClientError
   */
  private handleError(error: unknown): GitHubClientError {
    if (error instanceof GitHubClientError) {
      return error;
    }

    if (error instanceof RequestError) {
      const responseData = error.response?.data;
      const message = this.extractErrorMessage(responseData, error.message);
      const apiError: GitHubApiError | undefined = message ? { message } : undefined;
      const errorMessage = this.getErrorMessage(error.status, apiError);
      return new GitHubClientError(errorMessage, error.status, apiError);
    }

    if (error instanceof Error) {
      return new GitHubClientError(error.message);
    }

    return new GitHubClientError("Unknown error occurred");
  }

  /**
   * Extract error message from response data
   */
  private extractErrorMessage(data: unknown, fallback: string): string {
    if (typeof data === "object" && data !== null && "message" in data) {
      const record = data as Record<string, unknown>;
      const msg = record["message"];
      if (typeof msg === "string") {
        return msg;
      }
    }
    return fallback;
  }

  /**
   * Get human-readable error message for HTTP status codes
   */
  private getErrorMessage(statusCode: number, apiError?: GitHubApiError): string {
    const baseMessage = apiError?.message ?? `HTTP ${statusCode}`;

    switch (statusCode) {
      case 401:
        return `Authentication failed: ${baseMessage}. Check your GitHub token.`;
      case 403:
        if (baseMessage.toLowerCase().includes("rate limit")) {
          return `GitHub API rate limit exceeded. ${this.hasToken ? "Try again later." : "Consider using a GitHub token."}`;
        }
        return `Access forbidden: ${baseMessage}. Check repository permissions.`;
      case 404:
        return `Not found: ${baseMessage}`;
      case 422:
        return `Invalid request: ${baseMessage}`;
      default:
        return `GitHub API error: ${baseMessage}`;
    }
  }
}
