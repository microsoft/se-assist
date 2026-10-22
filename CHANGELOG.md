# Changelog

## 2.2.1 - 2026-10-22

### Added

- **Account-team Teams drafts:** Message in Teams prefills a greeting using the contact first name and account for SSP, ATS and AE.
- **Milestone Teams messages:** Message owner copies a formatted greeting with the milestone name as a clickable MSX link and opens the owner chat. Paste with Ctrl+V, then review and send manually. Original compact button labels are retained.

## 2.2.0 - 2026-10-21

### Added

- **Deep Research:** search locally stored customer email by account and keyword, save research subjects, and load email results 20 at a time with **See more**.
- **Work Outputs:** saved situation briefs, action checklists, reply drafts and optional technical recommendations. Retry, refresh, refine or stop individual areas without discarding successful results. Create local Tasks, workloads and reviewable Outlook reply-all drafts; nothing is sent automatically.
- **Research gaps:** classify open questions and research eligible gaps. Answers require verifiable supporting quotes; new evidence marks affected outputs as needing refresh.
- **Stakeholder Influence Map:** account-specific signals grounded in local email, meetings and transcripts, with optional Copilot analysis and private corrections. Scores are inferred signals, not facts about people.
- **Foundry Deep-Dives:** rolling-90-day token usage, offering/model/region trends, engagement history and customer/subscription views, with separate query and source-refresh timestamps.
- **Native Anthropic consumption:** completed-month USD spend and trends, separate from ordinary Azure ACR. Includes account drill-down—not token estimates or a per-Claude-model breakdown.
- **Updated app identity and documentation:** consistent app/tray/installer icons and three architecture views.

### Changed

- **Active-account roster:** saved User Home TPIDs are the sole active roster, with a 500-TPID limit. Removing an account archives it without deleting its history; re-adding restores access. Discovery and sign-in do not silently activate accounts.
