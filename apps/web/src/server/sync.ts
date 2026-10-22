import { connect, listBrokers, type BrokerId } from "@luxalgo/broker-sdk";
import { eq } from "drizzle-orm";
import { resolveOptionInstrument } from "@luxalgo/journal-core";
import type { ImportedExecution } from "@luxalgo/journal-importers";
import { accounts, db } from "@/db";
import { decryptJson, encryptJson } from "./crypto";
import { nowIso } from "./ids";
import { insertExecutions, normalizeStoredOptionExecutions, type InsertResult } from "./executions";
import { IBKR_FLEX_TIME_ZONE, parseIbkrFlexSync, type IbkrFlexSyncResult } from "./ibkr-flex-sync";

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

export const syncAccount = async (accountId: string): Promise<SyncOutcome> => {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) throw new Error("Account not found");
  if (account.kind !== "sync" || !account.credentialsEnc) {
    throw new Error("Account is not broker-connected");
  }

  // Heal fills written by older versions before fetching the same broker
  // history again, otherwise raw OCC and readable symbols become duplicates.
  normalizeStoredOptionExecutions(accountId);

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
  const rows: ImportedExecution[] =
    ibkr?.executions.length ||
    snapshot.accounts.every((brokerAccount) => brokerAccount.trades.length === 0)
      ? (ibkr?.executions ?? [])
      : snapshot.accounts.flatMap((brokerAccount) =>
          brokerAccount.trades.map((trade) => {
            const instrument = resolveOptionInstrument({ symbol: trade.symbol });
            return {
              symbol: instrument.symbol,
              side: trade.side,
              quantity: trade.quantity,
              price: trade.price,
              fee: trade.fee ?? 0,
              // The SDK omits unparseable timestamps; a fill with no time can't be
              // journaled meaningfully, so it is dropped rather than guessed at.
              executedAt: trade.executedAt ?? "",
              assetClass: instrument.assetClass,
            };
          }),
        );
  const timed = rows.filter((row) => row.executedAt !== "");
  const untimed = rows.length - timed.length;

  // One odd broker record must not fail the whole sync: invalid rows are
  // skipped and counted so the account page can report them.
  const result = insertExecutions(accountId, timed, "sync");
  if (untimed > 0) {
    result.skipped += untimed;
    if (result.skippedReasons.length < 5)
      result.skippedReasons.push(`${untimed} fill(s) had no usable timestamp.`);
  }

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
  db.update(accounts)
    .set({
      lastSyncAt: syncedAt,
      snapshotJson: JSON.stringify({
        equity,
        positions: reportsPositions ? positions : null,
        fetchedAt: snapshot.fetchedAt,
      }),
    })
    .where(eq(accounts.id, accountId))
    .run();

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
