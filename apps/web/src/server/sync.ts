import { connect, listBrokers, type BrokerId } from "@luxalgo/broker-sdk";
import { and, eq } from "drizzle-orm";
import { resolveOptionInstrument } from "@luxalgo/journal-core";
import type { ImportedExecution } from "@luxalgo/journal-importers";
import { accounts, db, executions } from "@/db";
import { decryptJson, encryptJson } from "./crypto";
import { nowIso } from "./ids";
import { brokerTradesToExecutions, untimedFillsReason } from "./broker-trades";
import { expiredOptionCloses, keepWithinHistory } from "./broker-history";
import {
  insertExecutions,
  normalizeStoredOptionExecutions,
  storedExecutionHash,
  type InsertResult,
} from "./executions";
import { IBKR_FLEX_TIME_ZONE, parseIbkrFlexSync, type IbkrFlexSyncResult } from "./ibkr-flex-sync";
import { getMultipliers, setSetting } from "./settings";
import { requireValue } from "./api";
import { isIbkrSyncAccount } from "./ibkr-sync-timezone";
import { withoutSummaryRows } from "./ibkr-flex-xml-import";

/** All broker connectivity goes through @luxalgo/broker-sdk, never direct API code. */
export { listBrokers };

/** The asset class whose fills a broker's complete position list can vouch for. */
const CHECKED_ASSET_CLASS: Record<string, string> = { webull: "equity", binance: "futures" };
/** Later syncs re-read this much before the last one, for orders that filled after placement. */
const HISTORY_OVERLAP_MS = 30 * 86_400_000;

/**
 * The SDK reads every Flex `<Trade>` row as a fill. Keep execution rows only,
 * as file uploads do, so order and summary rows are not journaled as fills.
 */
