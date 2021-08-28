import { EventEmitter } from "events";
import { Logger } from "pino";
import { IClient, IState, Reason, StateEvent } from "@walletconnect/types";
import { ERROR, getNestedContext } from "@walletconnect/utils";

import { STATE_EVENTS } from "../constants";
import { generateChildLogger } from "@walletconnect/logger";

export class State<Sequence = any> extends IState<Sequence> {
  public sequences = new Map<string, Sequence>();

  public events = new EventEmitter();

  private cached: Sequence[] = [];

  constructor(public client: IClient, public logger: Logger, public context: string) {
    super(client, logger, context);
    this.logger = generateChildLogger(logger, this.context);

    this.registerEventListeners();
  }

  public async init(): Promise<void> {
    this.logger.trace(`Initialized`);
    await this.restore();
  }

  get length(): number {
    return this.sequences.size;
  }

  get topics(): string[] {
    return Array.from(this.sequences.keys());
  }

  get values(): Sequence[] {
    return Array.from(this.sequences.values());
  }

  public async set(topic: string, sequence: Sequence): Promise<void> {
    await this.isInitialized();
    if (this.sequences.has(topic)) {
      this.update(topic, sequence);
    } else {
      this.logger.debug(`Setting sequence`);
      this.logger.trace({ type: "method", method: "set", topic, sequence });
      this.sequences.set(topic, sequence);
      this.events.emit(STATE_EVENTS.created, {
        topic,
        sequence,
      } as StateEvent.Created<Sequence>);
    }
  }

  public async get(topic: string): Promise<Sequence> {
    await this.isInitialized();
    this.logger.debug(`Getting sequence`);
    this.logger.trace({ type: "method", method: "get", topic });
    const sequence = await this.getState(topic);
    return sequence;
  }

  public async update(topic: string, update: Partial<Sequence>): Promise<void> {
    await this.isInitialized();
    this.logger.debug(`Updating sequence`);
    this.logger.trace({ type: "method", method: "update", topic, update });
    const sequence = { ...(await this.getState(topic)), ...update };
    this.sequences.set(topic, sequence);
    this.events.emit(STATE_EVENTS.updated, {
      topic,
      sequence,
      update,
    } as StateEvent.Updated<Sequence>);
  }

  public async delete(topic: string, reason: Reason): Promise<void> {
    await this.isInitialized();
    if (!this.sequences.has(topic)) return;
    this.logger.debug(`Deleting sequence`);
    this.logger.trace({ type: "method", method: "delete", topic, reason });
    const sequence = await this.getState(topic);
    this.sequences.delete(topic);
    this.events.emit(STATE_EVENTS.deleted, {
      topic,
      sequence,
      reason,
    } as StateEvent.Deleted<Sequence>);
  }

  public on(event: string, listener: any): void {
    this.events.on(event, listener);
  }

  public once(event: string, listener: any): void {
    this.events.once(event, listener);
  }

  public off(event: string, listener: any): void {
    this.events.off(event, listener);
  }

  public removeListener(event: string, listener: any): void {
    this.events.removeListener(event, listener);
  }

  public getNestedContext() {
    return getNestedContext(this.logger);
  }

  // ---------- Private ----------------------------------------------- //

  private async getState(topic: string): Promise<Sequence> {
    await this.isInitialized();
    const sequence = this.sequences.get(topic);
    if (!sequence) {
      const error = ERROR.NO_MATCHING_TOPIC.format({
        context: this.getNestedContext(),
        topic,
      });
      this.logger.error(error.message);
      throw new Error(error.message);
    }
    return sequence;
  }

  private async persist() {
    await this.client.storage.setSequenceState(this.getNestedContext(), this.values);
    this.events.emit(STATE_EVENTS.sync);
  }

  private async restore() {
    try {
      const persisted = await this.client.storage.getSequenceState(this.getNestedContext());
      if (typeof persisted === "undefined") return;
      if (!persisted.length) return;
      if (this.sequences.size) {
        const error = ERROR.RESTORE_WILL_OVERRIDE.format({
          context: this.getNestedContext(),
        });
        this.logger.error(error.message);
        throw new Error(error.message);
      }
      this.cached = persisted;
      this.cached.forEach(sequence => this.sequences.set((sequence as any).topic, sequence));
      await this.onInit();
      this.logger.debug(`Successfully Restored sequences for ${this.getNestedContext()}`);
      this.logger.trace({ type: "method", method: "restore", sequences: this.values });
    } catch (e) {
      this.logger.debug(`Failed to Restore sequences for ${this.getNestedContext()}`);
      this.logger.error(e);
    }
  }

  private async isInitialized(): Promise<void> {
    if (!this.cached.length) return;
    return new Promise(resolve => {
      this.events.once(STATE_EVENTS.init, () => resolve());
    });
  }

  private async onInit(): Promise<void> {
    this.cached = [];
    this.events.emit(STATE_EVENTS.init);
  }

  private registerEventListeners(): void {
    this.events.on(STATE_EVENTS.created, (createdEvent: StateEvent.Created<Sequence>) => {
      const eventName = STATE_EVENTS.created;
      this.logger.info(`Emitting ${eventName}`);
      this.logger.debug({ type: "event", event: eventName, data: createdEvent });
      this.persist();
    });
    this.events.on(STATE_EVENTS.updated, (updatedEvent: StateEvent.Updated<Sequence>) => {
      const eventName = STATE_EVENTS.updated;
      this.logger.info(`Emitting ${eventName}`);
      this.logger.debug({ type: "event", event: eventName, data: updatedEvent });
      this.persist();
    });
    this.events.on(STATE_EVENTS.deleted, (deletedEvent: StateEvent.Deleted<Sequence>) => {
      const eventName = STATE_EVENTS.deleted;
      this.logger.info(`Emitting ${eventName}`);
      this.logger.debug({ type: "event", event: eventName, data: deletedEvent });
      this.persist();
    });
  }
}