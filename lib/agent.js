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
 * In-Job Agent
 *
 * Interactive sessions are a regular Map or Reduce task that runs
 * this agent as the workload.  During the build of Medusa, this
 * agent is parcelled up in a self-expanding, self-executing
 * shell archive.  That archive is put into a public Manta object
 * at a well-known location so that jobs can include and run the
 * current version.
 *
 * The agent looks for a configuration asset which will contain a
 * pre-signed URL.  We use this URL to make a connection back to
 * the Internet-facing Load Balancer, which will connect us to
 * the user's waiting mlogin.
 */

var mod_fs = require('fs');
var mod_https = require('https');
var mod_path = require('path');
var mod_url = require('url');
var mod_util = require('util');

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_manta = require('manta');
var mod_pty = require('pty.js');
var mod_watershed = require('watershed');


/*
 * Globals:
 */
var LOG = mod_bunyan.createLogger({
	name: 'medusa-agent',
	level: 'debug',
	streams: [
		/*
		 * We write to both stdout _and_ stderr for now,
		 * because marlin saves one or the other depending on our
		 * exit code.
		 */
		{ stream: process.stderr },
		{ stream: process.stdout }
	],
	serializers: mod_bunyan.stdSerializers
});
LOG.info('logger created');
var CLIENT = mod_manta.createClient({
	log: LOG,
	url: process.env.MANTA_URL
});
var WATERSHED = new mod_watershed.Watershed();


/*
 * Functions:
 */
function
locate_config_key()
{
	var asset_path, assets;

	/*
	 * mlogin has PUT a JSON-formatted configuration file into
	 * /${MANTA_USER}/stor/medusa-config-${UUID}.json.  Find it:
	 */
	asset_path = mod_path.join('/assets', process.env.MANTA_USER, 'stor');

	assets = mod_fs.readdirSync(asset_path);
	for (var i = 0; i < assets.length; i++) {
		var asset = assets[i];

		if (asset.match(/^medusa-config-.*\.json$/)) {
			return (mod_path.join(asset_path, asset));
		}
	}

	return (null);
}

function
read_and_delete_configuration(callback)
{
	var config, config_file, config_key;

	config_file = locate_config_key();
	if (!config_file) {
		LOG.error('could not find configuration key');
		process.exit(1);
	}

	LOG.info({ config_file: config_file }, 'reading configuration');
	try {
		config = require(config_file);
	} catch (e) {
		LOG.error(e, 'could not parse configuration file');
		process.exit(1);
	}

	config_key = config_file.replace(/^\/assets/, '');
	LOG.info({ config_key: config_key }, 'removing configuration object');

	CLIENT.unlink(config_key, function (err) {
		/*
		 * We don't really care if this object can't be removed
		 * at this time.  The mlogin client will try and unlink
		 * it on completion as well.
		 */

		if (err)
			LOG.error(err, 'could not remove configuration ' +
			    'object');

		callback(config);
	});
}

function
createEnvironment(login)
{
	var profile = [
		'',
		'',
		'PS1="${MANTA_USER}@manta # "',
		'',
		'echo "\n\n * Your Manta Object is at: $MANTA_INPUT_FILE"\n\n',
		'',
		''
	].join('\n');
	mod_fs.appendFileSync('/root/.bashrc', profile);

	var env = {};
	var keys = Object.keys(process.env);
	for (var i = 0; i < keys.length; i++) {
		var name = keys[i];
		env[name] = process.env[name];
	}

	/*
	 * Provide a PS1 string for non-login shells:
	 */
	var BOLD = '\\[\x1b[1m\\]';
	var RESET = '\\[\x1b[0m\\]';
	env.PS1 = BOLD + process.env.MANTA_USER + '@manta # ' + RESET;

	if (login) {
		env.LOGNAME = 'root';
		env.HOME = '/root';
	}

	return (env);
}

