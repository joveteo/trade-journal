# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- IBKR Flex XML file upload (`ibkr-flex-xml`) sharing the live-sync parser: option contract identity, expiration/assignment settlement from Cost Basis and Realized P/L, spread grouping metadata, and broker-ID dedup across overlapping files
- Default market data source: with one connected source it is preselected automatically; with several, choose a default in Settings → Market data for trade replay, report estimates and unrealised P&L
- Tastytrade market data (OAuth): stock, index and equity-option candles with replay; two-leg verticals combine each contract's candles into a net-premium series, and missing option history falls back to the underlying with MAE/MFE withheld
- Unrealised P&L dashboard card: on request, marks the filtered open positions at the latest candle close from a configured market data provider, against average entry and gross of fees; positions that cannot be priced reliably are listed rather than counted as zero
- Canonical OCC and IBKR option symbols, with equity/index options defaulting to a 100 multiplier unless Settings overrides the exact symbol
- Customizable dashboard: drag cards to rearrange, hide and restore them, save named layouts; responsive layout with a mobile navigation drawer
- Privacy mode that masks monetary values across the app while keeping counts, ratios and chart shapes
- Markdown notes with formatting toolbar, reusable templates, exact trade links, and image/PDF attachments on trades, days and notebook notes
- Advanced report filters, comparison groups, a two-way cross-analysis matrix, and additional breakdowns (asset class, month, entry/exit hour, position size, planned/realized R)
- Playbook rule checklists per trade with adherence rates and followed-vs-broken performance
- Routines with weekday schedules and completion history; a missed-opportunity log kept out of trading metrics
- PDF and PNG review exports; JSON export now includes folders, templates, rule assessments, routines and defaults
- Configurable breakeven tolerance, default fees, and default stop/target distances per account and symbol
- Importers: MetaTrader 5 deal reports and TradingView strategy exports
- Importers: XTB xStation `.xlsx` account workbooks, with closed positions, open holdings and later closes of those holdings (contributed by @zahei, [#42](https://github.com/LuxAlgo/trade-journal/issues/42))
- Realized R accounts for contract multipliers and scaled entries
- Optional historical market data connections (London Strategic Edge, Alpaca, OANDA, Binance, Coinbase, or your own candle CSV) with estimated MAE/MFE and candle replay on closed trades
- Prop firm tracker: evaluation and reset costs, refunds, payout requests, receipts, cash ROI, renewals, attachments, CSV import and export
- Calendar insights, rolling performance trends, and a trade explorer scatter in Reports
- Light mode, a collapsible sidebar, and friendlier AI setup and error notices
- OpenAI-compatible AI provider for local or third-party models (Ollama, LM Studio, OpenRouter and others), and documented `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` gateway support (proposed by @fiandev in [#19](https://github.com/LuxAlgo/trade-journal/pull/19))
- Existing fork setups that pointed the OpenAI provider at a local server (LM Studio) move to the OpenAI-compatible provider automatically, keeping the server URL and model

### Changed

- Data loads render as React transitions, so a tab change paints progressively instead of freezing while every card and chart mounts at once
- The development server runs on Turbopack, roughly halving first-visit compile times when switching tabs in `pnpm dev`
- Removed the gradient accent bar and gradient Edge Score number; the active nav item and the score now use the solid brand blue
- Trade pages chart recorded fills only and never contact a data provider on open; market candles load only from a data source you choose
- Gross profit and gross loss now include every closed trade, so trades labeled breakeven by a tolerance still count; the Edge Score version is bumped to 2
- Reports and dashboard aggregation reuse daily totals and equity for large histories; charts load only the components they use
- Executions are validated and written together with their recomputed trades in one transaction
- Node 22 or newer is required (already required by the AI dependencies)

### Fixed

- Replay no longer overlays option fill prices on underlying index or stock candles when Tastytrade falls back from missing contract history
- Replay fill labels show prices to at most 2 decimal places instead of raw floating-point values such as 29.810000000000002
- Running P&L on a trade merges exits at the same time into one point, so spread legs that expire together no longer draw a misleading slope; the card is hidden when only one exit time remains
- IBKR accounts whose Flex query lacks Open Positions or Cash Report show broker equity and positions as not reported, with a sync warning naming the missing section, instead of $0.00 and 0 open positions
- IBKR Flex live sync reads statement times in US Eastern time instead of the import timezone (UTC by default), which had placed fills and expirations hours early and cut market replay off before the close. Re-syncing corrects fills stored under the old default: a fill IBKR sends again takes the statement's time
- Vertical replay uses each option's mark (mid bid/ask) so sold-minus-bought matches the net premium; last-trade candles were plotting the short call alone when the hedge had no print
- IBKR option fills keep contract identity and a 100× multiplier so premium P&L is in dollars, and zero-price BookTrades use Cost Basis and Realized P/L instead of opening reverse $0 legs
- Grammarly and similar extensions no longer trip a `<body>` hydration mismatch on first load
- IBKR Flex Query XML statements can be uploaded on Import → File upload, and their times are read in the statement timezone chosen for the file. Previously an XML upload was not recognized and could not be imported, so the Default import timezone never applied ([#16](https://github.com/LuxAlgo/trade-journal/issues/16)).
- Password protection now verifies the session signature on every API route. Previously, when `JOURNAL_PASSWORD` was set, any request carrying a cookie of the right name was accepted, so a forged cookie could read the journal.
- Ask-your-journal answers and trade critiques render Markdown (bold, lists, headings) instead of raw asterisks
- Model LaTeX such as `$\\text{net } 2787.32$` is shown as readable text instead of raw commands

## [0.1.0] - 2026-09-03

Initial public release.

### Added

- Round-trip engine: flat-to-flat position cycles from raw fills, FIFO/LIFO/weighted-average matching, partial fills, position flips, futures multipliers, rebuild-stable annotation keys (`@luxalgo/journal-core`)
- Analytics: P&L, win and day-win rates, profit factor, expectancy, R multiples, streaks, drawdown and recovery, profit concentration, calendar and bucket aggregations, the open Edge Score
- Statement importers with auto-detection for 12 formats, one-click TradeZella/Tradervue migration with exact P&L reconciliation, and a column mapper for anything else (`@luxalgo/journal-importers`)
- Web app: dashboard, P&L calendar, daily journal with voice dictation, trades table, trade pages with charting, notebook, playbooks, reports
- Broker sync via `@luxalgo/broker-sdk` with credentials encrypted at rest
- Optional AI reflection (bring your own Anthropic API key): session recaps, trade critiques, ask-your-journal
- Docker deployment, optional password auth, full JSON/CSV export
