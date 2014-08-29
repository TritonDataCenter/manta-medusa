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
 * The Control Subsystem
 *
 * This subsystem is used to track sessions through their lifecycle.
 *
 * A Medusa Session presently moves through these stages:
 *
 *   0. Prior to Existing.
 *       |
 *       +- existence recorded in moray
 *       |
 *       V
 *   1. Created, waiting for Master (MD_STATE_MASTER_WAIT)
 *       |
 *       +- master websocket attached
 *       +- periodic wait pulse to master initiated
 *       |
 *       V
 *   2. Created, waiting for Slave (MD_STATE_SLAVE_WAIT)
 *       |
 *       +- slave websocket attached
 *       +- periodic wait pulse to master ends
 *       +- link-up message sent to both master and slave
 *       +- use websocket pipe() to forward frames unmodified
 *       |   between master and slave
 *       |
 *       V
 *   3. Forwarding (MD_STATE_FORWARDING)
 *       |
 *       +- either the master or the slave connection experiences
 *       |   an error, or gracefully closes their end of the link
 *       |
 *       V
 *   3. Closing (MD_STATE_CLOSING)
 *       |
 *       +- gracefully close the corresponding websocket endpoint
 *       |
 *       V
 *   4. Post-Destroy.
 *       |
 *       +- we remove both our in-memory record and the moray record
 *       |   of this session
 *       |
 *       O
 *
 * NOTE: Sessions may fail to establish prior to reaching FORWARDING
 * due to any number of error conditions.  If this is the case, we
 * abandon the session and move straight to Post-Destroy.
 */

var mod_events = require('events');
var mod_util = require('util');

var mod_assert = require('assert-plus');
var mod_moray = require('moray');

var mod_common = require('./common');

/*
 * Symbolic Constants
 */
var MD_STATE_MASTER_WAIT = 'master_wait';
var MD_STATE_SLAVE_WAIT = 'slave_wait';
var MD_STATE_FORWARDING = 'forwarding';
var MD_STATE_CLOSING = 'closing';
var MD_STATE_POST_DESTROY = 'post_destroy';

var MD_BUCKET_SESSIONS = 'medusa_sessions';

/*
 * Control messages from the Medusa Engine itself are TEXT WebSocket
 * frames containing a JSON-formatted object, prefixed with "medusa:".
 */
function
mds_generate_message(message)
{
	mod_assert.object(message, 'message');
	mod_assert.string(message.type, 'type');
	return ('medusa:' + JSON.stringify(message));
}

/*
 * MedusaSession implements the state engine for a single session.
 * Instances of this class are indexed (against their ID) in their parent
 * MedusaControl.
 */
function
MedusaSession(opts)
{
	mod_assert.string(opts.id, 'id');
	mod_assert.string(opts.etag, 'etag');
	mod_assert.object(opts.log, 'log');
	mod_assert.object(opts.control, 'control');

	this.mds_id = opts.id;
	this.mds_etag = opts.etag;
	this.mds_create_time = Date.now();

	this.mds_log = opts.log.child({
		component: 'Session',
		id: this.mds_id
	});
	this.mds_control = opts.control;

	this.mds_shed_master = null;
	this.mds_shed_slave = null;

	this.mds_wait_pulse = null;

	this.mds_state = MD_STATE_MASTER_WAIT;

	mod_events.EventEmitter.call(this);
}
mod_util.inherits(MedusaSession, mod_events.EventEmitter);

MedusaSession.prototype.id = function
id()
{
	return (this.mds_id);
};

MedusaSession.prototype.has_master = function
has_master()
{
	return (!!this.mds_shed_master);
};

MedusaSession.prototype.has_slave = function
has_slave()
{
	return (!!this.mds_shed_slave);
};

MedusaSession.prototype.assert_state = function
assert_state(state)
{
	mod_assert.strictEqual(this.mds_state, state, 'unexpected state');
};

