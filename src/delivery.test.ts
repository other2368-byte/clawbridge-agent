/**
 * Delivery race tests.
 *
 * The active poll (1s, running sessions) and the sweep poll (60s, all
 * active sessions) both call deliverSessionMessages. A running session
 * sits in both result sets, so the two timer chains can race on the same
 * outbound row — read-undelivered → call channel API → markDelivered. The
 * INSERT OR IGNORE in markDelivered makes the DB write idempotent, but
 * the channel API has already fired twice → user sees the message twice.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/clawbridge-test-delivery' };
});

const TEST_DIR = '/tmp/clawbridge-test-delivery';

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { resolveSession, outboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text: 'hello' }));
  db.close();
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('deliverSessionMessages — concurrent invocations', () => {
  it('delivers a message exactly once when active and sweep polls overlap', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-1');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        // Hold long enough that the second concurrent caller can race the
        // read-undelivered → markDelivered window.
        await new Promise((r) => setTimeout(r, 100));
        return 'plat-msg-1';
      },
    });

    // Two concurrent calls — simulating active (1s) and sweep (60s) polls
    // hitting the same running session at the same moment.
    await Promise.all([deliverSessionMessages(session), deliverSessionMessages(session)]);

    expect(calls).toHaveLength(1);
  });

  it('still delivers on a subsequent call after the first finishes', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-first');

    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        calls.push(content);
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    expect(calls).toHaveLength(1);

    // Insert a second outbound message and deliver again — the lock from
    // the first call must have been released.
    insertOutbound('ag-1', session.id, 'out-second');
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('does not re-deliver when retried after a successful send (cleanup-after-send safety)', async () => {
    // If something post-send throws (e.g. outbox cleanup), the message has
    // still landed on the user's screen — the catch path must not trigger
    // a re-send. We simulate by having the adapter succeed on the first
    // call and recording how many times it's invoked across two attempts.
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-once');

    let callCount = 0;
    setDeliveryAdapter({
      async deliver() {
        callCount++;
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);
    // Re-invoke — should be idempotent because the message is now in the
    // delivered table; the channel adapter must not be called again.
    await deliverSessionMessages(session);

    expect(callCount).toBe(1);
  });
});

describe('deliverSessionMessages — self-routing guardrail', () => {
  function insertOutboundAgent(agentGroupId: string, sessionId: string, msgId: string, targetPlatformId: string): void {
    const db = new Database(outboundDbPath(agentGroupId, sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, datetime('now'), 'chat', ?, 'agent', ?)`,
    ).run(msgId, targetPlatformId, JSON.stringify({ text: 'hello' }));
    db.close();
  }

  it('redirects to origin chat when agent self-routes (platform_id === agent_group_id)', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // Message targets the agent's own group id — the self-routing bug
    insertOutboundAgent('ag-1', session.id, 'self-route-1', 'ag-1');

    const deliveredTo: { channelType: string; platformId: string }[] = [];
    setDeliveryAdapter({
      async deliver(channelType, platformId, _threadId, _kind, _content) {
        deliveredTo.push({ channelType, platformId });
        return 'plat-msg-id';
      },
    });

    await deliverSessionMessages(session);

    // Must have been redirected to the origin chat (telegram:123), not A2A
    expect(deliveredTo).toHaveLength(1);
    expect(deliveredTo[0].channelType).toBe('telegram');
    expect(deliveredTo[0].platformId).toBe('telegram:123');
  });

  it('does not call channel adapter when agent self-routes with no origin messaging group', async () => {
    seedAgentAndChannel();
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // Simulate no origin chat by nulling messaging_group_id on the in-memory object
    (session as unknown as Record<string, unknown>).messaging_group_id = null;
    insertOutboundAgent('ag-1', session.id, 'self-orphan-1', 'ag-1');

    let adapterCalled = false;
    setDeliveryAdapter({
      async deliver() { adapterCalled = true; return 'plat-msg-id'; },
    });

    // Error is caught by retry logic and message is marked failed — adapter never called
    await deliverSessionMessages(session);
    expect(adapterCalled).toBe(false);
  });

  it('does NOT redirect legitimate A2A messages to a different agent group', async () => {
    seedAgentAndChannel();
    // Create a second agent group as the target
    createAgentGroup({ id: 'ag-2', name: 'Target Agent', folder: 'target-agent', agent_provider: null, created_at: new Date().toISOString() });

    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    // Message targets a DIFFERENT agent group (ag-2 != ag-1) — guardrail must not trigger.
    // If it wrongly redirected, the channel adapter would be called. Verify it is not.
    insertOutboundAgent('ag-1', session.id, 'a2a-legit-1', 'ag-2');

    let adapterCalled = false;
    setDeliveryAdapter({
      async deliver() { adapterCalled = true; return 'plat-msg-id'; },
    });

    // A2A route fails (unauthorized), caught by retry, message marked failed — adapter not called
    await deliverSessionMessages(session);
    expect(adapterCalled).toBe(false);
  });
});
