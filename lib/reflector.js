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
 * The Reflector
 *
 * This server marries up inbound connections from mlogin clients with
 * inbound connections from a medusa-agent running in the context of
 * a user's Marlin Job.  As all connections are inbound, neither the
 * User nor the Marlin Job need to be able to listen for connections on
 * a publicly accessible IP address.
 *
 *
 *  User:
 *  +---------+           +---------+       +----------+
 *  |         |websockets |         |       |          |
 *  | mlogin  +----+----->| muskie0 +------>| medusa   |
 *  |         |    :      |         |       | reflector|
 *  +---------+    :      +---------+       +----------+
 *        x      (load       . . .               ^
 *       x      balanced) +---------+            |
 *      x          :      |         |            |
 *     xx    +-----+----->| muskieN +------------+
 *    xx     |            |         |
 *    x      |            +---------+       Marlin Job:
 *    x      |                              +----------+
 *    x      |websockets                    |          |
 *    x      +------------------------------+ medusa   |
 *    x                                     | agent    |
 *     xx                                  x+----------+
 *      xxxxx                           xxxx
 *          xxxxxxx           xxxxxxxxxxx
 *                xxxxxxxxxxxxx        ^
 *                                     |
 *         Interactive Shell Session --+
 */

/*
 * Static configuration.
 */
var MDR_SERVER_NAME = 'MedusaReflector';

/*
 * Imported Modules.
 */
var mod_path = require('path');
var mod_fs = require('fs');
var mod_os = require('os');

var mod_assert = require('assert-plus');
var mod_bunyan = require('bunyan');
var mod_panic = require('panic');
var mod_restify = require('restify');
var mod_watershed = require('watershed');
var mod_vasync = require('vasync');

var mod_common = require('./common');
var mod_control = require('./control');
var mod_asset = require('./asset');


/*
 * Helper Functions.
 */
function
mdr_validate_config(config)
{
	/*
	 * HTTP Server Listen Port:
	 */
	mod_assert.optionalString(config.bind_ip, 'bind_ip');
	mod_assert.number(config.port, 'port');
	mod_assert.ok(config.port > 0 && config.port < 65536,
	    'port not in range 1-65535');
	mod_assert.object(config.moray, 'moray');
	mod_assert.string(config.moray.host, 'moray.host');
	mod_assert.number(config.moray.port, 'moray.port');
}

function
mdr_get_ip_address(log, config)
{
	var retaddr = null;
	var ifaces, keys;

	if (config.bind_ip)
		return (config.bind_ip);

	ifaces = mod_os.networkInterfaces();
	keys = Object.keys(ifaces);
	for (var i = 0; i < keys.length; i++) {
		var addrs = ifaces[keys[i]];
		for (var j = 0; j < addrs.length; j++) {
			var addr = addrs[j];
			if (addr.internal || addr.family !== 'IPv4')
				continue;

			if (retaddr !== null) {
				log.fatal({ interfaces: ifaces }, 'detected' +
				    ' more than one IP address; cannot ' +
				    'determine which to use.');
				mod_assert.ok(false, 'more than one IP');
			}

			retaddr = addr.address;
		}
	}

	if (retaddr === null) {
		log.fatal({ interfaces: ifaces }, 'could not determine IP ' +
		    'address.');
		mod_assert.ok(false, 'could not detect IP');
	}

	return (retaddr);
}

/*
 * The Web(Socket) API is exposed via the MedusaReflector class:
 */
function
MedusaReflector(logger, config_filename)
{
	this.mdr_log = logger;

	/*
	 * Configuration:
	 */
	this.mdr_conf = mod_common.readConfig(this.mdr_log, config_filename);

	this.mdr_log.info({ conf: this.mdr_conf }, 'configuration');
	mdr_validate_config(this.mdr_conf);

	/*
	 * This Reflector's Identity:
	 */
	this.mdr_identity = {
		medusa_host: mod_os.hostname(),
		medusa_ip: mdr_get_ip_address(this.mdr_log, this.mdr_conf),
		medusa_port: this.mdr_conf.port
	};
	this.mdr_log.info({ identity: this.mdr_identity }, 'identity');

	/*
	 * Restify (HTTP):
	 */
	this.mdr_server = mod_restify.createServer({
		name: MDR_SERVER_NAME,
		log: this.mdr_log.child({
			component: 'HttpServer',
			serializers: mod_restify.bunyan.serializers
		}),
		handleUpgrades: true
	});

	/*
	 * Control Subsystem:
	 */
	this.mdr_control = new mod_control.MedusaControl({
		log: this.mdr_log,
		identity: this.mdr_identity,
		moray: this.mdr_conf.moray
	});

	/*
	 * Watershed (Websockets):
	 */
	this.mdr_watershed = new mod_watershed.Watershed();
}