const flexExecutionRowsOnly: typeof globalThis.fetch = async (input, init) => {
  const response = await fetch(input, init);
  return new Response(withoutSummaryRows(await response.text()).xml, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

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
    const response = await flexExecutionRowsOnly(input, init);
    if (response.ok) {
      const text = await response.clone().text();
      if (text.includes("<FlexStatement")) ibkrStatementXml = text;
    }
    return response;
  };
  // Brokers that page through trade history (Webull) only need recent fills
  // once history has landed; refetched fills dedupe by content hash.
  const hasSyncedFills = db
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.accountId, accountId), eq(executions.source, "sync")))
    .get();
  const historySince =
    hasSyncedFills && account.lastSyncAt
      ? new Date(Date.parse(account.lastSyncAt) - HISTORY_OVERLAP_MS).toISOString()
      : undefined;
  const connection = connect({
    broker: account.broker as BrokerId,
    credentials,
    ...(historySince !== undefined ? { historySince } : {}),
    ...(statementTimeZone !== undefined ? { statementTimeZone } : {}),
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
  const trades = snapshot.accounts.flatMap((brokerAccount) => brokerAccount.trades);
  // Option P&L needs the contract size; the broker's value never replaces the user's.
  // Settings are keyed by the journal's symbol, so raw OCC symbols are normalized first.
  const multipliers = getMultipliers();
  let statedMultipliers = 0;
  for (const trade of trades) {
    const symbol = resolveOptionInstrument({ symbol: trade.symbol }).symbol;
    if (!trade.multiplier || multipliers[symbol] !== undefined) continue;
    multipliers[symbol] = trade.multiplier;
    statedMultipliers++;
  }
  if (statedMultipliers > 0) setSetting("multipliers", JSON.stringify(multipliers));
  const sdkRows = brokerTradesToExecutions(trades);
  const fromFlexParser = Boolean(ibkr?.executions.length);
  const { timed, untimed } = fromFlexParser ? brokerTimed(ibkr!.executions) : sdkRows;
  const { positionEffects } = sdkRows;

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

  // A broker whose position list is complete for an asset class can show
  // which unlabeled fills reach back before the start of its history.
  const checked = CHECKED_ASSET_CLASS[account.broker ?? ""];
  const brokerQuantities = new Map<string, number>();
  for (const position of positions) {
    // Hedge-mode sides replay in their own groups, so they say nothing about one-way fills.
    if (position.positionSide) continue;
    brokerQuantities.set(
      position.symbol,
      (brokerQuantities.get(position.symbol) ?? 0) + position.quantity,
    );
  }
  // A Binance quarterly contract (BTCUSDT_261225) settles at delivery without a
  // fill, so its empty position doesn't show that its history is incomplete.
  const delivered = (symbol: string) => account.broker === "binance" && /_\d{6}$/.test(symbol);
  const brokerQuantity = (symbol: string) =>
    checked && !delivered(symbol) ? (brokerQuantities.get(symbol) ?? 0) : undefined;
  let dropped = 0;
  let trimmed = 0;
  const withinHistory = (fills: ImportedExecution[]): ImportedExecution[] => {
    const stored = db.select().from(executions).where(eq(executions.accountId, accountId)).all();
    const storedHashes = new Set(stored.map((row) => row.contentHash));
    const fresh = fills.filter((fill) => !storedHashes.has(storedExecutionHash(fill, "sync")));
    const groupOf = (json: string | null) =>
      json ? (JSON.parse(json) as { group?: string }).group : undefined;
    const keep = keepWithinHistory(
      stored.map((row) => ({
        ...row,
        side: row.side as "buy" | "sell",
        group: groupOf(row.importMetadataJson),
      })),
      fresh.map((fill) => ({
        ...fill,
        group: fill.importMetadata?.group,
        positionEffect: positionEffects.get(fill),
      })),
      brokerQuantity,
      checked,
    );
    const kept = new Map([...keep].map(([index, quantity]) => [fresh[index]!, quantity]));
    dropped = [...keep.values()].filter((quantity) => quantity < 1e-9).length;
    trimmed = keep.size - dropped;
    // Repeats of stored fills go through, so the insert counts them as duplicates.
    return fills.flatMap((fill) => {
      const quantity = kept.get(fill);
      if (quantity === undefined) return [fill];
      if (quantity < 1e-9) return [];
      // The kept part hashes as the broker's whole fill, so later syncs still match it.
      const fee = (fill.fee * quantity) / fill.quantity;
      return [{ ...fill, quantity, fee, hashQuantity: fill.quantity }];
    });
  };

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
      // and sync status commit together. The Flex parser's rows carry broker
      // IDs and lifecycle events of their own, so history trimming skips them.
      const inserted = insertExecutions(
        accountId,
        fromFlexParser ? timed : withinHistory(timed),
        "sync",
      );
      if (account.broker === "webull") {
        const optionFills = db
          .select()
          .from(executions)
          .where(and(eq(executions.accountId, accountId), eq(executions.assetClass, "option")))
          .all()
          .map((row) => ({ ...row, side: row.side as "buy" | "sell" }));
        const expired = expiredOptionCloses(optionFills, syncedAt).map((fill) => ({
          ...fill,
          assetClass: "option" as const,
          price: 0,
          fee: 0,
        }));
        // An expiry has no commission, so default fee rules must not add one.
        if (expired.length > 0)
          inserted.inserted += insertExecutions(accountId, expired, "sync", undefined, {
            preserveFees: true,
          }).inserted;
      }
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
  if (fromFlexParser) result.skipped += ibkr!.stats.skippedTrades;
  if (dropped > 0) {
    result.skipped += dropped;
    if (result.skippedReasons.length < 5)
      result.skippedReasons.push(
        `${dropped} fill(s) closed a position opened before the broker's available history and were skipped.`,
      );
  }
  if (trimmed > 0) {
    result.skipped += trimmed;
    if (result.skippedReasons.length < 5)
      result.skippedReasons.push(
        `${trimmed} fill(s) also closed a position opened before the broker's available history; only the part that history covers was kept.`,
      );
  }
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
