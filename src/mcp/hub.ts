// SessionHub: the registry of open HB sessions keyed by label. Each slot pairs an HbSession with its own
// PlaywrightBridge so several identities can be driven in parallel; enforces the session cap, opens,
// connects, closes and shuts down sessions. There is no implicit current session.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { HbSession, type ConnectInfo, type ConnectOverCDP, type DisconnectInfo, type Logger } from '../hb/session.js';
import type { HbParams } from '../hb/params.js';
import type { Redactor } from '../redact.js';
import type { Settings } from '../settings.js';
import { PlaywrightBridge } from './bridge.js';

export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface Slot {
  label: string;
  session: HbSession;
  bridge: PlaywrightBridge;
  createdAt: number;
}

export class NoSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoSessionError';
  }
}

/**
 * Holds every open HB session of this process, keyed by label. Each session has its own Playwright MCP backend
 * (bridge); every tool call names the session it acts on, there is no implicit "current" one.
 */
export class SessionHub {
  readonly tools: Tool[];
  private readonly slots = new Map<string, Slot>();
  private counter = 0;
  private closing = false;

  private constructor(
    private readonly settings: Settings,
    private readonly redactor: Redactor,
    private readonly log: Logger,
    private readonly connectOverCDP: ConnectOverCDP | undefined,
    private readonly template: PlaywrightBridge,
  ) {
    this.tools = template.tools;
  }

  static async create(settings: Settings, redactor: Redactor, log: Logger, connectOverCDP?: ConnectOverCDP): Promise<SessionHub> {
    // Only used for the tool list; it never receives calls, so its getter must never be reached.
    const template = await PlaywrightBridge.create(settings.playwright, async () => {
      throw new Error('internal: template bridge invoked');
    });
    return new SessionHub(settings, redactor, log, connectOverCDP, template);
  }

  labels(): string[] {
    return [...this.slots.keys()];
  }

  list(): Slot[] {
    return [...this.slots.values()];
  }

  /** Resolve a label. Throws when it does not exist. */
  get(label: string): Slot {
    const slot = this.slots.get(label);
    if (!slot) {
      throw new NoSessionError(
        this.slots.size
          ? `No HB session labelled "${label}". Open sessions: ${this.describeLabels()}. Use hb_connect(label="${label}", ...) to open it.`
          : `No HB session is open. Call hb_connect first; it returns the label to pass as \`session\`.`,
      );
    }
    return slot;
  }

  /** Create (or replace, when the label exists) a session slot. Does not connect yet. */
  async open(label: string | undefined, params: HbParams): Promise<Slot> {
    if (label !== undefined && !LABEL_RE.test(label)) throw new Error('label must be 1-32 characters of letters, digits, "_" or "-"');
    if (label !== undefined && this.slots.has(label)) {
      await this.close(label, 'replaced by hb_connect');
    }
    if (this.slots.size >= this.settings.maxSessions) {
      throw new Error(`Session limit of ${this.settings.maxSessions} reached (open: ${this.describeLabels()}). Close one with hb_disconnect or browser_close first, or raise HB_MAX_SESSIONS.`);
    }
    const name = label ?? this.nextLabel();
    const session = new HbSession(name, params, this.settings, this.redactor, this.log, this.connectOverCDP);
    const bridge = await PlaywrightBridge.create(this.settings.playwright, () => session.ensureContext());
    const slot: Slot = { label: name, session, bridge, createdAt: Date.now() };
    this.slots.set(name, slot);
    return slot;
  }

  /** Open a slot and connect it now; on failure the slot is removed again. */
  async connect(label: string | undefined, params: HbParams): Promise<ConnectInfo & { open_sessions: string[] }> {
    const slot = await this.open(label, params);
    try {
      const info = await slot.session.connect();
      return { ...info, open_sessions: this.labels() };
    } catch (err) {
      await this.close(slot.label, 'connect failed').catch(() => undefined);
      throw err;
    }
  }

  async close(label: string, reason: string): Promise<DisconnectInfo> {
    const slot = this.slots.get(label);
    if (!slot) throw new NoSessionError(`No HB session labelled "${label}". Open sessions: ${this.describeLabels()}.`);
    this.slots.delete(label);
    await slot.bridge.resetBackend().catch(() => undefined);
    const info = await slot.session.disconnect(reason);
    await slot.bridge.close();
    return info;
  }

  async closeAll(reason: string): Promise<DisconnectInfo[]> {
    if (this.closing) return [];
    this.closing = true;
    try {
      const out: DisconnectInfo[] = [];
      for (const label of this.labels()) out.push(await this.close(label, reason));
      return out;
    } finally {
      this.closing = false;
    }
  }

  async shutdown(): Promise<void> {
    await this.closeAll('shutdown').catch(() => undefined);
    await this.template.close();
  }

  callTool(slot: Slot, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    return slot.bridge.callTool(name, args, signal);
  }

  describeLabels(): string {
    const labels = this.labels();
    return labels.length ? labels.join(', ') : '(none)';
  }

  private nextLabel(): string {
    let label: string;
    do label = `s${++this.counter}`;
    while (this.slots.has(label));
    return label;
  }
}
