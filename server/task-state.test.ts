import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { dagRunsDir, taskStateDir } from "./task-state.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * The DAG runs tree has two readers: the snapshot RPCs (server/dag) and the
 * timeline publisher (server/chat). Before the merge only the first honoured
 * PASEO_OMO_TASK_STATE_DIR, so with the override set one reader saw runs the
 * other could not.
 */
test("an override redirects the runs directory for every reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");
  const override = join(root, "elsewhere");

  expect(taskStateDir(cwd, {})).toBe(resolve(join(cwd, ".omo", "senpi-task")));
  expect(taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: override })).toBe(resolve(override));
  expect(dagRunsDir(cwd, { PASEO_OMO_TASK_STATE_DIR: override })).toBe(resolve(join(override, "dag", "runs")));
});

test("the legacy OMO_HERDR_DAG_TASK_STATE_DIR name still works, but loses to the current one", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");

  expect(taskStateDir(cwd, { OMO_HERDR_DAG_TASK_STATE_DIR: join(root, "legacy") })).toBe(resolve(join(root, "legacy")));
  expect(
    taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: join(root, "current"), OMO_HERDR_DAG_TASK_STATE_DIR: join(root, "legacy") }),
  ).toBe(resolve(join(root, "current")));
});

test("an empty override is ignored rather than resolving to the process cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");
  expect(taskStateDir(cwd, { PASEO_OMO_TASK_STATE_DIR: "  " })).toBe(resolve(join(cwd, ".omo", "senpi-task")));
});

/**
 * OmO 5.1 moved the tree out of the workspace to
 * `<agent dir>/projects/<name>-<sha256(cwd)[:12]>/senpi-task`. The board read
 * only the workspace path, so a real workflow run showed as "no records".
 */
const keyOf = (path: string) => createHash("sha256").update(path).digest("hex").slice(0, 12);

test("the per-project directory OmO 5.1 writes is found by the workspace hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "My Project");
  const agent = join(root, "agent");
  const state = join(agent, "projects", `My_Project-${keyOf(cwd)}`, "senpi-task");
  await mkdir(state, { recursive: true });
  await mkdir(join(agent, "projects", "other-000000000000", "senpi-task"), { recursive: true });

  const env = { OMO_CODING_AGENT_DIR: agent };
  expect(taskStateDir(cwd, env)).toBe(state);
  expect(dagRunsDir(cwd, env)).toBe(join(state, "dag", "runs"));
});

test("the per-project directory beats a stale workspace one, and an override beats both", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  const state = join(agent, "projects", `project-${keyOf(cwd)}`, "senpi-task");
  await mkdir(state, { recursive: true });
  await mkdir(join(cwd, ".omo", "senpi-task"), { recursive: true });

  const env = { OMO_CODING_AGENT_DIR: agent };
  expect(taskStateDir(cwd, env)).toBe(state);
  expect(taskStateDir(cwd, { ...env, PASEO_OMO_TASK_STATE_DIR: join(root, "elsewhere") })).toBe(join(root, "elsewhere"));
});

test("a workspace OmO has not written for falls back to its own .omo directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "omo-task-state-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agent = join(root, "agent");
  await mkdir(join(agent, "projects", `project-${keyOf(join(root, "elsewhere"))}`, "senpi-task"), { recursive: true });

  expect(taskStateDir(cwd, { OMO_CODING_AGENT_DIR: agent })).toBe(resolve(join(cwd, ".omo", "senpi-task")));
});
