'use strict';

const assert = require('assert');
const nconf = require('nconf');

const db = require('../mocks/databasemock');
const meta = require('../../src/meta');
const install = require('../../src/install');
const categories = require('../../src/categories');
const user = require('../../src/user');
const topics = require('../../src/topics');
const activitypub = require('../../src/activitypub');
const utils = require('../../src/utils');
const request = require('../../src/request');
const slugify = require('../../src/slugify');

const helpers = require('./helpers');

describe('Actor asserton', () => {
	before(async () => {
		meta.config.activitypubEnabled = 1;
		await install.giveWorldPrivileges();
	});

	describe('happy path', () => {
		let uid;
		let actorUri;

		before(async () => {
			uid = utils.generateUUID().slice(0, 8);
			actorUri = `https://example.org/user/${uid}`;
			activitypub._cache.set(`0;${actorUri}`, {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: actorUri,
				url: actorUri,

				type: 'Person',
				name: 'example',
				preferredUsername: 'example',
				inbox: `https://example.org/user/${uid}/inbox`,
				outbox: `https://example.org/user/${uid}/outbox`,

				publicKey: {
					id: `${actorUri}#key`,
					owner: actorUri,
					publicKeyPem: 'somekey',
				},
			});
		});

		it('should return true if successfully asserted', async () => {
			const result = await activitypub.actors.assert([actorUri]);
			assert(result && result.length);
		});

		it('should contain a representation of that remote user in the database', async () => {
			const exists = await db.exists(`userRemote:${actorUri}`);
			assert(exists);

			const userData = await user.getUserData(actorUri);
			assert(userData);
			assert.strictEqual(userData.uid, actorUri);
		});

		it('should save the actor\'s publicly accessible URL in the hash as well', async () => {
			const url = await user.getUserField(actorUri, 'url');
			assert.strictEqual(url, actorUri);
		});

		it('should assert group actors by calling actors.assertGroup', async () => {
			const { id, actor } = helpers.mocks.group();
			const assertion = await activitypub.actors.assert([id]);

			assert(assertion);
			assert.strictEqual(assertion.length, 1);
			assert.strictEqual(assertion[0].cid, actor.id);
		});

		it('should migrate a user to a category if on re-assertion it identifies as an as:Group', async () => {
			// This is to handle previous behaviour that saved all as:Group actors as NodeBB users.
			const { id } = helpers.mocks.person();
			await activitypub.actors.assert([id]);

			// Two shares
			for (let x = 0; x < 2; x++) {
				const { id: pid } = helpers.mocks.note();
				// eslint-disable-next-line no-await-in-loop
				const { tid } = await activitypub.notes.assert(0, pid, { skipChecks: 1 });
				// eslint-disable-next-line no-await-in-loop
				await db.sortedSetAdd(`uid:${id}:shares`, Date.now(), tid);
			}

			const { actor } = helpers.mocks.group({ id });
			const assertion = await activitypub.actors.assert([id], { update: true });

			const { topic_count, post_count } = await categories.getCategoryData(id);
			assert.strictEqual(topic_count, 2);
			assert.strictEqual(post_count, 2);

			const exists = await user.exists(id);
			assert.strictEqual(exists, false);
		});
	});

	describe('edge cases: loopback handles and uris', () => {
		let uid;
		const userslug = utils.generateUUID().slice(0, 8);
		before(async () => {
			uid = await user.create({ username: userslug });
		});

		it('should return true but not actually assert the handle into the database', async () => {
			const handle = `${userslug}@${nconf.get('url_parsed').host}`;
			const result = await activitypub.actors.assert([handle]);
			assert(result);

			const handleExists = await db.isObjectField('handle:uid', handle);
			assert.strictEqual(handleExists, false);

			const userRemoteHashExists = await db.exists(`userRemote:${nconf.get('url')}/uid/${uid}`);
			assert.strictEqual(userRemoteHashExists, false);
		});

		it('should return true but not actually assert the uri into the database', async () => {
			const uri = `${nconf.get('url')}/uid/${uid}`;
			const result = await activitypub.actors.assert([uri]);
			assert(result);

			const userRemoteHashExists = await db.exists(`userRemote:${uri}`);
			assert.strictEqual(userRemoteHashExists, false);
		});
	});

	describe('deletion', () => {
		it('should delete a remote category when Categories.purge is called', async () => {
			const { id } = helpers.mocks.group();
			await activitypub.actors.assertGroup([id]);

			let exists = await categories.exists(id);
			assert(exists);

			await categories.purge(id, 0);

			exists = await categories.exists(id);
			assert(!exists);

			exists = await db.exists(`categoryRemote:${id}`);
			assert(!exists);
		});

		it('should also delete AP-specific keys that were added by assertGroup', async () => {
			const { id } = helpers.mocks.group();
			const assertion = await activitypub.actors.assertGroup([id]);
			const [{ slug }] = assertion;

			await categories.purge(id, 0);

			const isMember = await db.isObjectField('handle:cid', slug);
			assert(!isMember);
		});
	});
});

