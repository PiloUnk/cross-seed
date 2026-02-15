# cross-seed fork with info hash collision handling

This is a fork of cross-seed: https://github.com/cross-seed/cross-seed/

Based on the cross-seed v7 pre-release (includes the Web UI).

<div style="border: 2px solid #d32f2f; padding: 12px; border-radius: 6px;">
	<strong>Note:</strong> This fork changes the database schema and behavior. Before installing or
	upgrading, make a backup of <code>cross-seed.db</code>. If you ever want to return
	to the stock version, you will need that backup.
</div>

## Why this fork

This fork exists to handle info hash collisions. An info hash collision happens
when two different torrents share the same `info_hash`. In that case, cross-seed
detects a duplicate and refuses to inject, which blocks cross-seeding even when
the torrent comes from another tracker.

In such a situation, it is not viable to inject a second announce for the same
torrent (often rejected by private trackers). It is also risky to rely on a
second client to work around the issue in case of file corruption. This fork
adds conflict rules to handle these collisions properly.

## Features

- Detects collisions by identifying tracker differences between the candidate
  and the seeding torrent
- Defines rules to replace a conflicting torrent by setting tracker priorities

### Collisions view

![Collisions view](images/collisions.png)

By default, if there are no Conflicting Rules, collisions are surfaced in the
Collisions view for manual handling. It is possible to report the issue to the
trackers involved or remove the conflicting torrents from the BitTorrent client
manually.

The `Collision Recheck` job regularly verifies whether a conflicting torrent has
been removed from the BitTorrent client, allowing the conflicting candidate to
be injected.

### Conflicting Rules

![Conflicting Rules view](images/conflicting-rules.png)

By default, this feature is disabled.

Conflicting Rules allow tracker priority to be defined to solve collisions
automatically. This is a way to promote seeding on prefered trackers for
whatever reason. When rules apply, conflicting torrent of a lower priority
tracker is removed from the bittorrent client without deleting the data and
elected candidates is injected as replacement.

> **Note:** The `All indexer trackers` rule only covers active indexers from the
> Trackers Settings page. If an indexer is temporarily down, it will be treated
> as a third-party tracker. When configuring rules, explicitly select all
> desired trackers to avoid unwanted torrent replacement.

## Docker image

A multiarch AMD64/ARM64 image is available at:

`ghcr.io/pilounk/cross-seed:collisions`

## Documentation

For configuration, usage, and the rest of the setup, refer to the upstream
cross-seed documentation.
