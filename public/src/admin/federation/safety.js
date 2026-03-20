'use strict';

import { post, del } from 'api';
import { error } from 'alerts';
import { render } from 'benchpress';

export function init() {
	setupBlocklists();
};

function setupBlocklists() {
	const blocklistsEl = document.getElementById('blocklists');
	if (blocklistsEl) {
		blocklistsEl.addEventListener('click', (e) => {
			const subselector = e.target.closest('[data-action]');
			if (subselector) {
				const action = subselector.getAttribute('data-action');
				switch (action) {
					case 'blocklists.add': {
						throwModal();
						break;
					}

					case 'blocklists.remove': {
						const url = subselector.closest('tr').getAttribute('data-url');
						del(`/admin/activitypub/blocklists/${encodeURIComponent(url)}`, {}).then(async (data) => {
							const html = await app.parseAndTranslate('admin/federation/safety', 'blocklists', { blocklists: data });
							const tbodyEl = document.querySelector('#blocklists tbody');
							if (tbodyEl) {
								$(tbodyEl).html(html);
							}
						}).catch(error);
					}
				}
			}
		});
	}
}

function throwModal() {
	render('admin/partials/activitypub/blocklists', {}).then(function (html) {
		const submit = function () {
			const formEl = modal.find('form').get(0);
			if (!formEl.reportValidity()) {
				return false;
			}

			const payload = Object.fromEntries(new FormData(formEl));
			post('/admin/activitypub/blocklists', payload).then(async (data) => {
				const html = await app.parseAndTranslate('admin/federation/safety', 'blocklists', { blocklists: data });
				const tbodyEl = document.querySelector('#blocklists tbody');
				if (tbodyEl) {
					$(tbodyEl).html(html);
				}
			}).catch(error);
		};
		const modal = bootbox.dialog({
			title: '[[admin/settings/activitypub:blocklists.add]]',
			message: html,
			buttons: {
				save: {
					label: '[[global:save]]',
					className: 'btn-primary',
					callback: submit,
				},
			},
		});

		modal.on('shown.bs.modal', function () {
			modal.find('input').focus();
		});
	});
}