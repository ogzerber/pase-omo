import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalResponseSchema,
  ListPendingApprovalsPayloadSchema,
  listPendingApprovalsRpc,
  submitApprovalResponseRpc,
  type ApprovalResponse,
} from "../../shared/approval.js";
import {
  listPendingApprovals,
  registerApprovalHandlers,
  submitApprovalResponse,
} from "./approval.js";
import { OmoSession, questionForm } from "./omo-session.js";

interface MockProcessInstance {
  emit(event: Record<string, unknown>): void;
  notify: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

const processState = vi.hoisted(() => ({
  instances: [] as MockProcessInstance[],
}));

vi.mock("./omo-process.js", () => {
  class OmoProcess {
    readonly notify = vi.fn();
    readonly stop = vi.fn();
    private readonly onEvent: (event: Record<string, unknown>) => void;

    constructor(options: { onEvent(event: Record<string, unknown>): void }) {
      this.onEvent = options.onEvent;
      processState.instances.push(this);
    }

    emit(event: Record<string, unknown>): void {
      this.onEvent(event);
    }

    start(): void {}

    async call<T>(): Promise<T> {
      return {} as T;
    }
  }

  return { OmoProcess };
});

const sessions: OmoSession[] = [];

function createSession(sessionId = "provider-session-1"): {
  process: MockProcessInstance;
  session: OmoSession;
  emit: ReturnType<typeof vi.fn>;
} {
  const emit = vi.fn();
  const session = new OmoSession({
    paseoSessionId: sessionId,
    launch: { command: "omo", base: [], origin: "test" },
    config: {
      cwd: "E:/workspace",
      env: {},
      mcpServers: {},
      settings: {},
      persist: true,
    },
    capabilities: ["permission"],
    emit,
    log: vi.fn(),
    onRuntimeFailure: vi.fn(),
  });
  sessions.push(session);
  const process = processState.instances.at(-1);
  if (!process) throw new Error("Missing mocked OmO process");
  return { process, session, emit };
}

function context(agentId: string, runtimeSessionId = "provider-session-1"): PluginHandlerContext {
  return {
    paseo: {
      agents: {
        ref: vi.fn(() => ({
          current: () => ({ id: agentId, runtimeInfo: { sessionId: runtimeSessionId } }),
          refresh: vi.fn(),
        })),
      },
    },
  } as unknown as PluginHandlerContext;
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.close();
  processState.instances.length = 0;
  vi.clearAllMocks();
});

