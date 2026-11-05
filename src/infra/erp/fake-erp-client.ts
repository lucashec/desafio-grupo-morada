import type { OrderPayload } from '../../domain/order.js';
import { classifyCreate, classifyLookup, type RawErpResponse } from './classify.js';
import { erpError, type CreateOrderResult, type ErpClient, type LookupResult } from './erp-client.js';

export type CreateScenario =
  | 'success'
  | 'transient'
  | 'permanent'
  | 'timeout'
  | 'processed_then_timeout'
  | 'conflict_found'
  | 'conflict_not_found';

export type LookupScenario = 'auto' | 'unknown';

export interface FakeErpOptions {
  scenarios?: CreateScenario[];
  lookupScenarios?: LookupScenario[];
  /** true (default): the ERP deduplicates by reference. false: every recording call creates a new order. */
  honorsReference?: boolean;
  hooks?: {
    beforeCreateResponds?: (reference: string) => Promise<void>;
    beforeLookupResponds?: (reference: string) => Promise<void>;
  };
  /** Overrides the simulated ERP error text (e.g. oversized messages for truncation tests). */
  errorCode?: string;
  errorMessage?: string;
}

/** Takes the head of the queue; the last scenario repeats forever. */
function next<T>(queue: T[]): T {
  const head = queue.length > 1 ? queue.shift() : queue[0];
  if (head === undefined) throw new Error('FakeErpClient: empty scenario queue');
  return head;
}

/**
 * In-memory ERP double (REQ-ERP-09). No database, no timers: time-related behaviour
 * is simulated by returning the classified outcome, or held with `hang()`.
 */
export class FakeErpClient implements ErpClient {
  readonly registry = new Map<string, string>();
  createCalls = 0;
  lookupCalls = 0;
  /** Orders actually created by the ERP: the "no duplicates" metric. */
  createdCount = 0;

  private readonly scenarios: CreateScenario[];
  private readonly lookupScenarios: LookupScenario[];
  private readonly honorsReference: boolean;
  private readonly hooks: NonNullable<FakeErpOptions['hooks']>;
  private readonly errorCode: string | undefined;
  private readonly errorMessage: string | undefined;
  private pendingHang: Promise<void> | undefined;

  constructor(opts: FakeErpOptions = {}) {
    this.scenarios = [...(opts.scenarios ?? ['success'])];
    this.lookupScenarios = [...(opts.lookupScenarios ?? ['auto'])];
    this.honorsReference = opts.honorsReference ?? true;
    this.hooks = opts.hooks ?? {};
    this.errorCode = opts.errorCode;
    this.errorMessage = opts.errorMessage;
  }

  /** The next call (create or lookup) does not resolve until the returned function is called. */
  hang(): () => void {
    let release!: () => void;
    this.pendingHang = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  async createOrder(reference: string, _payload: OrderPayload): Promise<CreateOrderResult> {
    this.createCalls++;
    await this.takeHang();
    const scenario = next(this.scenarios);
    let erpOrderId: string | undefined;
    let raw: RawErpResponse;

    switch (scenario) {
      case 'success':
        erpOrderId = this.record(reference);
        raw = { status: 201 };
        break;
      case 'transient':
        raw = { status: 503 };
        break;
      case 'permanent':
        raw = { status: 422 };
        break;
      case 'timeout':
        raw = { errorCode: 'TIMEOUT' };
        break;
      case 'processed_then_timeout':
        this.record(reference);
        raw = { errorCode: 'TIMEOUT' };
        break;
      case 'conflict_found':
        // Simulates an order the ERP created earlier: registered once, never re-counted.
        if (!this.registry.has(reference)) this.record(reference);
        raw = { status: 409 };
        break;
      case 'conflict_not_found':
        raw = { status: 409 };
        break;
      default: {
        const exhaustive: never = scenario;
        throw new Error(`unknown scenario ${String(exhaustive)}`);
      }
    }

    await this.hooks.beforeCreateResponds?.(reference);
    return this.toCreateResult(raw, erpOrderId);
  }

  async lookupByReference(reference: string): Promise<LookupResult> {
    this.lookupCalls++;
    await this.takeHang();
    const scenario = next(this.lookupScenarios);
    const existing = this.registry.get(reference);
    let raw: RawErpResponse;
    switch (scenario) {
      case 'auto':
        raw = { status: existing === undefined ? 404 : 200 };
        break;
      case 'unknown':
        raw = { status: 503 };
        break;
      default: {
        const exhaustive: never = scenario;
        throw new Error(`unknown lookup scenario ${String(exhaustive)}`);
      }
    }

    await this.hooks.beforeLookupResponds?.(reference);
    const kind = classifyLookup(raw);
    switch (kind) {
      case 'FOUND':
        if (existing === undefined) throw new Error('FakeErpClient: FOUND without a registered order');
        return { kind, erpOrderId: existing };
      case 'NOT_FOUND':
        return { kind };
      case 'UNKNOWN':
        return { kind, ...this.error(raw) };
      default: {
        const exhaustive: never = kind;
        throw new Error(`unknown lookup classification ${String(exhaustive)}`);
      }
    }
  }

  private async takeHang(): Promise<void> {
    const hang = this.pendingHang;
    this.pendingHang = undefined;
    if (hang) await hang;
  }

  /** Records an ERP-side creation, honouring (or not) dedupe by reference. Returns the id the ERP answers with. */
  private record(reference: string): string {
    const existing = this.registry.get(reference);
    if (existing !== undefined && this.honorsReference) return existing;
    this.createdCount++;
    const id = `ERP-${String(this.createdCount).padStart(6, '0')}`;
    if (existing === undefined) this.registry.set(reference, id);
    return id;
  }

  private toCreateResult(raw: RawErpResponse, erpOrderId: string | undefined): CreateOrderResult {
    const c = classifyCreate(raw);
    switch (c.kind) {
      case 'SUCCESS':
        if (erpOrderId === undefined) throw new Error('FakeErpClient: SUCCESS without erpOrderId');
        return { kind: 'SUCCESS', erpOrderId };
      case 'TRANSIENT_ERROR':
      case 'PERMANENT_ERROR':
        return { kind: c.kind, ...this.error(raw) };
      case 'AMBIGUOUS':
        return { kind: 'AMBIGUOUS', cause: c.cause };
      default: {
        const exhaustive: never = c;
        throw new Error(`unknown classification ${String(exhaustive)}`);
      }
    }
  }

  private error(raw: RawErpResponse): ReturnType<typeof erpError> {
    const status = 'status' in raw ? raw.status : raw.errorCode;
    return erpError(this.errorCode ?? `ERP_${status}`, this.errorMessage ?? `simulated ERP response ${status}`);
  }
}