MedusaSession.prototype.abandon = function
abandon()
{
	var self = this;
	var log = self.mds_log;
	var control = self.mds_control;

	log.info({ id: self.mds_id }, 'abandoning this connection');

	/*
	 * Cancel the wait pulse timer, if it still exists:
	 */
	self._cancel_wait_pulse();

	/*
	 * Ensure we have closed both sides:
	 */
	if (self.mds_shed_slave) {
		self.mds_shed_slave.removeAllListeners();
		self.mds_shed_slave.destroy();
		self.mds_shed_slave = null;
	}
	if (self.mds_shed_master) {
		self.mds_shed_master.removeAllListeners();
		self.mds_shed_master.destroy();
		self.mds_shed_master = null;
	}

	self.mds_state = MD_STATE_POST_DESTROY;

	/*
	 * Remove this session from our parent Control.
	 */
	control._cancel_session(self.mds_id, self.mds_etag, function () {});
};

MedusaSession.prototype.attach_master = function
attach_master(shed)
{
	var self = this;
	var log = self.mds_log;

	self.assert_state(MD_STATE_MASTER_WAIT);
	mod_assert.object(shed, 'shed');

	self.mds_shed_master = shed;
	shed.once('error', function(err) {
		log.error(err, 'medusa master error');
		if (self.mds_shed_slave)
			self.mds_shed_slave.end('remote connection error');
	});
	shed.once('connectionReset', function() {
		log.error('medusa master connection reset');
		if (self.mds_shed_slave)
			self.mds_shed_slave.end('remote connection reset');
	});
	shed.once('end', function(code, reason) {
		self.mds_state = MD_STATE_CLOSING;
		log.info({ code: code, reason: reason }, 'medusa master end');
		self.mds_shed_master = null;
		if (self.mds_shed_slave === null) {
			/*
			 * We're done with this session
			 */
			self.abandon();
		} else {
			self.mds_shed_slave.end(reason);
		}
	});

	/*
	 * We arrange to forward all messages from the master to the
	 * slave.  Any frames preceding the pairing of the two connections
	 * are simply dropped without ceremony.
	 */
	shed.on('text', function(msg) {
		if (self.mds_shed_slave)
			self.mds_shed_slave.send(msg);
	});
	shed.on('binary', function(msg) {
		if (self.mds_shed_slave)
			self.mds_shed_slave.send(msg);
	});

	self.mds_state = MD_STATE_SLAVE_WAIT;

	/*
	 * Establish wait pulse timer:
	 */
	self.mds_wait_pulse = setInterval(self._send_wait_pulse.bind(self),
	    2 * 1000);
};

MedusaSession.prototype.attach_slave = function
attach_slave(shed)
{
	var self = this;
	var log = self.mds_log;

	self.assert_state(MD_STATE_SLAVE_WAIT);
	mod_assert.object(shed, 'shed');

	self.mds_shed_slave = shed;
	shed.once('error', function(err) {
		log.error(err, 'medusa slave error');
		if (self.mds_shed_master)
			self.mds_shed_master.end('remote connection error');
	});
	shed.once('connectionReset', function() {
		log.error('medusa slave connection reset');
		if (self.mds_shed_master)
			self.mds_shed_master.end('remote connection error');
	});
	shed.once('end', function(code, reason) {
		self.mds_state = MD_STATE_CLOSING;
		log.info({ code: code, reason: reason }, 'medusa slave end');
		self.mds_shed_slave = null;
		if (self.mds_shed_master === null) {
			/*
			 * We're done with this session
			 */
			self.abandon();
		} else {
			self.mds_shed_master.end(reason);
		}
	});

	/*
	 * Cancel wait pulse timer:
	 */
	self._cancel_wait_pulse();

	/*
	 * Forward all messages from slave to master:
	 */
	shed.on('text', function(msg) {
		if (self.mds_shed_master)
			self.mds_shed_master.send(msg);
	});
	shed.on('binary', function(msg) {
		if (self.mds_shed_master)
			self.mds_shed_master.send(msg);
	});

	/*
	 * Send link-up messages to both sides.
	 */
	self.mds_shed_master.send(mds_generate_message({ type: 'linkup' }));
	self.mds_shed_slave.send(mds_generate_message({ type: 'linkup' }));

	/*
	 * We're now in the Forwarding state until the connection ends:
	 */
	self.mds_state = MD_STATE_FORWARDING;
};