describe("approval RPC handlers", () => {
  it("lists confirm, select, and question requests for the live agent session", async () => {
    const { process } = createSession();
    process.emit({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Apply changes?",
      message: "The files will be updated.",
    });
    process.emit({
      type: "extension_ui_request",
      id: "select-1",
      method: "select",
      title: "Choose environment",
      options: ["Staging", "Production"],
    });
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [
        {
          id: "deploy_region",
          header: "Region",
          question: "Which region should be used?",
          options: [{ label: "Use nearest" }],
          multiSelect: false,
        },
      ],
    });

    await expect(listPendingApprovals({ agentId: "agent-1" }, context("agent-1"))).resolves.toEqual({
      requests: [
        { id: "confirm-1", method: "confirm", title: "Apply changes?", options: [] },
        {
          id: "select-1",
          method: "select",
          title: "Choose environment",
          options: [
            { action: "option-0", label: "Staging" },
            { action: "option-1", label: "Production" },
          ],
        },
        {
          id: "question-1",
          method: "question",
          title: "Which region should be used?",
          options: [{ action: "option-0", label: "Use nearest" }],
          questionKey: "deploy_region",
          questions: [{
            id: "deploy_region",
            header: "Region",
            question: "Which region should be used?",
            options: [{ label: "Use nearest" }],
            multiSelect: false,
          }],
        },
      ],
    });
  });

  it("answers an agent with no live session with an empty list", async () => {
    // The composer pill asks for every OmO agent the host lists, including ones
    // whose session is closed. Throwing there filled the console with
    // DaemonRpcErrors and froze the pill on its last label; having nothing
    // pending is an answer.
    await expect(
      listPendingApprovals({ agentId: "agent-gone" }, context("agent-gone", "no-such-session")),
    ).resolves.toEqual({ requests: [] });
  });

  it("puts a free-text answer under the pending question key", async () => {
    const { process } = createSession();
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [
        {
          id: "deploy_region",
          header: "Region",
          question: "Which region should be used?",
          options: [],
          multiSelect: false,
        },
      ],
    });

    await expect(
      submitApprovalResponse(
        {
          agentId: "agent-1",
          requestId: "question-1",
          response: { behavior: "allow", answer: "ap-northeast-2" },
        },
        context("agent-1"),
      ),
    ).resolves.toEqual({ submitted: true });

    expect(process.notify).toHaveBeenCalledTimes(1);
    expect(process.notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "question-1",
      answers: {
        deploy_region: { selected: [], text: "ap-northeast-2" },
      },
    });
  });

  it("rejects an unknown request id instead of silently ignoring it", async () => {
    createSession();

    await expect(
      submitApprovalResponse(
        {
          agentId: "agent-1",
          requestId: "missing-request",
          response: { behavior: "deny" },
        },
        context("agent-1"),
      ),
    ).rejects.toThrow(/Unknown pending OmO UI request: missing-request/);
  });

  const questions = [
    {
      id: "features",
      header: "기능",
      question: "어떤 기능을 사용할까요?",
      options: Array.from({ length: 12 }, (_, index) => ({ label: `feature-${index}`, description: `description-${index}` })),
      multiSelect: true,
    },
    { id: "region", header: "지역", question: "어느 지역인가요?", options: [{ label: "서울" }, { label: "부산" }], multiSelect: false },
    { id: "notes", header: "메모", question: "추가 요청이 있나요?", options: [], multiSelect: false },
  ];
  const answers = {
    features: { selected: ["feature-0", "feature-11"], text: "  추가 설명\n" },
    region: { selected: ["서울"] },
    notes: { selected: [], text: "  자유 입력\n" },
  };

  it("roundtrips every question and structured answer through approval RPC schemas", async () => {
    const { process, session, emit } = createSession();
    process.emit({ type: "extension_ui_request", id: "multi", method: "question", questions });
    const payload = ListPendingApprovalsPayloadSchema.parse(await listPendingApprovals({ agentId: "agent-1" }, context("agent-1")));
    expect(payload.requests[0]?.questions).toEqual(questions);
    expect(payload.requests[0]?.options).toHaveLength(12);
    const permission = emit.mock.calls.find(([event]) => event.type === "session.permission")?.[0];
    expect(permission.request.input).toEqual(questionForm(questions).input);
    const response = ApprovalResponseSchema.parse({ behavior: "allow", answers, comment: "  전체 의견\n" });
    await expect(submitApprovalResponse({ agentId: "agent-1", requestId: "multi", response }, context("agent-1"))).resolves.toEqual({ submitted: true });
    expect(process.notify).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "multi", answers, comment: "  전체 의견\n" });
    expect(session.getPendingUiRequests()).toEqual([]);
    expect(emit.mock.calls.filter(([event]) => event.type === "session.permission_resolved")).toHaveLength(1);
  });

  it("roundtrips native updatedInput without losing answers or comment", () => {
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "multi", method: "question", questions });
    session.respondToPermission("multi", { behavior: "allow", updatedInput: { answers, comment: "  의견\n" } });
    expect(process.notify).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "multi", answers, comment: "  의견\n" });
    expect(session.getPendingUiRequests()).toEqual([]);
  });

  it.each([
    { answers: { notes: { selected: [], text: "부분 답변" } } },
    { answers: {}, comment: "답변 대신 의견" },
  ])("allows Senpi partial and comment-only replies %#", (reply) => {
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "multi", method: "question", questions });
    session.respondToUiRequest("multi", ApprovalResponseSchema.parse({ behavior: "allow", ...reply }));
    expect(process.notify).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "multi", ...reply });
  });

  it.each([
    { answers: { unknown: { selected: [], text: "wrong key" } } },
    { answers: { features: { selected: ["unknown"] } } },
    { answers: { features: { selected: ["feature-0", "feature-0"] } } },
    { answers: { region: { selected: ["서울", "부산"] } } },
    { answers: { notes: { selected: [], text: " " } } },
    { answers: { notes: { selected: "bad type" } } },
    { answers: { notes: { selected: [], text: "valid", extra: true } } },
  ])("keeps invalid structured replies pending on both response surfaces %#", (updatedInput) => {
    const { process, session, emit } = createSession();
    process.emit({ type: "extension_ui_request", id: "multi", method: "question", questions });
    const before = session.getPendingUiRequests();
    expect(() => session.respondToPermission("multi", { behavior: "allow", updatedInput })).toThrow();
    expect(() => session.respondToUiRequest("multi", { behavior: "allow", ...updatedInput } as ApprovalResponse)).toThrow();
    expect(session.getPendingUiRequests()).toEqual(before);
    expect(process.notify).not.toHaveBeenCalled();
    expect(emit.mock.calls.filter(([event]) => event.type === "session.permission_resolved")).toEqual([]);
    session.respondToUiRequest("multi", ApprovalResponseSchema.parse({ behavior: "allow", answers }));
    expect(process.notify).toHaveBeenCalledTimes(1);
  });

  it("does not let legacy single answers discard remaining questions", () => {
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "multi", method: "question", questions });
    for (const response of [{ behavior: "allow", action: "option-0" }, { behavior: "allow", answer: "text" }] as const) {
      expect(() => session.respondToUiRequest("multi", response)).toThrow();
    }
    expect(() => session.respondToPermission("multi", { behavior: "allow", selectedActionId: "option-0" })).toThrow();
    expect(process.notify).not.toHaveBeenCalled();
    expect(session.getPendingUiRequests()).toHaveLength(1);
  });

  it("preserves single-question option compatibility beyond eight options", () => {
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "single", method: "question", questions: [questions[0]] });
    session.respondToPermission("single", { behavior: "allow", selectedActionId: "option-11" });
    expect(process.notify).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "single", answers: { features: { selected: ["feature-11"] } } });
  });

  it("retains pending native selections after an invalid action", () => {
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "select", method: "select", options: ["one"] });
    expect(() => session.respondToPermission("select", { behavior: "allow", selectedActionId: "missing" })).toThrow();
    expect(process.notify).not.toHaveBeenCalled();
    expect(session.getPendingUiRequests()).toHaveLength(1);
    session.respondToPermission("select", { behavior: "allow", selectedActionId: "option-0" });
    expect(process.notify).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "select", value: "one" });
  });

  it("rejects structured answers for confirmation and selection requests", () => {
    const { process, session } = createSession();
    for (const method of ["confirm", "select"] as const) {
      process.emit({ type: "extension_ui_request", id: method, method, options: ["one"] });
      expect(() => session.respondToUiRequest(method, ApprovalResponseSchema.parse({ behavior: "allow", answers }))).toThrow();
      expect(() => session.respondToPermission(method, { behavior: "allow", updatedInput: { answers } })).toThrow();
    }
    expect(process.notify).not.toHaveBeenCalled();
    expect(session.getPendingUiRequests()).toHaveLength(2);
  });

  it("cancels a whole multi-question request", () => {
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "multi", method: "question", questions });
    session.respondToPermission("multi", { behavior: "deny" });
    expect(process.notify).toHaveBeenCalledExactlyOnceWith({ type: "extension_ui_response", id: "multi", cancelled: true });
    expect(session.getPendingUiRequests()).toEqual([]);
  });

  it("gives Paseo's question card every question and maps its answers back by id", () => {
    // Paseo draws a kind:"question" permission from request.input alone; without
    // it the card rendered empty with no way to answer.
    const { process, session, emit } = createSession();
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [
        {
          id: "region",
          header: "Region",
          question: "Which region?",
          options: [{ label: "Seoul", description: "ap-northeast-2" }, { label: "Tokyo" }],
          multiSelect: false,
        },
        {
          id: "checks",
          header: "Checks",
          question: "Which checks?",
          options: [{ label: "Lint" }, { label: "Unit, fast" }, { label: "E2E" }],
          multiSelect: true,
        },
        { id: "notes", header: "Region", question: "Anything else?", options: [], multiSelect: false },
      ],
    });

    const permission = emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "session.permission");
    expect(permission.request.kind).toBe("question");
    expect(permission.request.input).toEqual({
      questions: [
        {
          question: "Which region?",
          header: "Region",
          options: [{ label: "Seoul", description: "ap-northeast-2" }, { label: "Tokyo" }],
          multiSelect: false,
          allowOther: true,
        },
        {
          question: "Which checks?",
          header: "Checks",
          options: [{ label: "Lint" }, { label: "Unit, fast" }, { label: "E2E" }],
          multiSelect: true,
          allowOther: true,
        },
        { question: "Anything else?", header: "Region (2)", options: [], multiSelect: false, allowOther: true },
      ],
    });

    // The card's submission: the request input plus one string per header.
    session.respondToPermission("question-1", {
      behavior: "allow",
      updatedInput: {
        ...permission.request.input,
        answers: { Region: "Seoul", Checks: "Lint, Unit, fast, also smoke", "Region (2)": "ship it" },
      },
    });

    expect(process.notify).toHaveBeenCalledTimes(1);
    expect(process.notify).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "question-1",
      answers: {
        region: { selected: ["Seoul"] },
        checks: { selected: ["Lint", "Unit, fast"], text: "also smoke" },
        notes: { selected: [], text: "ship it" },
      },
    });
  });

  it("gives Paseo's question card every select option and returns the chosen label as the value", () => {
    const { process, session, emit } = createSession();
    const options = ["A", "B", "C", "D", "E", "F", "G", "H", "Production"];
    process.emit({ type: "extension_ui_request", id: "select-1", method: "select", title: "Choose environment", options });

    const permission = emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === "session.permission");
    expect(permission.request.kind).toBe("question");
    expect(permission.request.input).toEqual({
      questions: [
        {
          question: "Choose environment",
          header: "선택",
          options: options.map((label) => ({ label })),
          multiSelect: false,
          allowOther: false,
        },
      ],
    });

    session.respondToPermission("select-1", {
      behavior: "allow",
      updatedInput: { ...permission.request.input, answers: { "선택": "Production" } },
    });
    expect(process.notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "select-1", value: "Production" });
  });

  it("cancels a select the card answers with a value OmO never offered", () => {
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "select-1", method: "select", title: "Pick", options: ["A", "B"] });

    session.respondToPermission("select-1", { behavior: "allow", updatedInput: { answers: { "선택": "Z" } } });

    expect(process.notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "select-1", cancelled: true });
  });

  it("cancels a question the card submits with no answers instead of leaving OmO waiting", () => {
    const { process, session } = createSession();
    process.emit({
      type: "extension_ui_request",
      id: "question-1",
      method: "question",
      questions: [{ id: "region", header: "Region", question: "Which region?", options: [], multiSelect: false }],
    });

    session.respondToPermission("question-1", { behavior: "allow", updatedInput: { answers: {} } });

    expect(process.notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "question-1", cancelled: true });
  });

  it("preserves a question id that is also an Object prototype key", () => {
    // Given an OmO question with an unrestricted string id.
    const { process, session } = createSession();
    process.emit({
      type: "extension_ui_request", id: "prototype-question", method: "question",
      questions: [{ id: "__proto__", header: "Choice", question: "Pick", options: [{ label: "A" }], multiSelect: false }],
    });

    // When the native card submits its answer.
    session.respondToPermission("prototype-question", {
      behavior: "allow", updatedInput: { answers: { Choice: "A" } },
    });

    // Then the answer remains an own JSON key rather than changing the map prototype.
    expect(process.notify).toHaveBeenCalledWith({
      type: "extension_ui_response", id: "prototype-question",
      answers: { ["__proto__"]: { selected: ["A"] } },
    });
  });

  it.each([undefined, {}, { answers: [] }])("cancels a select without a valid card answer (%j)", (updatedInput) => {
    // Given a pending native selection with no legacy action chosen.
    const { process, session } = createSession();
    process.emit({ type: "extension_ui_request", id: "select-empty", method: "select", options: ["A"] });

    // When an empty or malformed submission crosses the permission boundary.
    session.respondToPermission("select-empty", {
      behavior: "allow", ...(updatedInput ? { updatedInput } : {}),
    });

    // Then OmO receives cancellation, never a value it did not offer.
    expect(process.notify).toHaveBeenCalledWith({ type: "extension_ui_response", id: "select-empty", cancelled: true });
  });

  it("registers both approval RPC handlers for entry wiring", () => {
    const contracts: string[] = [];
    const server = {
      handle: vi.fn((contract) => {
        contracts.push(contract.name);
      }),
    } as unknown as Pick<PluginServerContext, "handle">;

    const cleanup = registerApprovalHandlers(server);

    expect(contracts).toEqual([listPendingApprovalsRpc.name, submitApprovalResponseRpc.name]);
    expect(typeof cleanup).toBe("function");
  });
});
