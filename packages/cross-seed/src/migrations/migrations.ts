import initialSchema from "./00-initialSchema.js";
import jobs from "./01-jobs.js";
import timestamps from "./02-timestamps.js";
import rateLimits from "./03-rateLimits.js";
import auth from "./04-auth.js";
import caps from "./05-caps.js";
import uniqueDecisions from "./06-uniqueDecisions.js";
import limits from "./07-limits.js";
import rss from "./08-rss.js";
import clientAndDataSearchees from "./09-clientAndDataSearchees.js";
import indexerNameAudioBookCaps from "./10-indexerNameAudioBookCaps.js";
import trackers from "./11-trackers.js";
import userAuth from "./12-user-auth.js";
import settings from "./13-settings.js";
import indexerEnabledFlag from "./14-indexer-enabled-flag.js";
import removeUrlUniqueConstraint from "./15-remove-url-unique-constraint.js";
import pruneInactiveIndexers from "./16-prune-inactive-indexers.js";
import candidates from "./17-candidates.js";
import candidatesTimestamps from "./18-candidates-timestamps.js";
import collisions from "./19-collisions.js";
import indexerPrivacy from "./20-indexer-privacy.js";
import dropIndexerPrivacy from "./21-drop-indexer-privacy.js";
import clientSearcheePrivate from "./22-client-searchee-private.js";

export const migrations = {
	getMigrations: () =>
		Promise.resolve([
			initialSchema,
			jobs,
			timestamps,
			rateLimits,
			auth,
			caps,
			uniqueDecisions,
			limits,
			rss,
			clientAndDataSearchees,
			indexerNameAudioBookCaps,
			trackers,
			userAuth,
			settings,
			indexerEnabledFlag,
			removeUrlUniqueConstraint,
			pruneInactiveIndexers,
			candidates,
			candidatesTimestamps,
			collisions,
			indexerPrivacy,
			dropIndexerPrivacy,
			clientSearcheePrivate,
		]),
	getMigrationName: (migration) => migration.name,
	getMigration: (migration) => migration,
};
