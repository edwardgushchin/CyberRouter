#!/usr/bin/env ucode
'use strict';

import { readfile, writefile } from 'fs';

function fail(message) {
	warn(`xray-profile-tool: ${message}\n`);
	exit(1);
}

function load_json(path) {
	let raw = readfile(path);
	if (raw == null)
		fail(`cannot read ${path}`);

	let document = json(raw);
	if (type(document) != 'object')
		fail(`invalid JSON object in ${path}`);

	return document;
}

function save_json(path, document) {
	if (!writefile(path, sprintf('%J\n', document)))
		fail(`cannot write ${path}`);
}

function proxy_domain_rule(document) {
	let best = null;
	let best_length = -1;

	if (type(document.routing) != 'object' || type(document.routing.rules) != 'array')
		fail('routing.rules is missing');

	for (let rule in document.routing.rules) {
		if (rule.outboundTag != 'proxy' || type(rule.domain) != 'array')
			continue;

		if (length(rule.domain) > best_length) {
			best = rule;
			best_length = length(rule.domain);
		}
	}

	if (best == null)
		fail('proxy domain rule is missing');

	return best;
}

function merge_common_domains(source_path, target_path, output_path) {
	let source = load_json(source_path);
	let target = load_json(target_path);
	let source_rule = proxy_domain_rule(source);
	let target_rule = proxy_domain_rule(target);
	let present = {};

	for (let domain in target_rule.domain)
		present[domain] = true;

	for (let domain in source_rule.domain) {
		if (!present[domain]) {
			push(target_rule.domain, domain);
			present[domain] = true;
		}
	}

	save_json(output_path, target);
}

function add_proxy_domains(input_path, output_path, domains) {
	let document = load_json(input_path);
	let rule = proxy_domain_rule(document);
	let present = {};

	for (let domain in rule.domain)
		present[domain] = true;

	for (let domain in domains) {
		if (!present[domain]) {
			push(rule.domain, domain);
			present[domain] = true;
		}
	}

	save_json(output_path, document);
}

function remove_proxy_domains(input_path, output_path, domains) {
	let document = load_json(input_path);
	let rule = proxy_domain_rule(document);
	let removed = {};
	let retained = [];

	for (let domain in domains)
		removed[domain] = true;

	for (let domain in rule.domain) {
		if (!removed[domain])
			push(retained, domain);
	}

	rule.domain = retained;
	save_json(output_path, document);
}

function make_probe(profile_path, output_path, port_value) {
	let profile = load_json(profile_path);
	let proxy = null;
	let port = +port_value;

	if (port < 1024 || port > 65535)
		fail(`invalid probe port ${port_value}`);

	if (type(profile.outbounds) != 'array')
		fail('outbounds is missing');

	for (let outbound in profile.outbounds) {
		if (outbound.tag == 'proxy') {
			proxy = outbound;
			break;
		}
	}

	if (proxy == null)
		fail('proxy outbound is missing');

	let probe = {
		log: {
			loglevel: 'warning'
		},
		inbounds: [
			{
				listen: '127.0.0.1',
				port: port,
				protocol: 'socks',
				settings: {
					auth: 'noauth',
					udp: false
				},
				tag: 'probe-in'
			}
		],
		outbounds: [ proxy ],
		routing: {
			domainStrategy: 'AsIs',
			rules: [
				{
					type: 'field',
					inboundTag: [ 'probe-in' ],
					outboundTag: 'proxy'
				}
			]
		}
	};

	save_json(output_path, probe);
}

let command = shift(ARGV);

switch (command) {
case 'merge-common-domains':
	if (length(ARGV) != 3)
		fail('usage: merge-common-domains SOURCE TARGET OUTPUT');
	merge_common_domains(ARGV[0], ARGV[1], ARGV[2]);
	break;

case 'make-probe':
	if (length(ARGV) != 3)
		fail('usage: make-probe PROFILE OUTPUT PORT');
	make_probe(ARGV[0], ARGV[1], ARGV[2]);
	break;

case 'add-proxy-domains':
	if (length(ARGV) < 3)
		fail('usage: add-proxy-domains INPUT OUTPUT DOMAIN...');
	let domains = [];
	for (let index = 2; index < length(ARGV); index++)
		push(domains, ARGV[index]);
	add_proxy_domains(ARGV[0], ARGV[1], domains);
	break;

case 'remove-proxy-domains':
	if (length(ARGV) < 3)
		fail('usage: remove-proxy-domains INPUT OUTPUT DOMAIN...');
	let removed_domains = [];
	for (let index = 2; index < length(ARGV); index++)
		push(removed_domains, ARGV[index]);
	remove_proxy_domains(ARGV[0], ARGV[1], removed_domains);
	break;

default:
	fail('unknown command');
}
