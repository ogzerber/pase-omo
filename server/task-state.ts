import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { agentDir } from "./provider/omo-store.js";

/**
 * The OmO task-state tree has two readers inside this plugin: the snapshot RPCs
 * (`server/dag`) and the timeline publisher (`server/chat`). They were separate
 * plugins before the merge and disagreed — the snapshot side honoured
 * `PASEO_OMO_TASK_STATE_DIR` while the publisher hardcoded the workspace path,
 * so with the override set one reader saw runs the other could not. Both now
 * resolve the directory here.
 */

/** An override is only an override when it names something. */
function named(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

/** Hex digits of the workspace hash OmO appends to a project directory name. */
const PROJECT_KEY_LENGTH = 12;

/**
 * Where OmO 5.1 keeps a workspace's task state: `<agent dir>/projects/<name>-<key>/senpi-task`.
 *
 * `<key>` is the first 12 hex digits of the SHA-256 of the workspace path, and
 * `<name>` is a sanitised folder name. Only the key is matched: the name's
 * sanitising rules are not documented, and the key alone identifies the
 * workspace. The path is tried as given and with symlinks resolved, because
 * OmO may hash either form. Returns undefined when OmO has not written there.
 */
function agentProjectStateDir(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const paths = new Set([resolve(cwd)]);
  try {
    paths.add(realpathSync(resolve(cwd)));
  } catch {
    // A workspace that no longer exists can still have state worth reading.
  }
  const suffixes = [...paths].map(
    (path) => `-${createHash("sha256").update(path).digest("hex").slice(0, PROJECT_KEY_LENGTH)}`,
  );
  const projects = join(agentDir(env), "projects");
  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!suffixes.some((suffix) => entry.endsWith(suffix))) continue;
    const candidate = join(projects, entry, "senpi-task");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Root of the task-state tree for a workspace.
 *
 * `PASEO_OMO_TASK_STATE_DIR` wins; `OMO_HERDR_DAG_TASK_STATE_DIR` is the older
 * name kept working for deployments that already set it. An empty or
 * whitespace-only value is ignored rather than resolved, which would otherwise
 * silently redirect the whole store to the process working directory.
 *
 * Without an override, OmO 5.1's per-project directory under the agent dir is
 * used when it exists, and the workspace's own `.omo/senpi-task` otherwise.
 * The per-project directory goes first because a newer OmO writes only there,
 * so a `.omo/senpi-task` left behind by an older one would otherwise shadow it.
 */
export function taskStateDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = named(env.PASEO_OMO_TASK_STATE_DIR) ?? named(env.OMO_HERDR_DAG_TASK_STATE_DIR);
  if (override !== undefined) return resolve(override);
  return agentProjectStateDir(cwd, env) ?? resolve(join(resolve(cwd), ".omo", "senpi-task"));
}

/** Directory holding one JSON file per DAG run. */
export function dagRunsDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(taskStateDir(cwd, env), "dag", "runs");
}
