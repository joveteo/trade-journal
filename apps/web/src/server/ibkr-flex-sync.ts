import {
  parseOptionSymbol,
  resolveOptionInstrument,
  type AssetClass,
  type BrokerExecutionMetadata,
} from "@luxalgo/journal-core";
import {
  parseTimestamp,
  type ImportedExecution,
  type ParsedImport,
} from "@luxalgo/journal-importers";
import { untimedFillsReason } from "./broker-trades";

type Attributes = Record<string, string>;

/**
 * Flex Web Service statements report naive `dateTime` values in US Eastern time
 * (expirations book at 16:20 ET). Live sync uses this zone rather than the
 * generic file-import default, which is meant for other brokers' CSV exports.
 */
export const IBKR_FLEX_TIME_ZONE = "America/New_York";

export interface IbkrFlexSyncResult {
  executions: ImportedExecution[];
  warnings: string[];
  stats: {
    trades: number;
    lifecycleEvents: number;
    lifecycleClosures: number;
    unresolvedLifecycleEvents: number;
    /** Trade rows dropped for a missing field, a zero non-option price, or an unreadable time. */
    skippedTrades: number;
    expiredContractsWithoutLifecycle: number;
    identifiedSpreadOrders: number;
  };
}

export interface IbkrFlexParseOptions {
  now?: Date;
  timeZone?: string;
  /** Sync windows omit unmatched closes; upload windows retain them for cross-file matching. */
  reconcileWindow?: boolean;
  reportExpiredGaps?: boolean;
}

const ASSET_CLASSES: Record<string, AssetClass> = {
  STK: "equity",
  OPT: "option",
  FOP: "option",
  FUT: "futures",
  CASH: "forex",
  CRYPTO: "crypto",
  CFD: "cfd",
};

const decodeXml = (value: string): string =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const parseAttributes = (text: string): Attributes => {
  const row: Attributes = {};
  for (const pair of text.matchAll(/([\w-]+)="([^"]*)"/g)) {
    if (pair[1]) row[pair[1]] = decodeXml(pair[2] ?? "");
  }
  return row;
};

const elements = (xml: string, tag: string): Attributes[] => {
  const rows: Attributes[] = [];
  for (const match of xml.matchAll(new RegExp(`<${tag}\\s+([^>]*?)/?>`, "g"))) {
    rows.push(parseAttributes(match[1] ?? ""));
  }
  return rows;
};

const statementElements = (xml: string, tag: string): Attributes[] => {
  const statements = [...xml.matchAll(/<FlexStatement\s+([^>]*?)>([\s\S]*?)<\/FlexStatement>/g)];
  if (statements.length === 0) return elements(xml, tag);
  return statements.flatMap((statement) => {
    const accountId = parseAttributes(statement[1] ?? "").accountId;
    return elements(statement[2] ?? "", tag).map((row) => ({
      ...(accountId ? { accountId } : {}),
      ...row,
    }));
  });
};

const attr = (row: Attributes, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
};