MedusaReflector.prototype.init = function
init(callback)
{
	var self = this;
	var log = self.mdr_log;
	var bind_ip = self.mdr_identity.medusa_ip;
	var port = self.mdr_identity.medusa_port;
	var server = self.mdr_server;
	var control = self.mdr_control;
	var maopts;

	var init_restify = function(_, next) {
		server.use(mod_restify.acceptParser(server.acceptable));
		server.use(mod_restify.queryParser());
		server.use(mod_restify.bodyParser({ 'mapParams': false }));

		server.on('after', mod_restify.auditLogger({
			log: log.child({ component: 'AuditLog' })
		}));

		server.on('uncaughtException', mod_common.restifyPanic);

		server.get('/status', self.handle_status.bind(self));
		server.get('/attach/:id/master',
		    self.handle_master.bind(self));
		server.get('/attach/:id/slave', self.handle_slave.bind(self));

		server.listen(port, bind_ip, function() {
			log.info({ port: port }, 'server listening');
			next();
		});
	};

	var init_asset = function(_, next) {
		/*
		 * Upload agent asset to Manta so that jobs can use it:
		 */
		maopts = { log: log };
		mod_asset.put_medusa_agent(maopts, function(err) {
			if (err) {
				log.error(err, 'failed to upload medusa' +
				    ' agent asset, trying again in 5 seconds');
				setTimeout(init_asset.bind(null, _, next),
					   5000);
				return;
			}
			log.info('manta agent asset uploaded');
			next();
		});
	};

	var init_control = function(_, next) {
		control.init(function (err) {
			if (err) {
				log.error(err, 'init: error initing control. ' +
					  'trying again in 5 seconds.');
				setTimeout(init_control.bind(null, _, next),
					   5000);
				return;
			}
			next();
		});
	};

	var flow = mod_vasync.pipeline({
		funcs: [
			init_control,
			init_asset,
			init_restify
		]
	}, function (err, results) {
		callback(err);
	});
}

MedusaReflector.prototype.handle_status = function
handle_status(req, res, next)
{
	var log = req.log;
	var control = this.mdr_control;

	log.debug('status request');

	res.send(200, {
		health: 'ok',
		sessions: control.status_summary()
	});
	return (next());
}

MedusaReflector.prototype.handle_master = function
handle_master(req, res, next)
{
	var self = this;
	var log = req.log;
	var control = self.mdr_control;
	var id, upgrade, shed;

	log.info({ params: req.params }, 'master-side attach request');

	id = (req.params.id || '').trim();
	if (!id) {
		res.send(500, new Error('must provide "id"'));
		return (next(false));
	}

	/*
	 * Ensure that this is an attempt at an Upgrade:
	 */
	if (!res.claimUpgrade) {
		log.error({ req: req }, 'did not Upgrade');
		res.send(500, new Error('must Upgrade'));
		return (next(false));
	}

	/*
	 * Ensure that we are the sole current master request for this
	 * job:
	 */
	control.create_session(id, function(err, session) {
		if (err) {
			log.error(err);
			res.send(500, err);
			return (next(false));
		}

		log.info('created session %s', session.id());

		/*
		 * Attempt to upgrade to a websockets connection:
		 */
		try {
			upgrade = res.claimUpgrade();
			upgrade.socket.setNoDelay(true);
			shed = self.mdr_watershed.accept(req, upgrade.socket,
			    upgrade.head);
			/*
			 * If Watershed doesn't throw, then it sent a 'HTTP 101
			 * Switching Protocols' to the client.  Set the status
			 * code on the Response so that the audit logs reflect
			 * this:
			 */
			res.statusCode = 101;
		} catch (ex) {
			log.error(ex, 'websockets upgrade failed, ' +
			    'abandoning session.');
			session.abandon();
			res.send(500, ex);
			return (next(false));
		}

		log.info('established websockets on %s', session.id());

		session.attach_master(shed);

		return (next(false));
	});
}

MedusaReflector.prototype.handle_slave = function
handle_slave(req, res, next)
{
	var self = this;
	var log = req.log;
	var control = self.mdr_control;
	var id, session, upgrade, shed;

	log.info({ params: req.params }, 'slave-side attach request');

	id = (req.params.id || '').trim();
	if (!id) {
		res.send(500, new Error('must provide "id"'));
		return (next(false));
	}
	id = req.params.id.trim().toLowerCase();

	/*
	 * Ensure that this is an attempt at an Upgrade:
	 */
	if (!res.claimUpgrade) {
		log.error({ req: req }, 'did not Upgrade');
		res.send(500, new Error('must Upgrade'));
		return (next(false));
	}

	session = control.get_session(id);
	if (!session) {
		res.send(500, new Error('unknown session'));
		return (next(false));
	}

	if (session.has_slave()) {
		res.send(500, new Error('session already has a slave'));
		return (next(false));
	}

	/*
	 * Attempt to upgrade to a websockets connection:
	 */
	try {
		upgrade = res.claimUpgrade();
		upgrade.socket.setNoDelay(true);
		shed = self.mdr_watershed.accept(req, upgrade.socket,
		    upgrade.head);
		/*
		 * If Watershed doesn't throw, then it sent a 'HTTP 101
		 * Switching Protocols' to the client.  Set the status
		 * code on the Response so that the audit logs reflect
		 * this:
		 */
		res.statusCode = 101;
	} catch (ex) {
		log.error(ex);
		res.send(500, ex);
		return (next(false));
	}

	log.info('established websockets on %s', session.id());

	session.attach_slave(shed);

	return (next(false));
}


/*
 * Mainline
 */
function
main()
{
	var config_filename;
	var log;
	var mdr;

	log = mod_bunyan.createLogger({
		name: MDR_SERVER_NAME,
		streams: [{
			stream: process.stdout,
			level: process.env.LOG_LEVEL || 'info'
		}]
	});

	if (!process.env.NO_ABORT_ON_CRASH) {
		mod_panic.enablePanicOnCrash({
			skipDump: true,
			abortOnPanic: true
		});
	}

	config_filename = process.env.CONFIG_FILE ? process.env.CONFIG_FILE :
	    mod_path.join(__dirname, '..', 'etc', 'config.json');

	mdr = new MedusaReflector(log, config_filename);
	mdr.init(function(err) {
		if (err) {
			log.error(err, 'initialisation failed');
			process.exit(1);
		}
	});
}

main();

/* vim: set ts=8 sts=8 sw=8 noet: */
