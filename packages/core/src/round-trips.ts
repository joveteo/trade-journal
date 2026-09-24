import { formatOptionSymbol, parseOptionSymbol, resolveContractMultiplier } from "./options";
import type {
  Execution,
  ExitAttribution,
  ProfitCalcMethod,
  RoundTrip,
  TradeDirection,
} from "./types";

/** Positions smaller than this are considered flat (guards float drift on fractional crypto sizes). */
const FLAT_EPS = 1e-9;

export interface BuildRoundTripsOptions {
  method?: ProfitCalcMethod;
  /**
   * Per-symbol contract multiplier (futures point value, option contract size).
   * P&L for a matched chunk is (priceDiff × qty × multiplier). Defaults to 1.
   */
  multipliers?: Record<string, number>;
}

interface OpenLot {
  quantity: number;
  price: number;
}

interface OpenCycle {
  direction: TradeDirection;
  openedAt: string;
  lots: OpenLot[];
  entryQuantity: number;
  entryNotional: number;
  exitQuantity: number;
  exitNotional: number;
  grossPnl: number;
  fees: number;
  executionIds: string[];
  exits: ExitAttribution[];
  executionCount: number;
}

const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);

const openQuantityOf = (cycle: OpenCycle): number => sum(cycle.lots.map((lot) => lot.quantity));

/**
 * Consume `quantity` from the cycle's open lots under the given method and
 * return the total entry notional matched (entry price × matched quantity).
 */
const consumeLots = (cycle: OpenCycle, quantity: number, method: ProfitCalcMethod): number => {
  let remaining = quantity;
  let matchedNotional = 0;

  if (method === "wavg") {
    const totalQty = openQuantityOf(cycle);
    const totalNotional = sum(cycle.lots.map((lot) => lot.quantity * lot.price));
    const avgPrice = totalQty > 0 ? totalNotional / totalQty : 0;
    matchedNotional = avgPrice * quantity;
    const scale = totalQty > 0 ? (totalQty - quantity) / totalQty : 0;
    cycle.lots = cycle.lots
      .map((lot) => ({ ...lot, quantity: lot.quantity * scale }))
      .filter((lot) => lot.quantity > FLAT_EPS);
    return matchedNotional;
  }

  while (remaining > FLAT_EPS && cycle.lots.length > 0) {
    const index = method === "fifo" ? 0 : cycle.lots.length - 1;
    const lot = cycle.lots[index]!;
    const take = Math.min(lot.quantity, remaining);
    matchedNotional += take * lot.price;
    lot.quantity -= take;
    remaining -= take;
    if (lot.quantity <= FLAT_EPS) cycle.lots.splice(index, 1);
  }
  return matchedNotional;
};

const finalizeCycle = (
  cycle: OpenCycle,
  accountId: string,
  symbol: string,
  assetClass: Execution["assetClass"],
  closedAt: string | undefined,
  keyCollisions: Map<string, number>,
  importGroup?: string,
  contractMultiplier?: number,
): RoundTrip => {
  const openQuantity = openQuantityOf(cycle);
  const netPnl = cycle.grossPnl - cycle.fees;
  const isOpen = openQuantity > FLAT_EPS;
  const status: RoundTrip["status"] = isOpen
    ? "open"
    : Math.abs(netPnl) <= 1e-9
      ? "breakeven"
      : netPnl > 0
        ? "win"
        : "loss";

  const baseKey = `${accountId}|${symbol}|${cycle.direction}|${cycle.openedAt}${importGroup ? `|import:${encodeURIComponent(importGroup)}` : ""}`;
  const collision = keyCollisions.get(baseKey) ?? 0;
  keyCollisions.set(baseKey, collision + 1);
  const key = collision === 0 ? baseKey : `${baseKey}|${collision}`;

  return {
    key,
    accountId,
    symbol,
    assetClass,
    direction: cycle.direction,
    status,
    openedAt: cycle.openedAt,
    closedAt: isOpen ? undefined : closedAt,
    quantity: cycle.entryQuantity,
    openQuantity: isOpen ? openQuantity : 0,
    avgEntry: cycle.entryQuantity > 0 ? cycle.entryNotional / cycle.entryQuantity : 0,
    avgExit: cycle.exitQuantity > 0 ? cycle.exitNotional / cycle.exitQuantity : undefined,
    grossPnl: cycle.grossPnl,
    fees: cycle.fees,
    netPnl,
    executionCount: cycle.executionCount,
    executionIds: cycle.executionIds,
    exits: cycle.exits,
    durationMs: !isOpen && closedAt ? Date.parse(closedAt) - Date.parse(cycle.openedAt) : undefined,
    ...(contractMultiplier !== undefined ? { contractMultiplier } : {}),
  };
};