MedusaSession.prototype._cancel_wait_pulse = function
_cancel_wait_pulse()
{
	if (this.mds_wait_pulse !== null)
		clearInterval(this.mds_wait_pulse);
	this.mds_wait_pulse = null;
};

MedusaSession.prototype._send_wait_pulse = function
_send_wait_pulse()
{
	var self = this;

	/*
	 * If we've disconnected the master, cancel the wait pulse:
	 */
	if (!self.mds_shed_master) {
		self._cancel_wait_pulse();
		return;
	}
	self.mds_shed_master.send(mds_generate_message({ type: 'wait' }));
};


/*
 * MedusaControl handles the creation of MedusaSessions and the management
 * of the Medusa Session Directory (a moray bucket).
 */
function
MedusaControl(opts)
{
	mod_assert.object(opts.log, 'log');
	mod_assert.object(opts.identity, 'identity');
	mod_assert.string(opts.identity.medusa_host, 'identity.medusa_host');
	mod_assert.string(opts.identity.medusa_ip, 'identity.medusa_ip');
	mod_assert.number(opts.identity.medusa_port, 'identity.medusa_port');
	mod_assert.object(opts.moray, 'moray');
	mod_assert.string(opts.moray.host, 'moray.host');
	mod_assert.number(opts.moray.port, 'moray.port');

	this.mdc_log = opts.log.child({
		component: 'Control'
	});

	this.mdc_sessions = {};

	this.mdc_moray_config = mod_common.clone(opts.moray);
	this.mdc_moray = null;

	this.mdc_moray_config.log = opts.log.child({
		component: 'MorayClient'
	});

	this.mdc_identity = mod_common.clone(opts.identity);

	mod_events.EventEmitter.call(this);
}
mod_util.inherits(MedusaControl, mod_events.EventEmitter);

MedusaControl.prototype._init_moray_buckets = function
_init_moray_buckets(moray, _cb)
{
	var opts;

	mod_assert.func(_cb);

	/*
	 * We only need to be able to map the Session ID to an
	 * object.
	 */
	opts = {
		index: {
			session_id: {
				type: 'string',
				unique: true
			}
		},
		options: {
			version: 1
		}
	};
	moray.putBucket(MD_BUCKET_SESSIONS, opts, _cb);
};

MedusaControl.prototype._init_moray = function
_init_moray(_cb)
{
	var self = this;
	var log = this.mdc_log;
	var config = this.mdc_moray_config;
	var moray;

	mod_assert.func(_cb);
	mod_assert.ok(this.mdc_moray === null);

	log.info(config, 'moray config');
	moray = mod_moray.createClient(config);

	var calledback = false;
	function callback(err) {
		if (!calledback) {
			calledback = true;
			_cb(err);
		}
	}

	moray.on('error', function (err) {
		log.error(err, 'moray client error');
		moray.close();
		callback(err);
	});

	moray.on('close', function () {
		log.error('moray client closed');
	});

	moray.on('connect', function () {
		log.info('moray connected');
		self._init_moray_buckets(moray, function (err) {
			if (!err) {
				log.info('moray buckets created');
				mod_assert.ok(self.mdc_moray === null ||
					      self.mdc_moray === moray);
				self.mdc_moray = moray;
			} else {
				log.error(err, 'err creating moray buckets');
				moray.close();
			}
			callback(err);
		});
	});
};

