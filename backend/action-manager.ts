import {
  clickActionResultSchema,
  extractActionResultSchema,
  navigateActionResultSchema,
  typeActionResultSchema,
  type ActionRequest,
  type ActionResult,
} from "../shared/action";
import { stepEventSchema, type StepEvent } from "../shared/event";
import type { Session } from "../shared/session";
import type { Task } from "../shared/task";
import { ActionError } from "./action-errors";
import type { BrowserPage, BrowserSessionContext } from "./browser-launcher";
import type { EventBus } from "./event-bus";
import { createProfileLock } from "./profile-lock";

const NAVIGATION_TIMEOUT_MS = 30_000;
const ELEMENT_TIMEOUT_MS = 10_000;

export type ActionSessionSource = {
  get(sessionId: string): Session | null;
  getContext(sessionId: string): BrowserSessionContext | null;
};

export type ActionTaskSource = {
  getTask(taskId: string): Task | null;
};

export type ActionService = {
  execute(sessionId: string, request: ActionRequest): Promise<ActionResult>;
};

export type ActionManagerOptions = {
  readonly sessions: ActionSessionSource;
  readonly tasks: ActionTaskSource;
  readonly events: EventBus;
  readonly now?: () => Date;
};

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

class ActionManagerImpl implements ActionService {
  private readonly sessions: ActionSessionSource;
  private readonly tasks: ActionTaskSource;
  private readonly events: EventBus;
  private readonly now: () => Date;
  private readonly lock = createProfileLock();

  constructor(options: ActionManagerOptions) {
    this.sessions = options.sessions;
    this.tasks = options.tasks;
    this.events = options.events;
    this.now = options.now ?? (() => new Date());
  }

  async execute(sessionId: string, request: ActionRequest): Promise<ActionResult> {
    return this.lock.run(sessionId, () => this.run(sessionId, request));
  }

  private async run(sessionId: string, request: ActionRequest): Promise<ActionResult> {
    const session = this.sessions.get(sessionId);
    if (session === null) {
      throw new ActionError("action_session_not_found");
    }

    const context = this.sessions.getContext(sessionId);
    if (session.status !== "ready" || context === null) {
      throw new ActionError("action_session_not_ready");
    }

    if (request.taskId !== undefined) {
      const task = this.tasks.getTask(request.taskId);
      if (task === null || task.sessionId !== sessionId) {
        throw new ActionError("action_task_not_found");
      }
      if (task.status !== "running") {
        throw new ActionError("action_task_not_running");
      }
    }

    try {
      const page = await this.resolvePage(context);
      const result = await this.perform(page, request);
      this.publishStep(request, result);
      return result;
    } catch (error) {
      if (error instanceof ActionError) {
        console.warn(`Action failed: ${sessionId}: ${error.code}`);
        throw error;
      }
      console.warn(`Action failed: ${sessionId}: action_failed (${errorName(error)})`);
      throw new ActionError("action_failed");
    }
  }

  private async resolvePage(context: BrowserSessionContext): Promise<BrowserPage> {
    const page = context.pages().at(-1);
    return page ?? context.newPage();
  }

  private async perform(page: BrowserPage, request: ActionRequest): Promise<ActionResult> {
    switch (request.action) {
      case "navigate": {
        try {
          await page.goto(request.url, { timeout: NAVIGATION_TIMEOUT_MS });
        } catch {
          throw new ActionError("action_navigation_failed");
        }
        return navigateActionResultSchema.parse({
          action: "navigate",
          url: page.url(),
        });
      }
      case "click": {
        try {
          await page.locator(request.selector).click({ timeout: ELEMENT_TIMEOUT_MS });
        } catch (error) {
          throw this.elementFailure(error);
        }
        return clickActionResultSchema.parse({
          action: "click",
          selector: request.selector,
        });
      }
      case "type": {
        try {
          await page.locator(request.selector).fill(request.text, {
            timeout: ELEMENT_TIMEOUT_MS,
          });
        } catch (error) {
          throw this.elementFailure(error);
        }
        return typeActionResultSchema.parse({
          action: "type",
          selector: request.selector,
        });
      }
      case "extract": {
        let value: string;
        try {
          value = await page.locator(request.selector).innerText({
            timeout: ELEMENT_TIMEOUT_MS,
          });
        } catch (error) {
          throw this.elementFailure(error);
        }
        return extractActionResultSchema.parse({
          action: "extract",
          selector: request.selector,
          value,
        });
      }
    }
  }

  private elementFailure(error: unknown): ActionError {
    return new ActionError(isTimeoutError(error) ? "action_target_not_found" : "action_failed");
  }

  private publishStep(request: ActionRequest, result: ActionResult): void {
    const at = this.now().toISOString();
    const taskId = request.taskId ?? null;

    switch (result.action) {
      case "navigate":
        this.publish({ type: "step", taskId, action: "navigate", url: result.url, at });
        return;
      case "click":
      case "type":
        this.publish({
          type: "step",
          taskId,
          action: result.action,
          selector: result.selector,
          at,
        });
        return;
      case "extract":
        this.publish({ type: "step", taskId, action: "extract", selector: result.selector, at });
        return;
    }
  }

  private publish(event: StepEvent): void {
    this.events.publish(stepEventSchema.parse(event));
  }
}

export function createActionManager(options: ActionManagerOptions): ActionService {
  return new ActionManagerImpl(options);
}