const compareNumbers = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

/** Fills without an import order sort after every ordered fill at the same instant. */
const importOrderOf = (execution: Execution): number =>
  execution.importMetadata?.order ?? Number.POSITIVE_INFINITY;

/**
 * Total order over executions: time, then import order, then id. Every fill has
 * a defined value at each level, so the comparator is transitive and the result
 * never depends on the input order.
 */
const compareExecutions = (a: Execution, b: Execution): number =>
  compareNumbers(Date.parse(a.executedAt), Date.parse(b.executedAt)) ||
  compareNumbers(importOrderOf(a), importOrderOf(b)) ||
  a.id.localeCompare(b.id);

const verticalSymbol = (
  left: NonNullable<ReturnType<typeof parseOptionSymbol>>,
  right: NonNullable<ReturnType<typeof parseOptionSymbol>>,
): string => {
  const low = Math.min(left.strike, right.strike);
  const high = Math.max(left.strike, right.strike);
  const firstLeg = formatOptionSymbol({ ...left, strike: low });
  const legSuffix = ` ${low} ${left.right}`;
  return `${firstLeg.slice(0, -legSuffix.length)} ${low}/${high} ${left.right} VERTICAL`;
};

/** Combo legs and paired tickets often print 1–2 seconds apart. */
const VERTICAL_PAIR_WINDOW_MS = 3_000;

export interface VerticalFill {
  side: "buy" | "sell";
  quantity: number;
  price: number;
  executedAt: string;
}

/**
 * Collapse simultaneous vertical-leg fills into the net premium the spread
 * actually traded, so charts show one credit/debit print instead of two
 * contract prices.
 */
export const netVerticalExecutions = <T extends VerticalFill>(executions: T[]): T[] => {
  const sorted = [...executions].sort(
    (left, right) =>
      Date.parse(left.executedAt) - Date.parse(right.executedAt) ||
      left.side.localeCompare(right.side),
  );
  const clusters: T[][] = [];
  for (const fill of sorted) {
    const cluster = clusters.at(-1);
    if (
      cluster &&
      Date.parse(fill.executedAt) - Date.parse(cluster[0]!.executedAt) <= VERTICAL_PAIR_WINDOW_MS
    ) {
      cluster.push(fill);
    } else {
      clusters.push([fill]);
    }
  }
  return clusters.flatMap((cluster) => {
    const buyQty = sum(cluster.filter((fill) => fill.side === "buy").map((fill) => fill.quantity));
    const sellQty = sum(
      cluster.filter((fill) => fill.side === "sell").map((fill) => fill.quantity),
    );
    if (buyQty <= FLAT_EPS || sellQty <= FLAT_EPS) return cluster;
    const buyNotional = sum(
      cluster.filter((fill) => fill.side === "buy").map((fill) => fill.price * fill.quantity),
    );
    const sellNotional = sum(
      cluster.filter((fill) => fill.side === "sell").map((fill) => fill.price * fill.quantity),
    );
    const quantity = Math.min(buyQty, sellQty);
    const net = Math.abs(sellNotional / sellQty - buyNotional / buyQty);
    return [
      {
        ...cluster[0]!,
        side: sellNotional > buyNotional + FLAT_EPS ? "sell" : "buy",
        quantity,
        price: net,
        executedAt: cluster[0]!.executedAt,
      },
    ];
  });
};

const sameUtcDay = (left?: string, right?: string): boolean =>
  Boolean(left && right && left.slice(0, 10) === right.slice(0, 10));

const closeTimesCompatible = (left: RoundTrip, right: RoundTrip): boolean => {
  if (!left.closedAt && !right.closedAt) return true;
  if (!left.closedAt || !right.closedAt) return false;
  return (
    Math.abs(Date.parse(left.closedAt) - Date.parse(right.closedAt)) <= VERTICAL_PAIR_WINDOW_MS ||
    sameUtcDay(left.closedAt, right.closedAt)
  );
};

const verticalDirection = (
  left: RoundTrip,
  right: RoundTrip,
  leftContract: NonNullable<ReturnType<typeof parseOptionSymbol>>,
  rightContract: NonNullable<ReturnType<typeof parseOptionSymbol>>,
): TradeDirection | null => {
  if (left.direction === right.direction) return null;
  const shortStrike = left.direction === "short" ? leftContract.strike : rightContract.strike;
  const longStrike = left.direction === "long" ? leftContract.strike : rightContract.strike;
  return shortStrike > longStrike ? "long" : "short";
};

