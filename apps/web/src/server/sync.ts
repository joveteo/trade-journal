import { connect, listBrokers, type BrokerId } from "@luxalgo/broker-sdk";
import { eq } from "drizzle-orm";
import { resolveOptionInstrument } from "@luxalgo/journal-core";
import type { ImportedExecution } from "@luxalgo/journal-importers";
import { accounts, db } from "@/db";
import { decryptJson, encryptJson } from "./crypto";
import { nowIso } from "./ids";
import { brokerTradesToExecutions, untimedFillsReason } from "./broker-trades";
import { insertExecutions, normalizeStoredOptionExecutions, type InsertResult } from "./executions";
import { IBKR_FLEX_TIME_ZONE, parseIbkrFlexSync, type IbkrFlexSyncResult } from "./ibkr-flex-sync";
import { requireValue } from "./api";
import { isIbkrSyncAccount } from "./ibkr-sync-timezone";

/** All broker connectivity goes through @luxalgo/broker-sdk, never direct API code. */
export { listBrokers };

export interface SyncOutcome extends InsertResult {
  accountId: string;
  equity: number | null;
  positions: number | null;
  syncedAt: string;
  warnings: string[];
  ibkrFlex?: IbkrFlexSyncResult["stats"];
}

const brokerTimed = (rows: ImportedExecution[]) => {
  const timed = rows.filter((row) => row.executedAt !== "");
  return { timed, untimed: rows.length - timed.length };
};

export const syncAccount = async (accountId: string): Promise<SyncOutcome> => {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error("Account not found");
  if (account.kind !== "sync" || !account.credentialsEnc) {
    throw new Error("Account is not broker-connected");
  }

  // Heal fills written by older versions before fetching the same broker
  // history again, otherwise raw OCC and readable symbols become duplicates.
  normalizeStoredOptionExecutions(accountId);
  // Flex statements are always US Eastern, whatever the import timezone says.
  // Re-synced fills take the statement's time, so no provenance check is needed.
  const statementTimeZone = isIbkrSyncAccount(account) ? IBKR_FLEX_TIME_ZONE : undefined;

  const credentials = decryptJson<Record<string, string>>(account.credentialsEnc);
  let ibkrStatementXml: string | undefined;
  const captureIbkrStatement: typeof globalThis.fetch = async (input, init) => {
    const response = await globalThis.fetch(input, init);
    if (response.ok) {
      const text = await response.clone().text();
      if (text.includes("<FlexStatement")) ibkrStatementXml = text;
    }
    return response;
  };
  const connection = connect({
    broker: account.broker as BrokerId,
    credentials,
    ...(account.broker === "ibkr-flex" ? { fetch: captureIbkrStatement } : {}),
    ...(statementTimeZone !== undefined ? { statementTimeZone } : {}),
    // Some brokers rotate tokens on every fetch (Questrade): persist or die.
    onCredentialsRotated: (next: Record<string, string>) => {
      db.update(accounts)
        .set({ credentialsEnc: encryptJson(next) })
        .where(eq(accounts.id, accountId))
        .run();
    },
  } as Parameters<typeof connect>[0]);

  const snapshot = await connection.fetchSnapshot();
  const syncedAt = nowIso();

  const ibkr =
    account.broker === "ibkr-flex" && ibkrStatementXml
      ? parseIbkrFlexSync(ibkrStatementXml, {
          now: new Date(snapshot.fetchedAt),
          timeZone: IBKR_FLEX_TIME_ZONE,
        })
      : undefined;
  const warnings = [...(ibkr?.warnings ?? [])];
  if (account.broker === "ibkr-flex" && !ibkrStatementXml) {
    warnings.push(
      "The Flex XML response could not be inspected, so spread identifiers and option expiration events were unavailable.",
    );
  }
  // The SDK reports $0 and no positions when the Flex query omits those sections,
  // which is indistinguishable from a flat account. Record them as unknown instead.
  const flexSection = (section: RegExp) =>
    account.broker !== "ibkr-flex" || !ibkrStatementXml || section.test(ibkrStatementXml);
  const reportsPositions = flexSection(/<OpenPositions[\s>/]/);
  const reportsCash = flexSection(/<CashReport[\s>/]/);
  const reportsEquity = reportsPositions && reportsCash;
  const missingSections = [
    reportsPositions ? "" : "Open Positions",
    reportsCash ? "" : "Cash Report",
  ].filter(Boolean);
  if (missingSections.length)
    warnings.push(
      `The Flex query has no ${missingSections.join(" or ")} section, so broker ${reportsPositions ? "equity is" : "positions and equity are"} unavailable. In IBKR Account Management → Flex Queries, add ${missingSections.join(" and ")} to this query (Open Positions at Summary level).`,
    );
  const sdkRows = brokerTradesToExecutions(
    snapshot.accounts.flatMap((brokerAccount) => brokerAccount.trades),
  );
  const { timed, untimed } = ibkr?.executions.length ? brokerTimed(ibkr.executions) : sdkRows;

  const equity = reportsEquity ? snapshot.accounts.reduce((total, a) => total + a.equity, 0) : null;
  const positions = snapshot.accounts.flatMap((a) =>
    a.positions.map((position) => {
      const instrument = resolveOptionInstrument({
        symbol: position.symbol,
        assetClass: position.assetClass === "option" ? "option" : undefined,
      });
      return {
        ...position,
        symbol: instrument.symbol,
        assetClass: instrument.assetClass ?? position.assetClass,
      };
    }),
  );
  const result = db.transaction(
    () => {
      if (statementTimeZone !== undefined) {
        const current = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
        requireValue(
          current &&
            isIbkrSyncAccount(current) &&
            current.credentialsEnc === account.credentialsEnc,
          "The IBKR connection changed during sync. Try again.",
        );
      }
      // One odd broker record must not fail the whole sync: invalid rows are
      // skipped and counted so the account page can report them. Deduplication
      // and sync status commit together.
      const inserted = insertExecutions(accountId, timed, "sync");
      db.update(accounts)
        .set({
          lastSyncAt: syncedAt,
          snapshotJson: JSON.stringify({
            equity,
            positions: reportsPositions ? positions : null,
            fetchedAt: snapshot.fetchedAt,
          }),
          // Re-synced fills now carry Eastern times, which transfers check.
          ...(statementTimeZone !== undefined ? { ibkrSyncTimeZone: statementTimeZone } : {}),
        })
        .where(eq(accounts.id, accountId))
        .run();
      return inserted;
    },
    { behavior: "immediate" },
  );
  // Rows the Flex parser dropped are explained in the sync warnings.
  if (ibkr?.executions.length) result.skipped += ibkr.stats.skippedTrades;
  if (untimed > 0) {
    result.skipped += untimed;
    if (result.skippedReasons.length < 5)
      result.skippedReasons.push(untimedFillsReason(untimed, statementTimeZone !== undefined));
  }

  return {
    accountId,
    ...result,
    equity,
    positions: reportsPositions ? positions.length : null,
    syncedAt,
    warnings,
    ...(ibkr ? { ibkrFlex: ibkr.stats } : {}),
  };
};
