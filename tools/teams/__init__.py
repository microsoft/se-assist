"""SE Assist — Teams chat datastore tooling.

Collects Microsoft Teams chats (sourced from the working Teams MCP tools) into the
existing seassist.db SQLite store, maps them to customer accounts by tpid, and builds
per-customer profiles for meeting preparation.

Uses only the Python standard library (sqlite3) so it runs anywhere without the
better-sqlite3 native binding the Electron app depends on.
"""
