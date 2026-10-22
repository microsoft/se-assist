"""Email -> customer intelligence datastore (personal enrichment via WorkIQ/Graph).

Mirrors the tools/teams package: ingests mailbox messages pulled through the WorkIQ
MCP, links them to the 16 customer TPIDs (reusing the Teams alias map), redacts
secrets, and builds per-account email profiles for the desktop app.
"""
