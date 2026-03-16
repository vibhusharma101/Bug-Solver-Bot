import { Octokit } from "octokit";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ---- Client ---------------------------------------------------------------

const octokit = new Octokit({ auth: config.github.token });

const repo = {
  owner: config.github.owner,
  repo: config.github.repo,
};

// ---- File Operations ------------------------------------------------------

/** Fetch the raw content of a file from the repo */
export async function getFileContent(
  filePath: string,
  ref = config.github.baseBranch
): Promise<{ content: string; sha: string } | null> {
  try {
    const response = await octokit.rest.repos.getContent({
      ...repo,
      path: filePath,
      ref,
    });

    const data = response.data;
    if (Array.isArray(data) || data.type !== "file") {
      logger.warn(`Path is a directory, not a file: ${filePath}`);
      return null;
    }

    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content, sha: data.sha };
  } catch (err: unknown) {
    if (isNotFoundError(err)) {
      logger.warn(`File not found in repo: ${filePath}`);
      return null;
    }
    throw err;
  }
}

/** List the top-level structure of the repo for context */
export async function getRepoStructure(): Promise<string[]> {
  try {
    const response = await octokit.rest.repos.getContent({
      ...repo,
      path: "",
      ref: config.github.baseBranch,
    });
    const data = Array.isArray(response.data) ? response.data : [response.data];
    return data.map((item: { type: string; name: string }) => `${item.type === "dir" ? "📁" : "📄"} ${item.name}`);
  } catch {
    return [];
  }
}

// ---- Branch Operations ----------------------------------------------------

/** Get the latest commit SHA of the base branch */
async function getBaseSha(): Promise<string> {
  const ref = await octokit.rest.git.getRef({
    ...repo,
    ref: `heads/${config.github.baseBranch}`,
  });
  return ref.data.object.sha;
}

/** Create a new branch off the base branch. Returns true if created, false if already exists. */
export async function createBranch(branchName: string): Promise<boolean> {
  const sha = await getBaseSha();

  try {
    await octokit.rest.git.createRef({
      ...repo,
      ref: `refs/heads/${branchName}`,
      sha,
    });
    logger.info(`Created branch: ${branchName}`);
    return true;
  } catch (err: unknown) {
    if (isAlreadyExistsError(err)) {
      logger.info(`Branch already exists: ${branchName}, reusing it`);
      return false;
    }
    throw err;
  }
}

// ---- Commit Operations ----------------------------------------------------

/** Commit updated file content to a branch */
export async function commitFileFix(
  branchName: string,
  filePath: string,
  newContent: string,
  commitMessage: string,
  existingSha?: string
): Promise<void> {
  logger.info(`Committing fix to ${filePath} on branch ${branchName}`);

  await octokit.rest.repos.createOrUpdateFileContents({
    ...repo,
    path: filePath,
    message: commitMessage,
    content: Buffer.from(newContent).toString("base64"),
    branch: branchName,
    ...(existingSha ? { sha: existingSha } : {}),
  });
}

// ---- Pull Request ---------------------------------------------------------

export interface PullRequestResult {
  url: string;
  number: number;
}

/** Open a Pull Request and return its URL */
export async function openPullRequest(
  branchName: string,
  title: string,
  body: string
): Promise<PullRequestResult> {
  logger.info(`Opening PR: "${title}"`);

  const pr = await octokit.rest.pulls.create({
    ...repo,
    title,
    body,
    head: branchName,
    base: config.github.baseBranch,
  });

  logger.info(`PR created: ${pr.data.html_url}`);
  return { url: pr.data.html_url, number: pr.data.number };
}

// ---- Helpers --------------------------------------------------------------

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}

function isAlreadyExistsError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    (err as { status: number }).status === 422
  );
}
