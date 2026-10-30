"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BenchmarkPoint } from "@luxalgo/journal-core";
import { fmtMoney } from "@/lib/utils";
import { usePrivacy } from "../privacy";
import { tooltipStyle, useVizTokens } from "./tokens";
import { ChartFrame } from "./chart-frame";

const shortDate = (value: string) => `${value.slice(8, 10)}/${value.slice(5, 7)}`;

/** Strategy P&L, the benchmark's P&L on the same capital, and strategy drawdown. */
export function BenchmarkChart({
  points,
  symbol,
  currency = "USD",
  height = 260,
  compact = false,
}: {
  points: BenchmarkPoint[];
  symbol: string;
  currency?: string;
  height?: number;
  compact?: boolean;
}) {
  const t = useVizTokens();
  const privateMode = usePrivacy();
  if (!t) return <div style={{ height }} />;
  const money = (value: number) => (privateMode ? "••••" : fmtMoney(value, currency));
  const names: Record<string, string> = {
    strategyPnl: "Strategy P&L",
    benchmarkPnl: `${symbol} benchmark`,
    drawdown: "Drawdown",
  };
  return (
    <ChartFrame height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          key={String(privateMode)}
          data={points}
          margin={{ top: 8, right: 8, bottom: 0, left: compact ? 0 : 8 }}
        >
          <CartesianGrid stroke={t.gridline} strokeWidth={1} vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: t.inkMuted, fontSize: compact ? 10 : 11 }}
            tickLine={false}
            axisLine={{ stroke: t.baseline }}
            minTickGap={compact ? 24 : 40}
            tickFormatter={shortDate}
          />
          <YAxis
            tick={{ fill: t.inkMuted, fontSize: compact ? 10 : 11 }}
            tickLine={false}
            axisLine={false}
            width={compact ? 56 : 70}
            tickFormatter={(value: number) => money(value).replace(".00", "")}
          />
          <ReferenceLine y={0} stroke={t.baseline} />
          <Tooltip
            contentStyle={tooltipStyle(t)}
            labelFormatter={(value) => String(value)}
            formatter={(value, key) => [money(Number(value)), names[String(key)] ?? key]}
            cursor={{ stroke: t.inkMuted, strokeDasharray: "3 3" }}
          />
          <Legend
            iconType="plainline"
            iconSize={14}
            wrapperStyle={{ fontSize: compact ? 10 : 11, color: t.inkMuted }}
            formatter={(key) => names[String(key)] ?? key}
            itemSorter={(item) => Object.keys(names).indexOf(String(item.dataKey))}
          />
          <Area
            type="linear"
            dataKey="drawdown"
            stroke={t.loss}
            strokeWidth={1.5}
            fill={t.loss}
            fillOpacity={0.22}
            baseValue={0}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="benchmarkPnl"
            stroke={t.inkMuted}
            strokeWidth={2}
            strokeDasharray="6 4"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="strategyPnl"
            stroke={t.brand}
            strokeWidth={2.25}
            dot={points.length <= 2 ? { r: 3 } : false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
