import type { ParsedImport } from "@luxalgo/journal-importers";
import { eq } from "drizzle-orm";
import { accounts, db } from "@/db";
import { requireValue } from "./api";
import { IBKR_FLEX_TIME_ZONE, parseIbkrFlexXmlImport } from "./ibkr-flex-sync";
import { canonicalImportTimeZone, isIbkrSyncAccount } from "./ibkr-sync-timezone";

export const IBKR_FLEX_XML = { id: "ibkr-flex-xml", label: "Interactive Brokers (Flex Query XML)" };

/** A Flex Query response or statement, optionally after an XML declaration and comments. */
export const looksLikeFlexXml = (content: string): boolean =>
  /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:FlexQueryResponse|FlexStatements?)[\s>]/.test(
    content.replace(/^﻿/, ""),
  );

/** Attribute maps for one element name, read the same way as the SDK's Flex parser. */
const elements = (xml: string, tag: string): Record<string, string>[] =>
  [...xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, "g"))].map((match) =>
    Object.fromEntries(
      [...(match[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)].map((pair) => [pair[1]!, pair[2]!]),
    ),
  );

const isSummaryRow = (trade: Record<string, string>): boolean =>
  Boolean(trade.levelOfDetail) && trade.levelOfDetail!.toUpperCase() !== "EXECUTION";

/** Order, closed-lot and summary rows repeat the executions they summarize. */
export const withoutSummaryRows = (
  xml: string,
): { xml: string; summaries: Record<string, string>[] } => {
  const summaries = elements(xml, "Trade").filter(isSummaryRow);
  return {
    summaries,
    xml: summaries.length
      ? xml.replace(/<Trade\s[^>]*?\/?>/g, (tag) =>
          isSummaryRow(elements(tag, "Trade")[0] ?? {}) ? "" : tag,
        )
      : xml,
  };
};

/**
 * Parse an uploaded Flex Query XML statement with the parser broker sync uses,
 * so options, spreads and expirations match synced history. Naive `dateTime`
 * values are read in the statement timezone chosen for the upload.
 */
export const parseFlexXmlImport = (content: string, timeZone: string): ParsedImport => {
  requireValue(
    !/^[+-]/.test(timeZone.trim()),
    "Choose a named IANA statement timezone for IBKR Flex statements, such as America/New_York, not a UTC offset.",
  );
  const zone = canonicalImportTimeZone(timeZone);
  const errors: string[] = [];
  const warnings: string[] = [];

  const rows = elements(content, "Trade");
  const accountIds = new Set(
    [...elements(content, "FlexStatement"), ...rows]
      .map((attrs) => attrs.accountId?.trim())
      .filter((id): id is string => Boolean(id)),
  );
  if (accountIds.size > 1)
    errors.push(
      `This Flex statement contains ${accountIds.size} IBKR accounts (${[...accountIds].join(", ")}). Export one account per Flex Query, or import each account's statement into its own journal account.`,
    );

  const { xml: executionXml, summaries } = withoutSummaryRows(content);
  if (summaries.length)
    warnings.push(
      `${summaries.length} Trade summary row(s) (${[...new Set(summaries.map((row) => row.levelOfDetail))].join(", ")}) were skipped; only execution rows are imported.`,
    );

  const parsed = parseIbkrFlexXmlImport(executionXml, zone);
  return {
    ...parsed,
    format: IBKR_FLEX_XML.id,
    warnings: [...warnings, ...parsed.warnings],
    ...(errors.length || parsed.errors?.length
      ? { errors: [...errors, ...(parsed.errors ?? [])] }
      : {}),
  };
};

/**
 * Sync reads Flex statements in US Eastern time. An upload into an IBKR sync
 * account must too, or fills without a broker ID would hash differently and be
 * stored twice.
 */
export const flexUploadSyncProblem = (accountId: string, zone: string): string | null => {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account || (!isIbkrSyncAccount(account) && account.ibkrSyncTimeZone === null)) return null;
  const syncZone = canonicalImportTimeZone(account.ibkrSyncTimeZone ?? IBKR_FLEX_TIME_ZONE);
  const uploadZone = canonicalImportTimeZone(zone);
  return uploadZone === syncZone
    ? null
    : `This account syncs IBKR statements in ${syncZone}, but this upload uses ${uploadZone}. Upload with the ${syncZone} statement timezone so uploaded and synced fills match, or import into a separate account.`;
};
