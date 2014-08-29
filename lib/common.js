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
 * Common/Utility Functions
 */

var mod_path = require('path');
var mod_fs = require('fs');
var mod_assert = require('assert-plus');

function
restifyPanic(req, res, route, err)
{
	req.log.fatal({
		req: req,
		res: res,
		err: err
	}, 'FATAL ERROR handling request');

	process.abort();
}

function
readConfig(log, config_path)
{
	var contents, json;

	mod_assert.object(log);
	mod_assert.string(config_path);

	try {
		contents = mod_fs.readFileSync(config_path);
		json = JSON.parse(contents);
	} catch (ex) {
		log.fatal(ex, 'failed to read configuration');
		throw (ex);
	}

	return (json);
}

function
clone(inobj)
{
	var outobj, keys;

	if (!inobj)
		return (inobj);

	outobj = {};
	keys = Object.keys(inobj);

	for (var i = 0; i < keys.length; i++) {
		var key = keys[i];
		if (typeof (inobj[key]) === 'object')
			outobj[key] = clone(inobj[key]);
		else
			outobj[key] = inobj[key];
	}
	return (outobj);
}

module.exports = {
	readConfig: readConfig,
	restifyPanic: restifyPanic,
	clone: clone
};

/* vim: set ts=8 sts=8 sw=8 noet: */