function
handle_text(ctx, text)
{
	var o;
	var m = text.match(/^mlogin:(.*)$/);
	if (!m)
		return;

	o = JSON.parse(m[1]);
	if (o.type === 'resize') {
		LOG.debug(o, 'resize');
		ctx.ctx_x = o.columns;
		ctx.ctx_y = o.lines;
		if (ctx.ctx_pty)
			ctx.ctx_pty.resize(ctx.ctx_x, ctx.ctx_y);
	} else if (o.type === 'start') {
		var cmd, args;

		if (ctx.ctx_pty) {
			LOG.warn(o, 'surplus start message; ignoring');
			return;
		}

		LOG.info(o, 'start');
		if (o.columns)
			ctx.ctx_x = o.columns;
		if (o.lines)
			ctx.ctx_y = o.lines;

		if (o.command) {
			ctx.ctx_cmd = o.command;
			ctx.ctx_args = o.arguments || [];
		}

		if (o.term)
			ctx.ctx_term = o.term;

		if (o.cwd)
			ctx.ctx_cwd = o.cwd;

		/*
		 * Spawn the child process on a new pty:
		 */
		ctx.ctx_pty = mod_pty.spawn(ctx.ctx_cmd, ctx.ctx_args, {
			name: ctx.ctx_term,
			cols: ctx.ctx_x,
			rows: ctx.ctx_y,
			env: createEnvironment(false),
			cwd: ctx.ctx_cwd
		});
		LOG.info({ pid: ctx.ctx_pty.pid }, 'started child process');

		/*
		 * Attempt to get pty.js to give us Buffers
		 * rather than strings.
		 */
		ctx.ctx_pty.setEncoding();

		ctx.ctx_pty.on('error', function(err) {
			ctx.ctx_shed.send('mlogin:' + JSON.stringify({
				type: 'error',
				error: err.message
			}));
		});
		ctx.ctx_pty.on('data', function(ch) {
			var buf = Buffer.isBuffer(ch) ? ch :
			    new Buffer(ch);
			ctx.ctx_shed.send(buf);
		});
		ctx.ctx_pty.on('exit', function() {
			ctx.ctx_shed.send('mlogin:' + JSON.stringify({
				type: 'exit'
			}));
		});

		/*
		 * Inform our master that we have started the requested
		 * process.
		 */
		ctx.ctx_shed.send('mlogin:' + JSON.stringify({
			type: 'started',
			pid: ctx.ctx_pty.pid
		}));
	}
}

function
handle_binary(ctx, buf)
{
	/*
	 * If our pty is established, pass the terminal data to it:
	 */
	if (ctx.ctx_term)
		ctx.ctx_pty.write(buf);
}

function
start_session(shed)
{
	var ctx = {
		ctx_shed: shed,
		ctx_x: 80,
		ctx_y: 25,
		ctx_cmd: '/bin/bash',
		ctx_args: [ '--norc' ],
		ctx_term: 'xterm',
		ctx_pty: null,
		ctx_cwd: process.cwd()
	};

	LOG.info('session started');

	shed.on('text', handle_text.bind(null, ctx));
	shed.on('binary', handle_binary.bind(null, ctx));
}


/*
 * Main entry point.
 */
read_and_delete_configuration(function(config) {
	var parsed, wskey, options;

	LOG.debug({ config: config }, 'configuration');

	mod_assert.object(config, 'config');
	mod_assert.string(config.signed_url, 'config.signed_url');
	mod_assert.bool(config.insecure_tls, 'config.insecure_tls');

	parsed = mod_url.parse(config.signed_url);
	wskey = WATERSHED.generateKey();

	options = {
		port: Number(parsed.port || 443),
		hostname: parsed.hostname,
		headers: {
			'connection': 'upgrade',
			'upgrade': 'websocket',
			'Sec-WebSocket-Key': wskey
		},
		path: parsed.path,
		method: 'GET',
		rejectUnauthorized: !config.insecure_tls
	};

	LOG.debug({ options: options }, 'making HTTP request');

	/*
	 * Send the GET (with Upgrade) request to the pre-signed
	 * public load load balancer URL we were given in our
	 * configuration object.
	 */
	var req = mod_https.request(options);

	req.on('response', function(res) {
		/*
		 * We should _not_ get a regular Response from the
		 * Server, but rather an Upgrade.  Log this error
		 * and abort.
		 */
		var body = '';
		LOG.error({ res: res }, 'server did not Upgrade');
		res.setEncoding('utf8');
		res.on('data', function (chunk) {
			body += chunk.toString();
		});
		res.once('end', function () {
			LOG.error({ body: body }, 'errant request body');
			process.exit(1);
		});
	});

	req.on('upgrade', function(res, socket, head) {
		/*
		 * The server upgraded us.
		 */
		var shed;

		LOG.info({ res: res }, 'server upgraded');

		socket.setNoDelay(true);

		shed = WATERSHED.connect(res, socket, head, wskey);
		shed.on('error', function (err) {
			LOG.error(err, 'connection error');
			process.exit(1);
		});
		shed.on('connectionReset', function () {
			LOG.error(err, 'connection reset');
			process.exit(1);
		});
		shed.on('end', function (code, reason) {
			LOG.info({ code: code, reason: reason },
			    'connection ended');
			process.exit(0);
		});
		shed.on('text', function (text) {
			var o;
			var m = text.match(/^medusa:(.*)$/);
			if (!m)
				return;
			o = JSON.parse(m[1]);
			if (o.type === 'linkup') {
				/*
				 * We're attached to our master via the
				 * reflector.  Initiate the session.
				 */
				LOG.info('link up');
				start_session(shed);
			}
		});
	});

	req.on('error', function(err) {
		LOG.error(err, 'HTTP request error');
		process.exit(1);
	});

	req.end();
});

/* vim: set sts=8 ts=8 sw=8 tw=80 noet: */
