'use strict';

const db = require('../database');
const request = require('../request');

const Blocklists = module.exports;

Blocklists.list = async () => {
	const blocklists = await db.getSortedSetMembers('blocklists');
	const counts = await db.sortedSetsCard(blocklists.map(blocklist => `blocklist:${blocklist}`));

	return blocklists.map((url, idx) => {
		return { url, count: counts[idx] };
	});
};

Blocklists.add = async (url) => {
	const now = Date.now();

	await db.sortedSetAdd('blocklists', now, url);
};

Blocklists.remove = async (url) => {
	await db.sortedSetRemove('blocklists', url);
};

Blocklists.refresh = async (url) => {
	const { body: csv } = await request.get(url);
	const lines = csv.split('\r\n');
	let headers = lines.shift();
	headers = headers.split(',');

	const data = lines.map((line) => {
		return line.split(',').reduce((obj, value, index) => {
			obj[headers[index]] = value;
			return obj;
		}, {});
	});

	await db.sortedSetAdd(
		`blocklist:${url}`,
		data.map(entry => entry['#severity'] === 'silence' ? 2 : 1),
		data.map(entry => entry['#domain'])
	);
};

Blocklists.check = async (domain) => {
	const blocklists = await Blocklists.list();
	let present = await db.isMemberOfSortedSets(blocklists.map(({ url }) => `blocklist:${url}`), domain);
	present = present.reduce((memo, present) => memo || present);

	return !present;
};