const compatibleVerticalLegs = (
  left: RoundTrip,
  right: RoundTrip,
): {
  leftContract: NonNullable<ReturnType<typeof parseOptionSymbol>>;
  rightContract: NonNullable<ReturnType<typeof parseOptionSymbol>>;
  direction: TradeDirection;
} | null => {
  const leftContract = parseOptionSymbol(left.symbol);
  const rightContract = parseOptionSymbol(right.symbol);
  if (
    !leftContract ||
    !rightContract ||
    left.accountId !== right.accountId ||
    leftContract.underlying !== rightContract.underlying ||
    leftContract.expiry !== rightContract.expiry ||
    leftContract.right !== rightContract.right ||
    leftContract.strike === rightContract.strike ||
    left.quantity <= FLAT_EPS ||
    Math.abs(left.quantity - right.quantity) > FLAT_EPS ||
    Math.abs(left.openQuantity - right.openQuantity) > FLAT_EPS
  ) {
    return null;
  }
  const direction = verticalDirection(left, right, leftContract, rightContract);
  if (!direction) return null;
  return { leftContract, rightContract, direction };
};

const mergeVerticalLegs = (
  left: RoundTrip,
  right: RoundTrip,
  leftContract: NonNullable<ReturnType<typeof parseOptionSymbol>>,
  rightContract: NonNullable<ReturnType<typeof parseOptionSymbol>>,
  direction: TradeDirection,
): RoundTrip => {
  const quantity = left.quantity;
  const signedEntry =
    (left.direction === "long" ? 1 : -1) * left.avgEntry * left.quantity +
    (right.direction === "long" ? 1 : -1) * right.avgEntry * right.quantity;
  const openQuantity = left.openQuantity;
  const exitedQuantity = quantity - openQuantity;
  const signedExit =
    (left.direction === "long" ? 1 : -1) * (left.avgExit ?? 0) * exitedQuantity +
    (right.direction === "long" ? 1 : -1) * (right.avgExit ?? 0) * exitedQuantity;
  const grossPnl = left.grossPnl + right.grossPnl;
  const fees = left.fees + right.fees;
  const netPnl = grossPnl - fees;
  const isOpen = openQuantity > FLAT_EPS;
  const openedAt =
    Date.parse(left.openedAt) <= Date.parse(right.openedAt) ? left.openedAt : right.openedAt;
  const closedAt = isOpen
    ? undefined
    : Date.parse(left.closedAt!) >= Date.parse(right.closedAt!)
      ? left.closedAt
      : right.closedAt;
  const symbol = verticalSymbol(leftContract, rightContract);
  const status: RoundTrip["status"] = isOpen
    ? "open"
    : Math.abs(netPnl) <= FLAT_EPS
      ? "breakeven"
      : netPnl > 0
        ? "win"
        : "loss";
  return {
    key: `${left.accountId}|${symbol}|${direction}|${openedAt}|vertical`,
    accountId: left.accountId,
    symbol,
    assetClass: "option",
    direction,
    status,
    openedAt,
    closedAt,
    quantity,
    openQuantity,
    avgEntry: quantity > FLAT_EPS ? Math.abs(signedEntry) / quantity : 0,
    avgExit: exitedQuantity > FLAT_EPS ? Math.abs(signedExit) / exitedQuantity : undefined,
    grossPnl,
    fees,
    netPnl,
    executionCount: new Set([...left.executionIds, ...right.executionIds]).size,
    executionIds: [...new Set([...left.executionIds, ...right.executionIds])],
    exits: [...left.exits, ...right.exits],
    durationMs: closedAt ? Date.parse(closedAt) - Date.parse(openedAt) : undefined,
    contractMultiplier: left.contractMultiplier ?? right.contractMultiplier,
  };
};

/**
 * IBKR identifies the legs of each combo order, but does not expose one id for
 * the spread's entire lifetime. Join the two per-contract round trips through
 * their shared opening order, then pair leftover same-expiry opposite legs that
 * opened together (partial fills of a vertical are often two tickets, not a combo).
 */
