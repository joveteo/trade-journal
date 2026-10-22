import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@luxalgo/broker-sdk", () => ({
  connect: vi.fn(),
  listBrokers: vi.fn(),
}));

const originalDir = process.env.JOURNAL_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), "journal-ibkr-timezone-"));
process.env.JOURNAL_DATA_DIR = scratch;

const { connect } = await import("@luxalgo/broker-sdk");
const { accounts, db, executions, settings, trades } = await import("../src/db");
const { encryptJson } = await import("../src/server/crypto");
const { setSetting } = await import("../src/server/settings");
const { syncAccount } = await import("../src/server/sync");
const { insertExecutions } = await import("../src/server/executions");
const { parseIbkrFlexXmlImport } = await import("../src/server/ibkr-flex-sync");
const { executionHash } = await import("../src/server/ids");

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  db.delete(trades).run();
  db.delete(executions).run();
  db.delete(accounts).run();
  db.delete(settings).run();
  db.insert(accounts)
    .values({
      id: "ibkr",
      name: "IBKR",
      broker: "ibkr-flex",
      kind: "sync",
      credentialsEnc: encryptJson({ token: "fixture", queryId: "fixture" }),
      createdAt: "2026-01-01",
    })
    .run();
});

afterAll(() => {
  vi.unstubAllGlobals();
  db.$client.close();
  if (originalDir === undefined) delete process.env.JOURNAL_DATA_DIR;
  else process.env.JOURNAL_DATA_DIR = originalDir;
  rmSync(scratch, { recursive: true, force: true });
});

const statement = `<FlexQueryResponse><FlexStatements><FlexStatement accountId="U1">
  <Trade assetCategory="STK" symbol="NVDA" dateTime="20260102;100000"
    buySell="BUY" quantity="1" tradePrice="100" transactionID="tx-1" />
</FlexStatement></FlexStatements></FlexQueryResponse>`;

const mockSync = (
  xml = statement,
  brokerAccount: { equity: number; positions: unknown[] } = { equity: 0, positions: [] },
) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(xml, { status: 200 })),
  );
  vi.mocked(connect).mockImplementation(((options: { fetch: typeof globalThis.fetch }) => ({
    fetchSnapshot: async () => {
      await options.fetch("https://fixture.invalid/flex");
      return {
        fetchedAt: "2026-01-03T00:00:00.000Z",
        accounts: [{ ...brokerAccount, trades: [] }],
      };
    },
  })) as unknown as typeof connect);
};

describe("IBKR Flex live sync timezone", () => {
  it("reads Flex statement clocks in US Eastern time, not the generic import zone", async () => {
    setSetting("importTimeZone", "Asia/Singapore");
    mockSync();

    await syncAccount("ibkr");

    expect(db.select().from(executions).all()).toEqual([
      expect.objectContaining({
        symbol: "NVDA",
        executedAt: "2026-01-02T15:00:00.000Z",
      }),
    ]);
  });

  it("corrects a fill an older sync stored under the UTC default when IBKR re-sends it", async () => {
    // Same broker fill as `statement`, saved before sync read Flex clocks in Eastern time.
    const [stale] = parseIbkrFlexXmlImport(statement, "UTC").executions;
    insertExecutions("ibkr", [stale!], "sync");
    expect(db.select().from(trades).get()!.openedAt).toBe("2026-01-02T10:00:00.000Z");

    mockSync();
    await syncAccount("ibkr");

    const rows = db.select().from(executions).all();
    expect(rows).toEqual([expect.objectContaining({ executedAt: "2026-01-02T15:00:00.000Z" })]);
    expect(rows[0]!.contentHash).toBe(
      executionHash({ ...rows[0]!, importMetadata: JSON.parse(rows[0]!.importMetadataJson!) }),
    );
    expect(db.select().from(trades).all()).toEqual([
      expect.objectContaining({ openedAt: "2026-01-02T15:00:00.000Z" }),
    ]);
  });

  it("keeps the synced time when the same fill is uploaded in another statement zone", async () => {
    mockSync();
    await syncAccount("ibkr");

    insertExecutions("ibkr", parseIbkrFlexXmlImport(statement, "UTC").executions, "import");

    expect(db.select().from(executions).all()).toEqual([
      expect.objectContaining({ executedAt: "2026-01-02T15:00:00.000Z" }),
    ]);
  });
});

describe("IBKR Flex live sync snapshot", () => {
  const snapshotOf = () => JSON.parse(db.select().from(accounts).get()!.snapshotJson!);

  it("records equity and positions as unknown when the Flex query omits those sections", async () => {
    mockSync();

    const outcome = await syncAccount("ibkr");

    expect(snapshotOf()).toMatchObject({ equity: null, positions: null });
    expect(outcome).toMatchObject({ equity: null, positions: null });
    expect(outcome.warnings).toContainEqual(
      expect.stringContaining("no Open Positions or Cash Report section"),
    );
  });

  it("keeps equity unknown when only Open Positions is reported", async () => {
    const position = { symbol: "TLT", quantity: 10, marketValue: 900 };
    mockSync(statement.replace("</FlexStatement>", "<OpenPositions /></FlexStatement>"), {
      equity: 900,
      positions: [position],
    });

    const outcome = await syncAccount("ibkr");

    expect(snapshotOf()).toMatchObject({ equity: null, positions: [position] });
    expect(outcome.warnings).toContainEqual(
      expect.stringContaining("broker equity is unavailable"),
    );
  });

  it("stores broker equity when Open Positions and Cash Report are both present", async () => {
    const xml = statement.replace(
      "</FlexStatement>",
      `<OpenPositions /><CashReport><CashReportCurrency currency="BASE_SUMMARY" endingCash="1500" /></CashReport></FlexStatement>`,
    );
    mockSync(xml, { equity: 1500, positions: [] });

    const outcome = await syncAccount("ibkr");

    expect(snapshotOf()).toMatchObject({ equity: 1500, positions: [] });
    expect(outcome.warnings.join(" ")).not.toContain("Flex query has no");
  });
});
