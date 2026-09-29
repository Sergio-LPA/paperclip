import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("stranded recovery must not clobber a terminal status", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-clobber-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const prefix = `TC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Clobber Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Do the work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, snapshot: issue! };
  }

  // The sweep captures `issue` early in the pass and only writes `blocked` after
  // several awaits. A snapshot that still says `in_progress` while the row has
  // already reached a terminal status is exactly the state the race produces.
  for (const terminalStatus of ["done", "cancelled"] as const) {
    it(`keeps '${terminalStatus}' when the row reaches it after the sweep snapshot`, async () => {
      const { companyId, agentId, issueId, snapshot } = await seed();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "failed",
        startedAt: new Date("2026-09-28T23:00:00.000Z"),
        contextSnapshot: { issueId },
      });

      // The assignee closes the issue inside the sweep window.
      await db
        .update(issues)
        .set({ status: terminalStatus, updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
      await recovery.escalateStrandedAssignedIssue({
        issue: snapshot, // stale: still says in_progress
        previousStatus: "in_progress",
        latestRun: {
          id: runId,
          agentId,
          status: "failed",
          errorCode: null,
          startedAt: new Date("2026-09-28T23:00:00.000Z"),
          contextSnapshot: { issueId },
          livenessState: "needs_followup",
        } as any,
      });

      const [after] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(after?.status).toBe(terminalStatus);
    });
  }
});
