/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * Medusa -- Manta Interactive Session Engine
 *
 * Agent Asset Publisher
 *
 * Interactive sessions are presently regular Map or Reduce tasks that
 * run a predefined agent.  This agent is parcelled up in a single-file
 * shell script archive as part of the build process, and stored as
 * a public Manta object.  This object is included in Medusa interactive
 * jobs as an asset.
 */

/*
 * Imported Modules.
 */
var mod_path = require('path');
var mod_fs = require('fs');

var mod_bunyan = require('bunyan');
var mod_moray = require('moray');
var mod_panic = require('panic');
var mod_restify = require('restify');
var mod_events = require('events');
var mod_util = require('util');

var mod_assert = require('assert-plus');
var mod_once = require('once');
var mod_manta = require('manta');


var mod_common = require('./common');

/*
 * Symbolic Constants
 */
var MD_ASSET_FILE = '../asset.sh';
var MD_ASSET_OBJECT = '/poseidon/public/medusa/agent.sh';

var COMMON_CONFIG = '/opt/smartdc/common/etc/config.json';

function
read_common_config()
{
	var str, config;

	str = mod_fs.readFileSync(COMMON_CONFIG);
	config = JSON.parse(str);

	return (config);
}

function
put_stream(log, client, key, instream, insize, callback)
{
	var dirname = mod_path.dirname(MD_ASSET_OBJECT);
	var putopts = {
		size: insize
	};
	client.mkdirp(dirname, function (err) {
		if (err) {
			log.error(err, 'could not create medusa directory in' +
			    ' manta');
			callback(err);
			return;
		}
		client.put(key, instream, putopts, function (err) {
			if (err) {
				log.error(err, 'could not put agent asset' +
				    ' into manta');
				callback(err);
				return;
			}

			callback();
		});
	});
}

function
get_file_stream(filepath, callback)
{
	var fstream, fsize;

	callback = mod_once(callback);

	var innercb = function (ok, err) {
		if (fstream) {
			fstream.removeAllListeners();
			fstream.pause();
		}
		if (ok === true)
			callback(null, fsize, fstream);
		else
			callback(err);
	};

	mod_fs.stat(filepath, function (err, stats) {
		if (err) {
			callback(err);
			return;
		}

		if (!stats.isFile()) {
			callback(new Error(filepath + ' is not a regular' +
			    ' file'));
			return;
		}

		fsize = stats.size;

		fstream = mod_fs.createReadStream(filepath);
		fstream.on('error', innercb.bind(null, false));
		fstream.on('open', innercb.bind(null, true));
	});
}

function
put_medusa_agent(options, callback)
{
	var client, log, config, filepath;

	mod_assert.object(options, 'options');
	mod_assert.object(options.log, 'options.log');
	mod_assert.func(callback, 'callback');

	log = options.log;
	callback = mod_once(callback);

	config = read_common_config();
	mod_assert.object(config.manta, 'manta config');

	var client = mod_manta.createClient(config.manta);

	filepath = mod_path.join(__dirname, MD_ASSET_FILE);
	get_file_stream(filepath, function (err, fsize, fstream) {
		if (err) {
			log.error(err, 'could not read agent asset file');
			callback(err);
			return;
		}
		put_stream(log, client, MD_ASSET_OBJECT, fstream, fsize,
		    callback);
	});
}


module.exports = {
	put_medusa_agent: put_medusa_agent
};

/* vim: set ts=8 sts=8 sw=8 noet: */