const number = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const wallClock = (instant: number, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .format(instant)
    .replace(", ", " ");

const flexTimestamp = (
  raw: string | undefined,
  timeZone: string,
  endOfDay = false,
): string | undefined => {
  if (!raw) return undefined;
  const value = raw.trim();
  const dateOnly = value.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  const dateTime = value.match(
    /^(\d{4})-?(\d{2})-?(\d{2})[;, T]?(\d{2}):?(\d{2}):?(\d{2})(Z|[+-]\d{2}:?\d{2})?$/,
  );
  // Anything else, such as a zone abbreviation suffix, would be a guess.
  if (!dateOnly && !dateTime) return undefined;
  const [, year, month, day, hour, minute, second, offset] = dateOnly
    ? [...dateOnly, ...(endOfDay ? ["23", "59", "59"] : ["00", "00", "00"]), undefined]
    : dateTime!;
  const local = `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  if (offset) {
    // An explicit offset or Z keeps its instant regardless of the statement timezone.
    const zone = offset.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
    const parsed = Date.parse(`${local.replace(" ", "T")}${zone}`);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  const parsed = parseTimestamp(local, timeZone);
  if (!parsed) return undefined;
  const instant = Date.parse(parsed);
  // Reject invalid dates and daylight-saving gaps (the wall clock does not round-trip)
  // and repeated hours (another instant shows the same wall clock).
  if (wallClock(instant, timeZone) !== local) return undefined;
  if (
    [-3600e3, -1800e3, 1800e3, 3600e3].some(
      (shift) => wallClock(instant + shift, timeZone) === local,
    )
  )
    return undefined;
  return parsed;
};

const brokerMetadata = (
  row: Attributes,
  kind: BrokerExecutionMetadata["kind"],
): BrokerExecutionMetadata => ({
  provider: "ibkr-flex",
  kind,
  accountId: attr(row, "accountId"),
  tradeId: attr(row, "tradeID"),
  transactionId: attr(row, "transactionID"),
  executionId: attr(row, "ibExecID"),
  orderId: attr(row, "ibOrderID"),
  brokerageOrderId: attr(row, "brokerageOrderID"),
  orderReference: attr(row, "orderReference"),
  relatedTradeId: attr(row, "relatedTradeID"),
  relatedTransactionId: attr(row, "relatedTransactionID"),
  conid: attr(row, "conid"),
  openCloseIndicator: attr(row, "openCloseIndicator"),
  notes: attr(row, "notes", "notesCodes"),
  transactionType: attr(row, "transactionType"),
  realizedPnl: number(attr(row, "realizedPnl", "fifoPnlRealized")),
  proceeds: number(attr(row, "proceeds")),
  basis: number(attr(row, "cost", "costBasis", "basis")),
  taxes: number(attr(row, "taxes")),
});

const metadataId = (row: Attributes, index: number, prefix: string): string => {
  const brokerId = attr(row, "transactionID", "tradeID", "ibExecID");
  if (brokerId) return `${prefix}:${attr(row, "accountId") ?? ""}:${brokerId}`;
  return [
    prefix,
    attr(row, "accountId"),
    attr(row, "conid", "symbol"),
    attr(row, "dateTime", "date", "tradeDate"),
    attr(row, "buySell", "transactionType"),
    attr(row, "quantity"),
    attr(row, "tradePrice"),
    attr(row, "ibOrderID"),
    index,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join(":");
};

const instrument = (row: Attributes) =>
  resolveOptionInstrument({
    symbol: attr(row, "symbol"),
    description: attr(row, "description"),
    underlying: attr(row, "underlyingSymbol"),
    expiry: attr(row, "expiry"),
    strike: attr(row, "strike"),
    right: attr(row, "putCall"),
    assetClass: ASSET_CLASSES[attr(row, "assetCategory", "assetClass") ?? ""],
  });

const explicitStrategyGroup = (broker: BrokerExecutionMetadata): string | undefined => {
  // Combo legs have distinct ibOrderID values in real Flex statements, while
  // brokerageOrderID is shared by every leg of the parent spread order.
  const id = broker.brokerageOrderId ?? broker.orderReference ?? broker.orderId;
  return id ? `ibkr-order:${broker.accountId ?? ""}:${id}` : undefined;
};

const positionKey = (accountId: string | undefined, symbol: string): string =>
  `${accountId ?? ""}\u0000${symbol}`;

const executionPositionKey = (execution: ImportedExecution): string =>
  positionKey(execution.importMetadata?.broker?.accountId, execution.symbol);

const discardUnsharedExplicitGroups = (executions: ImportedExecution[]): void => {
  const symbolsByGroup = new Map<string, Set<string>>();
  for (const execution of executions) {
    const group = execution.importMetadata?.broker?.strategyGroupId;
    if (!group) continue;
    const symbols = symbolsByGroup.get(group) ?? new Set<string>();
    symbols.add(execution.symbol);
    symbolsByGroup.set(group, symbols);
  }
  for (const execution of executions) {
    const broker = execution.importMetadata?.broker;
    if (broker?.strategyGroupId && symbolsByGroup.get(broker.strategyGroupId)?.size === 1) {
      delete broker.strategyGroupId;
    }
  }
};

const VERTICAL_CLUSTER_MS = 3_000;

const addStructuralSpreadGroups = (executions: ImportedExecution[]): number => {
  const candidates = new Map<string, ImportedExecution[]>();
  for (const execution of executions) {
    const contract = parseOptionSymbol(execution.symbol);
    if (!contract || execution.importMetadata?.broker?.kind !== "trade") continue;
    if (execution.importMetadata.broker.strategyGroupId) continue;
    const key = [
      execution.importMetadata.broker.accountId ?? "",
      contract.underlying,
      contract.expiry,
      contract.right,
    ].join("|");
    const group = candidates.get(key);
    if (group) group.push(execution);
    else candidates.set(key, [execution]);
  }

  let grouped = 0;
  for (const [key, bucket] of candidates) {
    bucket.sort(
      (left, right) =>
        Date.parse(left.executedAt) - Date.parse(right.executedAt) ||
        (left.importMetadata?.order ?? 0) - (right.importMetadata?.order ?? 0),
    );
    const clusters: ImportedExecution[][] = [];
    for (const execution of bucket) {
      const cluster = clusters.at(-1);
      if (
        cluster &&
        Date.parse(execution.executedAt) - Date.parse(cluster[0]!.executedAt) <= VERTICAL_CLUSTER_MS
      ) {
        cluster.push(execution);
      } else {
        clusters.push([execution]);
      }
    }
    for (const [index, cluster] of clusters.entries()) {
      const symbols = [...new Set(cluster.map((execution) => execution.symbol))];
      if (symbols.length !== 2) continue;
      const [leftSymbol, rightSymbol] = symbols;
      const leftQty = cluster
        .filter((execution) => execution.symbol === leftSymbol)
        .reduce(
          (total, execution) =>
            total + (execution.side === "buy" ? execution.quantity : -execution.quantity),
          0,
        );
      const rightQty = cluster
        .filter((execution) => execution.symbol === rightSymbol)
        .reduce(
          (total, execution) =>
            total + (execution.side === "buy" ? execution.quantity : -execution.quantity),
          0,
        );
      if (Math.sign(leftQty) === Math.sign(rightQty) || Math.abs(leftQty) !== Math.abs(rightQty)) {
        continue;
      }
      const groupId = `ibkr-vertical:${key}|${cluster[0]!.executedAt}|${index}`;
      for (const execution of cluster) {
        execution.importMetadata!.broker!.strategyGroupId = groupId;
      }
      grouped++;
    }
  }
  return grouped;
};

const reconcileClosingTrades = (
  rows: ImportedExecution[],
): {
  executions: ImportedExecution[];
  signedPositions: Map<string, number>;
  clamped: number;
  omitted: number;
} => {
  const sorted = [...rows].sort(
    (left, right) =>
      Date.parse(left.executedAt) - Date.parse(right.executedAt) ||
      (left.importMetadata?.order ?? 0) - (right.importMetadata?.order ?? 0),
  );
  const executions: ImportedExecution[] = [];
  const signedPositions = new Map<string, number>();
  let clamped = 0;
  let omitted = 0;

  for (const execution of sorted) {
    const openClose = execution.importMetadata?.broker?.openCloseIndicator?.toUpperCase();
    const key = executionPositionKey(execution);
    const current = signedPositions.get(key) ?? 0;
    const signed = execution.side === "buy" ? execution.quantity : -execution.quantity;
    let next = execution;
    if (openClose?.startsWith("C")) {
      if (Math.abs(current) <= 1e-9 || Math.sign(current) === Math.sign(signed)) {
        omitted++;
        continue;
      }
      const closingQuantity = Math.min(execution.quantity, Math.abs(current));
      if (closingQuantity < execution.quantity) {
        next = { ...execution, quantity: closingQuantity };
        clamped++;
      }
    }
    const nextSigned = next.side === "buy" ? next.quantity : -next.quantity;
    signedPositions.set(key, current + nextSigned);
    executions.push(next);
  }
  return { executions, signedPositions, clamped, omitted };
};

const deduplicateNormalizedTrades = (rows: ImportedExecution[]): ImportedExecution[] => {
  const seenBrokerIds = new Set<string>();
  const seenFallbacks = new Set<string>();
  return rows.filter((row) => {
    const broker = row.importMetadata?.broker;
    const brokerId = broker?.transactionId ?? broker?.tradeId ?? broker?.executionId;
    if (brokerId) {
      const key = `${broker?.accountId ?? ""}|${brokerId}`;
      if (seenBrokerIds.has(key)) return false;
      seenBrokerIds.add(key);
      return true;
    }
    const fallback = [
      row.symbol,
      row.side,
      row.quantity.toPrecision(12),
      row.price.toPrecision(12),
      row.executedAt,
    ].join("|");
    if (seenFallbacks.has(fallback)) return false;
    seenFallbacks.add(fallback);
    return true;
  });
};

const deduplicateBrokerIds = (rows: ImportedExecution[]): ImportedExecution[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = row.importMetadata?.id;
    if (!id || !seen.has(id)) {
      if (id) seen.add(id);
      return true;
    }
    return false;
  });
};

export const parseIbkrFlexSync = (
  xml: string,
  input: Date | IbkrFlexParseOptions = {},
): IbkrFlexSyncResult => {
  const options: IbkrFlexParseOptions = input instanceof Date ? { now: input } : input;
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "UTC";
  const reconcileWindow = options.reconcileWindow ?? true;
  const warnings: string[] = [];
  const tradeExecutions: ImportedExecution[] = [];
  let unpricedClosingTrades = 0;
  let zeroPriceTrades = 0;
  let untimedTrades = 0;
  let invalidTrades = 0;

  for (const [index, row] of statementElements(xml, "Trade").entries()) {
    const resolved = instrument(row);
    const sideRaw = attr(row, "buySell")?.toUpperCase();
    const quantity = Math.abs(number(attr(row, "quantity")) ?? 0);
    const reportedPrice = number(attr(row, "tradePrice"));
    const executedAt = flexTimestamp(attr(row, "dateTime", "tradeDate"), timeZone);
    const broker = brokerMetadata(row, "trade");
    const multiplier = number(attr(row, "multiplier")) ?? 100;
    let price = reportedPrice;
    if (
      resolved.assetClass === "option" &&
      broker.openCloseIndicator?.toUpperCase().startsWith("C") &&
      reportedPrice === 0
    ) {
      price =
        broker.basis !== undefined &&
        broker.realizedPnl !== undefined &&
        quantity > 0 &&
        multiplier > 0
          ? Math.abs(broker.basis - broker.realizedPnl) / (quantity * multiplier)
          : undefined;
      if (price !== undefined) broker.settlementPriceSource = "realized-pnl-basis";
    } else if (reportedPrice !== undefined) {
      broker.settlementPriceSource = "trade-price";
    }
    // Outside option settlement a zero price is a transfer or corporate action, not a fill.
    const zeroPrice = resolved.assetClass !== "option" && price === 0;
    if (
      !resolved.symbol ||
      (sideRaw !== "BUY" && sideRaw !== "SELL") ||
      quantity <= 0 ||
      price === undefined ||
      price < 0 ||
      zeroPrice ||
      !executedAt
    ) {
      if (zeroPrice) zeroPriceTrades++;
      else if (!executedAt && price !== undefined) untimedTrades++;
      else if (
        resolved.assetClass === "option" &&
        broker.openCloseIndicator?.toUpperCase().startsWith("C") &&
        reportedPrice === 0 &&
        price === undefined
      ) {
        unpricedClosingTrades++;
      } else invalidTrades++;
      continue;
    }
    broker.strategyGroupId = explicitStrategyGroup(broker);
    tradeExecutions.push({
      symbol: resolved.symbol,
      side: sideRaw === "BUY" ? "buy" : "sell",
      quantity,
      price,
      fee: Math.abs(number(attr(row, "ibCommission")) ?? 0) + Math.abs(broker.taxes ?? 0),
      executedAt,
      assetClass: resolved.assetClass,
      importMetadata: {
        id: metadataId(row, index, "ibkr-trade"),
        ...(broker.accountId ? { group: `ibkr-account:${broker.accountId}` } : {}),
        order: index,
        preserveFee: true,
        broker,
      },
    });
  }
  if (zeroPriceTrades + invalidTrades > 0)
    warnings.push(
      `${zeroPriceTrades + invalidTrades} Trade row(s) were skipped: a missing symbol, side, quantity or price, or a zero price outside option settlement.`,
    );
  if (untimedTrades > 0)
    warnings.push(
      `${untimedFillsReason(untimedTrades, true)} Flex dates must use the default yyyyMMdd date and HHmmss time formats.`,
    );
  if (unpricedClosingTrades > 0) {
    warnings.push(
      `${unpricedClosingTrades} zero-price option closing fill(s) lacked both Cost Basis and Realized P/L, so their settlement value could not be determined and they were not journaled.`,
    );
  }

  const normalizedTrades = reconcileWindow
    ? deduplicateNormalizedTrades(tradeExecutions)
    : deduplicateBrokerIds(tradeExecutions);
  const reconciled = reconcileWindow
    ? reconcileClosingTrades(normalizedTrades)
    : {
        executions: normalizedTrades,
        signedPositions: normalizedTrades.reduce((positions, execution) => {
          const signed = execution.side === "buy" ? execution.quantity : -execution.quantity;
          const key = executionPositionKey(execution);
          positions.set(key, (positions.get(key) ?? 0) + signed);
          return positions;
        }, new Map<string, number>()),
        clamped: 0,
        omitted: 0,
      };
  const executions = reconciled.executions;
  if (reconciled.clamped > 0 || reconciled.omitted > 0) {
    warnings.push(
      `${reconciled.clamped} closing fill(s) were limited to the position visible inside the query window and ${reconciled.omitted} unmatched closing fill(s) were omitted, preventing pre-window history from creating false reverse positions.`,
    );
  }
  discardUnsharedExplicitGroups(executions);
  const inferredSpreadOrders = addStructuralSpreadGroups(executions);
  const spreadOrders = new Set(
    executions
      .map((execution) => execution.importMetadata?.broker?.strategyGroupId)
      .filter((value): value is string => Boolean(value)),
  );
  const signedPositions = reconciled.signedPositions;

  let lifecycleClosures = 0;
  let unresolvedLifecycleEvents = 0;
  const lifecycleRows = statementElements(xml, "OptionEAE");
  for (const [index, row] of lifecycleRows.entries()) {
    const resolved = instrument(row);
    if (resolved.assetClass !== "option" || resolved.missingContract) continue;
    const reportedQuantity = Math.abs(number(attr(row, "quantity")) ?? 0);
    const executedAt = flexTimestamp(attr(row, "dateTime", "date", "tradeDate"), timeZone, true);
    const transactionType = attr(row, "transactionType")?.toUpperCase() ?? "";
    const key = positionKey(attr(row, "accountId"), resolved.symbol);
    const openQuantity = signedPositions.get(key) ?? 0;
    const side = openQuantity > 0 ? "sell" : openQuantity < 0 ? "buy" : undefined;
    const quantity = Math.min(reportedQuantity, Math.abs(openQuantity));
    const multiplier = number(attr(row, "multiplier")) ?? 100;
    const proceeds = number(attr(row, "proceeds"));
    const reportedPrice = number(attr(row, "tradePrice"));
    const price =
      reportedPrice ??
      (proceeds !== undefined && quantity > 0 && multiplier > 0
        ? Math.abs(proceeds) / (quantity * multiplier)
        : undefined);

    if (!side || quantity <= 0 || !executedAt || price === undefined || price < 0) {
      unresolvedLifecycleEvents++;
      warnings.push(
        `${resolved.symbol}: ${transactionType || "option lifecycle event"} lacks enough direction, quantity, date, Trade Price or Proceeds data to determine its expiration value.`,
      );
      continue;
    }

    const broker = brokerMetadata(row, "option-lifecycle");
    broker.settlementPriceSource = reportedPrice !== undefined ? "trade-price" : "proceeds";
    executions.push({
      symbol: resolved.symbol,
      side,
      quantity,
      price,
      fee: Math.abs(number(attr(row, "commTax", "commission", "ibCommission")) ?? 0),
      executedAt,
      assetClass: "option",
      importMetadata: {
        id: metadataId(row, index, "ibkr-option-lifecycle"),
        ...(broker.accountId ? { group: `ibkr-account:${broker.accountId}` } : {}),
        order: executions.length + index,
        preserveFee: true,
        broker,
      },
    });
    signedPositions.set(key, openQuantity + (side === "buy" ? quantity : -quantity));
    lifecycleClosures++;
  }

  const openPositionSymbols = new Set(
    statementElements(xml, "OpenPosition").flatMap((row) => {
      const symbol = instrument(row).symbol;
      return symbol ? [positionKey(attr(row, "accountId"), symbol)] : [];
    }),
  );
  const today = now.toISOString().slice(0, 10);
  const expiredWithoutLifecycle = [...signedPositions].filter(([key, quantity]) => {
    if (Math.abs(quantity) <= 1e-9 || openPositionSymbols.has(key)) return false;
    const symbol = key.split("\u0000")[1] ?? key;
    const contract = parseOptionSymbol(symbol);
    return contract !== null && contract.expiry < today;
  });
  if ((options.reportExpiredGaps ?? reconcileWindow) && expiredWithoutLifecycle.length > 0) {
    warnings.push(
      `${expiredWithoutLifecycle.length} expired option contract(s) are absent from current positions but have no usable Option Exercises, Assignments and Expirations record. Their expiration proceeds and P&L cannot be determined from the exposed data.`,
    );
  }

  return {
    executions,
    warnings,
    stats: {
      trades: executions.length - lifecycleClosures,
      lifecycleEvents: lifecycleRows.length,
      lifecycleClosures,
      unresolvedLifecycleEvents,
      skippedTrades: zeroPriceTrades + untimedTrades + invalidTrades + unpricedClosingTrades,
      expiredContractsWithoutLifecycle: expiredWithoutLifecycle.length,
      identifiedSpreadOrders: spreadOrders.size || inferredSpreadOrders,
    },
  };
};

export const parseIbkrFlexXmlImport = (content: string, timeZone = "UTC"): ParsedImport => {
  const result = parseIbkrFlexSync(content, {
    timeZone,
    reconcileWindow: false,
    reportExpiredGaps: false,
  });
  return {
    format: "ibkr-flex-xml",
    executions: result.executions,
    skippedRows: result.stats.unresolvedLifecycleEvents + result.stats.skippedTrades,
    warnings: result.warnings,
    ...(result.executions.length === 0
      ? {
          errors: [
            "No usable Trade or option lifecycle records were found in the Flex XML. Include the Trades section at Execution level in the Flex Query.",
          ],
        }
      : {}),
  };
};
