# cross-seed fork with info hash collision handling

This is a fork of cross-seed: https://github.com/cross-seed/cross-seed/

Based on the cross-seed v7 pre-release (includes the Web UI).

> **Warning:** This fork changes the database schema and behavior. Before
> installing or upgrading, make a backup of `cross-seed.db`. If you ever want to
> return to the stock version, you will need that backup.

## Why this fork

This fork exists to handle info hash collisions. An info hash collision happens
when two different torrents share the same `info_hash`. In that case, cross-seed
detects a duplicate and refuses to inject, which blocks cross-seeding even when
the torrent comes from another tracker.

In such a situation, it is not viable to inject a second announce for the same
torrent (often rejected by private trackers). It is also risky to rely on a
second client to work around the issue in case of file corruption and private
trackers may detect that as an abuse.

This fork helps to be aware of conflicting torrents and make action.

## Features

- Detects collisions by identifying tracker differences between the candidate
  and the seeding torrent
- Defines rules to replace a conflicting torrent by setting tracker priorities

### Collisions view

![Collisions view](images/collisions.png)

By default, if there are no Conflict Rules, collisions are surfaced in the
Collisions view for manual handling. It is then possible to report the issue to
the trackers involved or remove the conflicting torrents from the bittorrent
client manually.

A `Collision Recheck` job regularly verifies whether a conflicting torrent has
been removed from the bittorrent client, then allowing the candidate to be
injected.

### Conflict Rules

![Conflict Rules view](images/conflict-rules.png)

By default, this feature is disabled.

Conflict Rules allow tracker priority to be defined to solve collisions
automatically. This is a way to promote seeding on prefered trackers for
whatever reason. When rules apply, conflicting torrent of a lower priority
tracker is removed from the bittorrent client without deleting the data and
elected candidates is injected as replacement.

> **Note:** The `All indexer trackers` rule only covers active indexers from the
> Trackers Settings page. If an indexer is temporarily down, it will be treated
> as a third-party tracker. When configuring rules, explicitly select all
> desired trackers to avoid unwanted torrent replacement.

## Docker image

Multiarch AMD64/ARM64 images are available at:

`ghcr.io/pilounk/cross-seed:collisions`

## Usage

After migrating from stock cross-seed version, you might want to clear old
decisions which stated the info hash already exists in the bittorrent client
while it could have been a collision:

`docker exec -it cross-seed cross-seed reset-stock-decisions`
