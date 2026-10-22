"""Shared helpers for the tools/* ingestion pipelines.

The email, meetings, and teams datastores each carried their own byte-for-byte
copies of the SQLite connector and the alias-confidence heuristic. Those live here
now so a fix lands in one place instead of drifting across three pipelines. Each
domain package keeps only what is genuinely domain-specific (its SCHEMA_SQL and
per-source linking logic) and re-exports these shared pieces.
"""
