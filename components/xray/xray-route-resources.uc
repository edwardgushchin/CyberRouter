#!/usr/bin/env ucode
'use strict';
import { readfile } from 'fs';
import { tokenize, entitydecode, OPEN, ATTR } from 'html';

let domain = ARGV[0];
if (!domain || !match(domain, /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/))
	exit(2);
let origin = 'https://' + domain;
let resources = [], seen = {}, tag = '', has_base = false;

// Only same-origin static resources: do not crawl arbitrary links or execute JS.
tokenize(readfile(ARGV[1]) || '', (type, name, value) => {
	if (type == OPEN) {
		tag = lc(name);
		if (tag == 'base') has_base = true;
	}
	if (type != ATTR || length(resources) >= 4)
		return;
	name = lc(name);
	if (!((tag == 'script' && name == 'src') || (tag == 'link' && name == 'href')))
		return;
	let url = split(entitydecode(value || ''), '#')[0];
	if (!length(url) || length(url) > 2048 || match(url, /[[:space:][:cntrl:]]/) || index(url, '\\') >= 0)
		return;
	if (tag == 'link' && !match(url, /\.(css|m?js)(\?|$)/i))
		return;
	if (substr(url, 0, 2) == '//') url = 'https:' + url;
	if (substr(url, 0, 8) == 'https://') {
		if (substr(url, 0, length(origin) + 1) != origin + '/') return;
	}
	else {
		if (match(url, /^[^\/]*:/)) return;
		url = origin + (substr(url, 0, 1) == '/' ? '' : '/') + url;
	}
	if (!seen[url]) {
		seen[url] = true;
		push(resources, url);
	}
});
// A custom base changes relative URL resolution; skip instead of probing a
// different resource. Full HTML navigation requires a browser, not this probe.
if (!has_base)
	for (let url in resources) print(url, '\n');