describe('Group assertion', () => {
	let actorUri;

	before(async () => {
		const { id, actor } = helpers.mocks.group();
		actorUri = id;
	});

	it('should assert a uri identifying as "Group" into a remote category', async () => {
		const assertion = await activitypub.actors.assertGroup([actorUri]);

		assert(assertion, Array.isArray(assertion));
		assert.strictEqual(assertion.length, 1);

		const category = assertion.pop();
		assert.strictEqual(category.cid, actorUri);
	});

	it('should be considered existing when checked', async () => {
		const exists = await categories.exists(actorUri);

		assert(exists);
	});

	it('should return category data when getter methods are called', async () => {
		const category = await categories.getCategoryData(actorUri);
		assert(category);
		assert.strictEqual(category.cid, actorUri);
	});

	it('should not assert non-group users when called', async () => {
		const { id } = helpers.mocks.person();
		const assertion = await activitypub.actors.assertGroup([id]);

		assert(Array.isArray(assertion) && !assertion.length);
	});
});

describe('Controllers', () => {
	describe('User Actor endpoint', () => {
		let uid;
		let slug;

		beforeEach(async () => {
			slug = slugify(utils.generateUUID().slice(0, 8));
			uid = await user.create({ username: slug });
		});

		it('should return a valid ActivityPub Actor JSON-LD payload', async () => {
			const { response, body } = await request.get(`${nconf.get('url')}/uid/${uid}`, {
				headers: {
					Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
				},
			});

			assert(response);
			assert.strictEqual(response.statusCode, 200);
			assert(body.hasOwnProperty('@context'));
			assert(body['@context'].includes('https://www.w3.org/ns/activitystreams'));

			['id', 'url', 'followers', 'following', 'inbox', 'outbox'].forEach((prop) => {
				assert(body.hasOwnProperty(prop));
				assert(body[prop]);
			});

			assert.strictEqual(body.id, `${nconf.get('url')}/uid/${uid}`);
			assert.strictEqual(body.type, 'Person');
		});

		it('should contain a `publicKey` property with a public key', async () => {
			const { response, body } = await request.get(`${nconf.get('url')}/uid/${uid}`, {
				headers: {
					Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
				},
			});

			assert(body.hasOwnProperty('publicKey'));
			assert(['id', 'owner', 'publicKeyPem'].every(prop => body.publicKey.hasOwnProperty(prop)));
		});
	});

	describe('Category Actor endpoint', () => {
		let cid;
		let slug;
		let description;

		beforeEach(async () => {
			slug = slugify(utils.generateUUID().slice(0, 8));
			description = utils.generateUUID();
			({ cid } = await categories.create({
				name: slug,
				description,
			}));
		});

		it('should return a valid ActivityPub Actor JSON-LD payload', async () => {
			const { response, body } = await request.get(`${nconf.get('url')}/category/${cid}`, {
				headers: {
					Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
				},
			});

			assert(response);
			assert.strictEqual(response.statusCode, 200);
			assert(body.hasOwnProperty('@context'));
			assert(body['@context'].includes('https://www.w3.org/ns/activitystreams'));

			['id', 'url', /* 'followers', 'following', */ 'inbox', 'outbox'].forEach((prop) => {
				assert(body.hasOwnProperty(prop));
				assert(body[prop]);
			});

			assert.strictEqual(body.id, `${nconf.get('url')}/category/${cid}`);
			assert.strictEqual(body.type, 'Group');
			assert(body.summary.startsWith(description));
			assert.deepStrictEqual(body.icon, {
				type: 'Image',
				mediaType: 'image/png',
				url: `${nconf.get('url')}/assets/uploads/category/category-${cid}-icon.png`,
			});
		});

		it('should contain a `publicKey` property with a public key', async () => {
			const { body } = await request.get(`${nconf.get('url')}/category/${cid}`, {
				headers: {
					Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
				},
			});

			assert(body.hasOwnProperty('publicKey'));
			assert(['id', 'owner', 'publicKeyPem'].every(prop => body.publicKey.hasOwnProperty(prop)));
		});

		it('should serve the the backgroundImage in `icon` if set', async () => {
			const payload = {};
			payload[cid] = {
				backgroundImage: `/assets/uploads/files/test.png`,
			};
			await categories.update(payload);

			const { body } = await request.get(`${nconf.get('url')}/category/${cid}`, {
				headers: {
					Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
				},
			});

			assert.deepStrictEqual(body.icon, {
				type: 'Image',
				mediaType: 'image/png',
				url: `${nconf.get('url')}/assets/uploads/files/test.png`,
			});
		});
	});

	describe('Instance Actor endpoint', () => {
		let response;
		let body;

		before(async () => {
			({ response, body } = await request.get(`${nconf.get('url')}/actor`, {
				headers: {
					Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
				},
			}));
		});

		it('should respond properly', async () => {
			assert(response);
			assert.strictEqual(response.statusCode, 200);
		});

		it('should return a valid ActivityPub Actor JSON-LD payload', async () => {
			assert(body.hasOwnProperty('@context'));
			assert(body['@context'].includes('https://www.w3.org/ns/activitystreams'));

			['id', 'url', 'inbox', 'outbox', 'name', 'preferredUsername'].forEach((prop) => {
				assert(body.hasOwnProperty(prop));
				assert(body[prop]);
			});

			assert.strictEqual(body.id, body.url);
			assert.strictEqual(body.type, 'Application');
			assert.strictEqual(body.name, meta.config.site_title || 'NodeBB');
			assert.strictEqual(body.preferredUsername, nconf.get('url_parsed').hostname);
		});

		it('should contain a `publicKey` property with a public key', async () => {
			assert(body.hasOwnProperty('publicKey'));
			assert(['id', 'owner', 'publicKeyPem'].every(prop => body.publicKey.hasOwnProperty(prop)));
		});

		it('should also have a valid WebFinger response tied to `preferredUsername`', async () => {
			const { response, body: body2 } = await request.get(`${nconf.get('url')}/.well-known/webfinger?resource=acct%3a${body.preferredUsername}@${nconf.get('url_parsed').host}`);

			assert.strictEqual(response.statusCode, 200);
			assert(body2 && body2.aliases && body2.links);
			assert(body2.aliases.includes(nconf.get('url')));
			assert(body2.links.some(item => item.rel === 'self' && item.type === 'application/activity+json' && item.href === `${nconf.get('url')}/actor`));
		});
	});

	describe('Topic Collection endpoint', () => {
		let cid;
		let uid;

		before(async () => {
			({ cid } = await categories.create({ name: utils.generateUUID().slice(0, 8) }));
			const slug = slugify(utils.generateUUID().slice(0, 8));
			uid = await user.create({ username: slug });
		});

		describe('Live', () => {
			let topicData;
			let response;
			let body;

			before(async () => {
				({ topicData } = await topics.post({
					uid,
					cid,
					title: 'Lorem "Lipsum" Ipsum',
					content: 'Lorem ipsum dolor sit amet',
				}));

				({ response, body } = await request.get(`${nconf.get('url')}/topic/${topicData.slug}`, {
					headers: {
						Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
					},
				}));
			});

			it('should respond properly', async () => {
				assert(response);
				assert.strictEqual(response.statusCode, 200);
			});

			it('should return an OrderedCollection with one item', () => {
				assert.strictEqual(body.type, 'OrderedCollection');
				assert.strictEqual(body.totalItems, 1);
				assert(Array.isArray(body.orderedItems));
				assert.strictEqual(body.orderedItems[0], `${nconf.get('url')}/post/${topicData.mainPid}`);
			});
		});

		describe('Scheduled', () => {
			let topicData;
			let response;
			let body;

			before(async () => {
				({ topicData } = await topics.post({
					uid,
					cid,
					title: 'Lorem "Lipsum" Ipsum',
					content: 'Lorem ipsum dolor sit amet',
					timestamp: Date.now() + (1000 * 60 * 60), // 1 hour in the future
				}));

				({ response, body } = await request.get(`${nconf.get('url')}/topic/${topicData.slug}`, {
					headers: {
						Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
					},
				}));
			});

			it('should respond with a 404 Not Found', async () => {
				assert(response);
				assert.strictEqual(response.statusCode, 404);
			});
		});
	});

	describe('Post Object endpoint', () => {
		let cid;
		let uid;

		before(async () => {
			({ cid } = await categories.create({ name: utils.generateUUID().slice(0, 8) }));
			const slug = slugify(utils.generateUUID().slice(0, 8));
			uid = await user.create({ username: slug });
		});

		describe('Live', () => {
			let postData;
			let response;
			let body;

			before(async () => {
				({ postData } = await topics.post({
					uid,
					cid,
					title: 'Lorem "Lipsum" Ipsum',
					content: 'Lorem ipsum dolor sit amet',
				}));

				({ response, body } = await request.get(`${nconf.get('url')}/post/${postData.pid}`, {
					headers: {
						Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
					},
				}));
			});

			it('should respond properly', async () => {
				assert(response);
				assert.strictEqual(response.statusCode, 200);
			});

			it('should return a Note type object', () => {
				assert.strictEqual(body.type, 'Note');
			});
		});

		describe('Scheduled', () => {
			let topicData;
			let postData;
			let response;
			let body;

			before(async () => {
				({ topicData, postData } = await topics.post({
					uid,
					cid,
					title: 'Lorem "Lipsum" Ipsum',
					content: 'Lorem ipsum dolor sit amet',
					timestamp: Date.now() + (1000 * 60 * 60), // 1 hour in the future
				}));

				({ response, body } = await request.get(`${nconf.get('url')}/post/${postData.pid}`, {
					headers: {
						Accept: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
					},
				}));
			});

			it('should respond with a 404 Not Found', async () => {
				assert(response);
				assert.strictEqual(response.statusCode, 404);
			});
		});
	});
});
