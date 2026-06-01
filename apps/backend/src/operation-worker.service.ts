import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { OperationService } from "./operation.service";

const OPERATION_WORKER_POLL_INTERVAL_MS = 3 * 1000;

@Injectable()
export class OperationWorkerService implements OnModuleInit, OnApplicationShutdown {
  private timer: NodeJS.Timeout | null = null;
  private tickPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly operationService: OperationService) {}

  onModuleInit(): void {
    const startupTimer = setTimeout(() => this.start(), 0);
    startupTimer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }

    this.timer = setInterval(() => {
      void this.drain();
    }, OPERATION_WORKER_POLL_INTERVAL_MS);
    this.timer.unref?.();
    void this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.tickPromise;
  }

  async pollOnce(): Promise<boolean> {
    return this.operationService.pollOnce();
  }

  private async drain(): Promise<void> {
    if (this.tickPromise) {
      return this.tickPromise;
    }

    this.tickPromise = this.drainInternal()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[OperationWorkerService] worker tick failed: ${message}`);
      })
      .finally(() => {
        this.tickPromise = null;
      });

    return this.tickPromise;
  }

  private async drainInternal(): Promise<void> {
    while (!this.stopped) {
      const didWork = await this.operationService.pollOnce();
      if (!didWork) {
        return;
      }
    }
  }
}
