"use client";

import {
  Area,
  AreaChart as RAreaChart,
  Bar,
  BarChart as RBarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart as RPieChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { BarChart3 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";

/** Theme palette (CSS variables defined in globals.css; they adapt to light/dark). */
export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

export const chartColor = (i: number) => CHART_COLORS[i % CHART_COLORS.length];

export interface ChartSeries {
  /** Key in each data row. */
  key: string;
  label?: string;
  /** Any CSS colour; defaults to the theme palette by index. */
  color?: string;
}

export interface ChartCardProps {
  title: string;
  description?: React.ReactNode;
  /** Right side of the header (range picker, toggle...). */
  action?: React.ReactNode;
  loading?: boolean;
  /** When true shows the empty state instead of children. */
  empty?: boolean;
  emptyText?: string;
  className?: string;
  children: React.ReactNode;
}

/** Card frame for a chart: title, description, action slot, loading skeleton and empty state. */
export function ChartCard({ title, description, action, loading, empty, emptyText = "No data for this period", className, children }: ChartCardProps) {
  return (
    <Card className={cn("gap-4", className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-[260px] w-full" />
        ) : empty ? (
          <EmptyState icon={BarChart3} title={emptyText} className="h-[260px] border-0" />
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function buildConfig(series: ChartSeries[]): ChartConfig {
  const cfg: ChartConfig = {};
  series.forEach((s, i) => {
    cfg[s.key] = { label: s.label ?? s.key, color: s.color ?? chartColor(i) };
  });
  return cfg;
}

interface BaseChartProps {
  data: Array<Record<string, string | number | null>>;
  /** Key of the x axis (date label, model name...). */
  xKey: string;
  series: ChartSeries[];
  height?: number;
  /** Formats y-axis ticks and tooltip values (e.g. formatUSD / formatCompact). */
  valueFormatter?: (v: number) => string;
  /** Formats x-axis tick labels. */
  xFormatter?: (v: string | number) => string;
  className?: string;
}

/** Time-series area chart (optionally stacked). Put inside <ChartCard>. */
export function AreaChart({ data, xKey, series, height = 260, valueFormatter, xFormatter, stacked, className }: BaseChartProps & { stacked?: boolean }) {
  const config = buildConfig(series);
  return (
    <ChartContainer config={config} className={cn("w-full !aspect-auto", className)} style={{ height }}>
      <RAreaChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={`var(--color-${s.key})`} stopOpacity={0.35} />
              <stop offset="95%" stopColor={`var(--color-${s.key})`} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey={xKey} tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={xFormatter} />
        <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={valueFormatter} />
        <Tooltip
          isAnimationActive={false}
          content={<ChartTooltipContent indicator="line" formatter={valueFormatter ? (v) => <span className="tabular-nums">{valueFormatter(Number(v))}</span> : undefined} />}
        />
        {series.length > 1 && <Legend />}
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            stroke={`var(--color-${s.key})`}
            strokeWidth={2}
            fill={`url(#fill-${s.key})`}
            stackId={stacked ? "a" : undefined}
          />
        ))}
      </RAreaChart>
    </ChartContainer>
  );
}

/** Vertical (default) or horizontal bar chart, optionally stacked. */
export function BarChart({
  data,
  xKey,
  series,
  height = 260,
  valueFormatter,
  xFormatter,
  stacked,
  horizontal,
  className,
}: BaseChartProps & { stacked?: boolean; horizontal?: boolean }) {
  const config = buildConfig(series);
  return (
    <ChartContainer config={config} className={cn("w-full !aspect-auto", className)} style={{ height }}>
      <RBarChart data={data} layout={horizontal ? "vertical" : "horizontal"} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={horizontal} horizontal={!horizontal} strokeDasharray="3 3" />
        {horizontal ? (
          <>
            <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={valueFormatter} />
            <YAxis type="category" dataKey={xKey} tickLine={false} axisLine={false} width={110} tickFormatter={xFormatter} />
          </>
        ) : (
          <>
            <XAxis dataKey={xKey} tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} tickFormatter={xFormatter} />
            <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={valueFormatter} />
          </>
        )}
        <Tooltip
          isAnimationActive={false}
          cursor={{ fillOpacity: 0.08 }}
          content={<ChartTooltipContent formatter={valueFormatter ? (v) => <span className="tabular-nums">{valueFormatter(Number(v))}</span> : undefined} />}
        />
        {series.length > 1 && <Legend />}
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} fill={`var(--color-${s.key})`} radius={stacked ? 0 : 4} stackId={stacked ? "a" : undefined} />
        ))}
      </RBarChart>
    </ChartContainer>
  );
}

export interface DonutDatum {
  name: string;
  value: number;
  color?: string;
}

/** Donut (pie) chart with a centre label; data rows are `{ name, value }`. */
export function DonutChart({
  data,
  height = 260,
  valueFormatter,
  centerLabel,
  centerValue,
  className,
}: {
  data: DonutDatum[];
  height?: number;
  valueFormatter?: (v: number) => string;
  centerLabel?: string;
  centerValue?: string;
  className?: string;
}) {
  const config: ChartConfig = {};
  data.forEach((d, i) => {
    config[d.name] = { label: d.name, color: d.color ?? chartColor(i) };
  });
  return (
    <div className={cn("relative w-full", className)} style={{ height }}>
      <ChartContainer config={config} className="!aspect-auto h-full w-full">
        <RPieChart>
          <Tooltip isAnimationActive={false} content={<ChartTooltipContent hideLabel formatter={valueFormatter ? (v) => <span className="tabular-nums">{valueFormatter(Number(v))}</span> : undefined} />} />
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="85%" paddingAngle={2} stroke="none">
            {data.map((d, i) => (
              <Cell key={d.name} fill={d.color ?? chartColor(i)} />
            ))}
          </Pie>
          <Legend verticalAlign="bottom" />
        </RPieChart>
      </ChartContainer>
      {(centerLabel || centerValue) && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-6">
          {centerValue && <span className="text-xl font-semibold tabular-nums">{centerValue}</span>}
          {centerLabel && <span className="text-xs text-muted-foreground">{centerLabel}</span>}
        </div>
      )}
    </div>
  );
}
