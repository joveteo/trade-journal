import { and, eq } from "drizzle-orm";
import { accounts, db, executions } from "@/db";
import { isTimeZone } from "@/lib/timezone";
import { requireValue } from "./api";

type Account = typeof accounts.$inferSelect;

export const isIbkrSyncAccount = (account: Account): boolean =>
  account.kind === "sync" && account.broker === "ibkr-flex";

export const canonicalImportTimeZone = (value: unknown): string => {
  requireValue(
    isTimeZone(value) && !/^[+-]/.test(value),
    "Enter a valid IANA default import timezone in Settings → Journal.",
  );
  return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
};

export const hasSyncedExecutions = (accountId: string): boolean =>
  Boolean(
    db
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.accountId, accountId), eq(executions.source, "sync")))
      .limit(1)
      .get(),
  );

const RECOVERY =
  "Sync each IBKR account once so its history records the Eastern statement timezone, then try again.";

/** Keep provenance with transferred history, including moves through a manual/import account. */
export const ibkrTransferTimeZone = (source: Account, destination: Account): string | undefined => {
  const relevant =
    isIbkrSyncAccount(source) ||
    isIbkrSyncAccount(destination) ||
    source.ibkrSyncTimeZone !== null ||
    destination.ibkrSyncTimeZone !== null;
  if (!relevant || !hasSyncedExecutions(source.id)) return undefined;
  requireValue(
    source.ibkrSyncTimeZone !== null,
    `Cannot transfer synced history with an unknown IBKR statement timezone. ${RECOVERY}`,
  );
  requireValue(
    destination.kind !== "sync" || isIbkrSyncAccount(destination),
    "Cannot transfer IBKR synced history into another broker connection. Use a separate manual account to preserve its timezone provenance.",
  );
  const sourceZone = canonicalImportTimeZone(source.ibkrSyncTimeZone);
  if (hasSyncedExecutions(destination.id)) {
    requireValue(
      destination.ibkrSyncTimeZone !== null &&
        canonicalImportTimeZone(destination.ibkrSyncTimeZone) === sourceZone,
      `Cannot combine synced histories with unknown or different IBKR statement timezones. ${RECOVERY}`,
    );
  }
  return sourceZone;
};