MedusaControl.prototype._cancel_session = function
_cancel_session(session_id, etag, _cb)
{
	var log = this.mdc_log;
	var moray = this.mdc_moray;
	var obj;

	mod_assert.string(session_id, 'session_id');
	mod_assert.string(etag, 'etag');
	mod_assert.func(_cb);

	mod_assert.ok(moray);

	obj = mod_common.clone(this.mdc_identity);
	obj.session_id = session_id;

	moray.deleteObject(MD_BUCKET_SESSIONS, session_id, { etag: etag },
	    function (err) {
		if (err) {
			log.error(err, 'moray: update failed');
			_cb(err);
			return;
		}
		log.info(obj, 'session cleared from moray');
		_cb(null, false);
	});

	delete this.mdc_sessions[session_id];
};

MedusaControl.prototype._claim_session = function
_claim_session(session_id, _cb)
{
	var log = this.mdc_log;
	var moray = this.mdc_moray;
	var obj;

	mod_assert.string(session_id, 'session_id');
	mod_assert.func(_cb);

	mod_assert.ok(moray);

	obj = mod_common.clone(this.mdc_identity);
	obj.session_id = session_id;

	moray.putObject(MD_BUCKET_SESSIONS, session_id, obj, { etag: null },
	    function (err, meta) {
		if (err) {
			if (err.name === 'EtagConflictError') {
				/*
				 * This record already existed, which means
				 * it's owned by another medusa instance.
				 */
				log.info({ session_id: session_id },
				    'moray: session already exists');
				_cb(null, true);
			} else {
				log.error(err, 'moray: update failed');
				_cb(err);
			}
			return;
		}
		mod_assert.object(meta, 'meta');
		mod_assert.string(meta.etag, 'meta.etag');
		log.info(obj, 'session written to moray');
		_cb(null, false, meta.etag);
	});
};

MedusaControl.prototype.init = function
init(_cb)
{
	var log = this.mdc_log;

	log.info('initialising');

	this._init_moray(function(err) {
		if (err)
			log.error(err, 'initialisation failed');
		else
			log.info(err, 'initialisation ok');
		_cb(err);
	});
};

MedusaControl.prototype.status_summary = function
status_summary()
{
	var sessions = Object.keys(this.mdc_sessions);
	var sessionsummary = [];

	for (var i = 0; i < sessions.length; i++) {
		var s = this.mdc_sessions[sessions[i]];

		sessionsummary.push({
			id: s.mds_id,
			state: s.mds_state,
			has_master: !!s.mds_shed_master,
			has_slave: !!s.mds_shed_slave,
			create_time: s.mds_create_time
		});
	}

	return ({
		sessions: sessionsummary
	});
};

MedusaControl.prototype.get_session = function
get_session(id)
{
	mod_assert.string(id, 'id');

	return (this.mdc_sessions[id] || null);
};

MedusaControl.prototype.create_session = function
create_session(id, callback)
{
	var self = this;
	var session;
	var log = self.mdc_log;

	mod_assert.string(id, 'id');
	id = id.toLowerCase();

	/*
	 * Look up the session in our own memory first, and bail if
	 * it exists.
	 */
	if (self.get_session(id)) {
		callback(new Error('session exists already'));
		return;
	}

	/*
	 * We don't have this session already -- confirm it's global
	 * uniqueness by attempting to exclusively create it in moray.
	 * If we fail here, another medusa has this session.
	 */
	self._claim_session(id, function(err, exists, etag) {
		if (err) {
			callback(err);
			return;
		}
		if (exists) {
			callback(new Error('session exists already'));
			return;
		} else {
			mod_assert.string(etag, 'etag');
		}

		/*
		 * The session did not exist, but is now recorded
		 * in moray, so create it and return it to the caller:
		 */
		session = new MedusaSession({
			id: id,
			control: self,
			log: log,
			etag: etag
		});
		self.mdc_sessions[session.id()] = session;

		log.info('created session ' + session.id());

		callback(null, session);
		return;
	});
};

module.exports = {
	MedusaControl: MedusaControl
};

/* vim: set ts=8 sts=8 sw=8 noet: */