const combineOptionVerticals = (trips: RoundTrip[], executions: Execution[]): RoundTrip[] => {
  const executionById = new Map(executions.map((execution) => [execution.id, execution]));
  const tripIndexesByOpeningGroup = new Map<string, Set<number>>();

  trips.forEach((trip, index) => {
    const entrySide = trip.direction === "long" ? "buy" : "sell";
    for (const executionId of trip.executionIds) {
      const execution = executionById.get(executionId);
      const groupId = execution?.importMetadata?.broker?.strategyGroupId;
      if (!execution || !groupId || execution.side !== entrySide) continue;
      const openClose = execution.importMetadata?.broker?.openCloseIndicator?.toUpperCase();
      if (openClose?.startsWith("C")) continue;
      const indexes = tripIndexesByOpeningGroup.get(groupId) ?? new Set<number>();
      indexes.add(index);
      tripIndexesByOpeningGroup.set(groupId, indexes);
    }
  });

  const candidates: { indexes: [number, number]; groupId: string }[] = [];
  for (const [groupId, indexSet] of tripIndexesByOpeningGroup) {
    const indexes = [...indexSet].sort(compareNumbers);
    if (indexes.length === 2) candidates.push({ indexes: [indexes[0]!, indexes[1]!], groupId });
  }
  candidates.sort((left, right) => left.groupId.localeCompare(right.groupId));

  const consumed = new Set<number>();
  const combined: RoundTrip[] = [];
  for (const {
    indexes: [leftIndex, rightIndex],
  } of candidates) {
    if (consumed.has(leftIndex) || consumed.has(rightIndex)) continue;
    const left = trips[leftIndex]!;
    const right = trips[rightIndex]!;
    const compatible = compatibleVerticalLegs(left, right);
    if (!compatible) continue;
    combined.push(
      mergeVerticalLegs(
        left,
        right,
        compatible.leftContract,
        compatible.rightContract,
        compatible.direction,
      ),
    );
    consumed.add(leftIndex);
    consumed.add(rightIndex);
  }

  const leftover = trips
    .map((trip, index) => ({ trip, index }))
    .filter(({ index }) => !consumed.has(index));
  const leftoverByStructure = new Map<string, { trip: RoundTrip; index: number }[]>();
  for (const item of leftover) {
    const contract = parseOptionSymbol(item.trip.symbol);
    if (!contract) continue;
    const key = `${item.trip.accountId}|${contract.underlying}|${contract.expiry}|${contract.right}`;
    const group = leftoverByStructure.get(key) ?? [];
    group.push(item);
    leftoverByStructure.set(key, group);
  }
  for (const group of leftoverByStructure.values()) {
    group.sort(
      (left, right) =>
        Date.parse(left.trip.openedAt) - Date.parse(right.trip.openedAt) ||
        left.trip.symbol.localeCompare(right.trip.symbol),
    );
    for (let i = 0; i < group.length; i++) {
      const left = group[i]!;
      if (consumed.has(left.index)) continue;
      for (let j = i + 1; j < group.length; j++) {
        const right = group[j]!;
        if (consumed.has(right.index)) continue;
        if (
          Math.abs(Date.parse(left.trip.openedAt) - Date.parse(right.trip.openedAt)) >
          VERTICAL_PAIR_WINDOW_MS
        ) {
          break;
        }
        if (!closeTimesCompatible(left.trip, right.trip)) continue;
        const compatible = compatibleVerticalLegs(left.trip, right.trip);
        if (!compatible) continue;
        combined.push(
          mergeVerticalLegs(
            left.trip,
            right.trip,
            compatible.leftContract,
            compatible.rightContract,
            compatible.direction,
          ),
        );
        consumed.add(left.index);
        consumed.add(right.index);
        break;
      }
    }
  }

  return [...trips.filter((_, index) => !consumed.has(index)), ...combined].sort(
    (left, right) =>
      Date.parse(left.openedAt) - Date.parse(right.openedAt) || left.key.localeCompare(right.key),
  );
};

/**
 * Build round trips (position cycles, flat → flat) from raw executions.
 *
 * Invariants this function defends:
 * - A fill that crosses through flat is split: the crossing part closes the
 *   cycle, the remainder opens a new cycle in the opposite direction, and the
 *   fee is split pro-rata by quantity.
 * - The total P&L of a completed cycle is independent of the profit-calc
 *   method; the method only changes per-exit attribution.
 * - Executions are processed in `executedAt` order (import order, then id, as
 *   tiebreaks) so results are deterministic regardless of input order.
 * - When a symbol has a contract multiplier, the round trip carries it as
 *   `contractMultiplier` so derivative R statistics can be computed.
 */
