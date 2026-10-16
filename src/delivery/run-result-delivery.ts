import type { Destination, OutgoingAttachment } from "../types.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { DeliveryStore } from "./delivery-store.ts";
import type { Task, TaskStore } from "../tasks/task-store.ts";
import { SECURITY_QUARANTINE_REFUSAL_TEXT } from "../../plugins/chassis/src/security-quarantine.ts";
import { resolveTurnOrigin } from "../core/turn-origin.ts";

export interface RunResultDelivery {
  destination: Destination;
  text: string;
  attachments?: OutgoingAttachment[];
  idempotencyKey: string;
}

export function runResultDelivery(run: Run, taskList: Task[] = []): RunResultDelivery | null {
  const target = run.request.deliveryTarget;
  const surface = run.request.surface;
  if (!target || !surface) return null;
  const editRef = run.deliveryState?.editRef;
  const destination: Destination = {
    type: surface,
    target,
    ...(editRef ? { editRef } : {}),
    ...(taskList.length ? { taskList: taskList.map(({ id, title, status }) => ({ id, title, status })) } : {}),
  };
  const idempotencyKey = `run:${run.id}`;
  if (
    surface === "slack" &&
    run.result?.status === "refused" &&
    run.result.refusalKind === "security_quarantine" &&
    run.request.addressed
  ) {
    return { destination, text: SECURITY_QUARANTINE_REFUSAL_TEXT, idempotencyKey };
  }
  if (run.request.surfaceTools && run.result?.status !== "failed" && !run.result?.attachments?.length) return null;
  if (run.status === "failed") {
    if (resolveTurnOrigin(run.request).kind === "ambient") return null;
    const reason = run.result?.reason ?? "unknown error";
    return { destination, text: `⚠️ I couldn't finish that turn: ${reason}`, idempotencyKey };
  }
  if (run.result?.status === "ok" && (run.result.reply || run.result.attachments?.length)) {
    return {
      destination,
      text: run.result.reply ?? "",
      ...(run.result.attachments?.length ? { attachments: run.result.attachments } : {}),
      idempotencyKey,
    };
  }
  return null;
}

export async function drainRunResultDeliveries(
  runs: RunStore,
  deliveries: DeliveryStore,
  tasks?: TaskStore,
  now = Date.now(),
): Promise<void> {
  for (const { run } of await runs.pendingDeliveries(now)) {
    try {
      const taskList = tasks ? await tasks.list({ originRunId: run.id }) : [];
      const delivery = runResultDelivery(run, taskList);
      if (!delivery) {
        await runs.resolveDelivery(run.id, "suppressed");
        continue;
      }
      const queued = await deliveries.enqueue(delivery);
      await runs.resolveDelivery(run.id, queued.deliveredAt !== null ? "acknowledged" : "enqueued");
    } catch (err) {
      console.error(`[delivery] failed to enqueue recovery delivery for run ${run.id}:`, err);
      try {
        await runs.retryDelivery(run.id, now);
      } catch (retryError) {
        console.error(`[delivery] failed to defer recovery delivery for run ${run.id}:`, retryError);
      }
    }
  }
}

export function wireRunResultDeliveries(
  runs: RunStore,
  deliveries: DeliveryStore,
  tasks?: TaskStore,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  const drain = (): Promise<void> => {
    if (!inFlight)
      inFlight = drainRunResultDeliveries(runs, deliveries, tasks).finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  let accelerated = false;
  const accelerate = (): void => {
    if (inFlight) {
      accelerated = true;
      return;
    }
    void drain()
      .catch((err) => console.error("[delivery] recovery drain failed:", err))
      .finally(() => {
        if (accelerated) {
          accelerated = false;
          accelerate();
        }
      });
  };
  runs.onTerminal(accelerate);
  accelerate();
  return drain;
}