export const buildRoundTrips = (
  executions: Execution[],
  options: BuildRoundTripsOptions = {},
): RoundTrip[] => {
  const method = options.method ?? "fifo";
  const trips: RoundTrip[] = [];
  const keyCollisions = new Map<string, number>();

  const groups = new Map<string, Execution[]>();
  for (const execution of executions) {
    const groupKey = `${execution.accountId}\u0000${execution.symbol}${execution.importMetadata?.group ? `\u0000${execution.importMetadata.group}` : ""}`;
    const group = groups.get(groupKey);
    if (group) group.push(execution);
    else groups.set(groupKey, [execution]);
  }

  for (const group of groups.values()) {
    group.sort(compareExecutions);
    const { accountId, symbol } = group[0]!;
    const importGroup = group[0]!.importMetadata?.group;
    const assetClass = group.find((e) => e.assetClass)?.assetClass;
    const contractMultiplier = resolveContractMultiplier(symbol, assetClass, options.multipliers);
    const multiplier = contractMultiplier ?? 1;

    let cycle: OpenCycle | null = null;

    for (const execution of group) {
      let signedQty = execution.side === "buy" ? execution.quantity : -execution.quantity;
      let feeRemaining = execution.fee;
      let counted = false;

      while (Math.abs(signedQty) > FLAT_EPS) {
        if (!cycle) {
          cycle = {
            direction: signedQty > 0 ? "long" : "short",
            openedAt: execution.executedAt,
            lots: [],
            entryQuantity: 0,
            entryNotional: 0,
            exitQuantity: 0,
            exitNotional: 0,
            grossPnl: 0,
            fees: 0,
            executionIds: [],
            exits: [],
            executionCount: 0,
          };
        }

        const isEntry =
          (cycle.direction === "long" && signedQty > 0) ||
          (cycle.direction === "short" && signedQty < 0);

        if (!counted) {
          cycle.executionIds.push(execution.id);
          cycle.executionCount += 1;
          counted = true;
        } else if (!cycle.executionIds.includes(execution.id)) {
          // The remainder of a flat-crossing fill lands in the new cycle too.
          cycle.executionIds.push(execution.id);
          cycle.executionCount += 1;
        }

        if (isEntry) {
          const qty = Math.abs(signedQty);
          cycle.lots.push({ quantity: qty, price: execution.price });
          cycle.entryQuantity += qty;
          cycle.entryNotional += qty * execution.price;
          cycle.fees += feeRemaining;
          feeRemaining = 0;
          signedQty = 0;
        } else {
          const openQty = openQuantityOf(cycle);
          const exitQty = Math.min(Math.abs(signedQty), openQty);
          const matchedNotional = consumeLots(cycle, exitQty, method);
          const exitNotional = exitQty * execution.price;
          const chunkGross =
            execution.importMetadata?.reportedGrossPnl ??
            (cycle.direction === "long"
              ? (exitNotional - matchedNotional) * multiplier
              : (matchedNotional - exitNotional) * multiplier);

          const feeShare =
            Math.abs(signedQty) > 0 ? feeRemaining * (exitQty / Math.abs(signedQty)) : 0;
          cycle.grossPnl += chunkGross;
          cycle.fees += feeShare;
          feeRemaining -= feeShare;
          cycle.exitQuantity += exitQty;
          cycle.exitNotional += exitNotional;
          cycle.exits.push({ executionId: execution.id, grossPnl: chunkGross, quantity: exitQty });

          signedQty += cycle.direction === "long" ? exitQty : -exitQty;

          if (openQuantityOf(cycle) <= FLAT_EPS) {
            trips.push(
              finalizeCycle(
                cycle,
                accountId,
                symbol,
                assetClass,
                execution.executedAt,
                keyCollisions,
                importGroup,
                contractMultiplier,
              ),
            );
            cycle = null;
            // Any residual signedQty flips direction and opens a new cycle on
            // the next loop iteration; residual fee follows it.
          }
        }
      }

      // A zero-quantity execution (bad data) still shouldn't leak fees.
      if (feeRemaining !== 0 && cycle) {
        cycle.fees += feeRemaining;
      }
    }

    if (cycle) {
      trips.push(
        finalizeCycle(
          cycle,
          accountId,
          symbol,
          assetClass,
          undefined,
          keyCollisions,
          importGroup,
          contractMultiplier,
        ),
      );
    }
  }

  trips.sort(
    (a, b) => Date.parse(a.openedAt) - Date.parse(b.openedAt) || a.key.localeCompare(b.key),
  );
  return combineOptionVerticals(trips, executions);
};
