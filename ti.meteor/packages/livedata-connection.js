var WebSocket = require('net.iamyellow.tiws');

var Deps = Package.deps.Deps;
var EJSON = Package.ejson.EJSON;
var LocalCollection = Package.minimongo.LocalCollection;
var Minimongo = Package.minimongo.Minimongo;

LivedataTest = {}, DDP = {};

SUPPORTED_DDP_VERSIONS = ['pre2', 'pre1'];

LivedataTest.SUPPORTED_DDP_VERSIONS = SUPPORTED_DDP_VERSIONS;

MethodInvocation = function(options) {
  var self = this;

  // true if we're running not the actual method, but a stub (that is,
  // if we're on a client (which may be a browser, or in the future a
  // server connecting to another server) and presently running a
  // simulation of a server-side method for latency compensation
  // purposes). not currently true except in a client such as a browser,
  // since there's usually no point in running stubs unless you have a
  // zero-latency connection to the user.
  this.isSimulation = options.isSimulation;

  // call this function to allow other method invocations (from the
  // same client) to continue running without waiting for this one to
  // complete.
  this._unblock = options.unblock || function() {};
  this._calledUnblock = false;

  // current user id
  this.userId = options.userId;

  // sets current user id in all appropriate server contexts and
  // reruns subscriptions
  this._setUserId = options.setUserId || function() {};

  // On the server, the connection this method call came in on.
  this.connection = options.connection;

  // The seed for randomStream value generation
  this.randomSeed = options.randomSeed;

  // This is set by RandomStream.get; and holds the random stream state
  this.randomStream = null;
};

_.extend(MethodInvocation.prototype, {
  unblock: function() {
    var self = this;
    self._calledUnblock = true;
    self._unblock();
  },
  setUserId: function(userId) {
    var self = this;
    if (self._calledUnblock)
      throw new Error("Can't call setUserId in a method after calling unblock");
    self.userId = userId;
    self._setUserId(userId);
  }
});

parseDDP = function(stringMessage) {
  try {
    var msg = JSON.parse(stringMessage);
  } catch (e) {
    Meteor._debug("Discarding message with invalid JSON", stringMessage);
    return null;
  }
  // DDP messages must be objects.
  if (msg === null || typeof msg !== 'object') {
    Meteor._debug("Discarding non-object DDP message", stringMessage);
    return null;
  }

  // massage msg to get it into "abstract ddp" rather than "wire ddp" format.

  // switch between "cleared" rep of unsetting fields and "undefined"
  // rep of same
  if (_.has(msg, 'cleared')) {
    if (!_.has(msg, 'fields'))
      msg.fields = {};
    _.each(msg.cleared, function(clearKey) {
      msg.fields[clearKey] = undefined;
    });
    delete msg.cleared;
  }

  _.each(['fields', 'params', 'result'], function(field) {
    if (_.has(msg, field))
      msg[field] = EJSON._adjustTypesFromJSONValue(msg[field]);
  });

  return msg;
};

stringifyDDP = function(msg) {
  var copy = EJSON.clone(msg);
  // swizzle 'changed' messages from 'fields undefined' rep to 'fields
  // and cleared' rep
  if (_.has(msg, 'fields')) {
    var cleared = [];
    _.each(msg.fields, function(value, key) {
      if (value === undefined) {
        cleared.push(key);
        delete copy.fields[key];
      }
    });
    if (!_.isEmpty(cleared))
      copy.cleared = cleared;
    if (_.isEmpty(copy.fields))
      delete copy.fields;
  }
  // adjust types to basic
  _.each(['fields', 'params', 'result'], function(field) {
    if (_.has(copy, field))
      copy[field] = EJSON._adjustTypesToJSONValue(copy[field]);
  });
  if (msg.id && typeof msg.id !== 'string') {
    throw new Error("Message id is not a string");
  }
  return JSON.stringify(copy);
};

// This is private but it's used in a few places. accounts-base uses
// it to get the current user. accounts-password uses it to stash SRP
// state in the DDP session. Meteor.setTimeout and friends clear
// it. We can probably find a better way to factor this.
DDP._CurrentInvocation = new Meteor.EnvironmentVariable;


// Heartbeat options:
//   heartbeatInterval: interval to send pings, in milliseconds.
//   heartbeatTimeout: timeout to close the connection if a reply isn't
//     received, in milliseconds.
//   sendPing: function to call to send a ping on the connection.
//   onTimeout: function to call to close the connection.

Heartbeat = function(options) {
  var self = this;

  self.heartbeatInterval = options.heartbeatInterval;
  self.heartbeatTimeout = options.heartbeatTimeout;
  self._sendPing = options.sendPing;
  self._onTimeout = options.onTimeout;

  self._heartbeatIntervalHandle = null;
  self._heartbeatTimeoutHandle = null;
};

_.extend(Heartbeat.prototype, {
  stop: function() {
    var self = this;
    self._clearHeartbeatIntervalTimer();
    self._clearHeartbeatTimeoutTimer();
  },

  start: function() {
    var self = this;
    self.stop();
    self._startHeartbeatIntervalTimer();
  },

  _startHeartbeatIntervalTimer: function() {
    var self = this;
    self._heartbeatIntervalHandle = Meteor.setTimeout(
      _.bind(self._heartbeatIntervalFired, self),
      self.heartbeatInterval
    );
  },

  _startHeartbeatTimeoutTimer: function() {
    var self = this;
    self._heartbeatTimeoutHandle = Meteor.setTimeout(
      _.bind(self._heartbeatTimeoutFired, self),
      self.heartbeatTimeout
    );
  },

  _clearHeartbeatIntervalTimer: function() {
    var self = this;
    if (self._heartbeatIntervalHandle) {
      Meteor.clearTimeout(self._heartbeatIntervalHandle);
      self._heartbeatIntervalHandle = null;
    }
  },

  _clearHeartbeatTimeoutTimer: function() {
    var self = this;
    if (self._heartbeatTimeoutHandle) {
      Meteor.clearTimeout(self._heartbeatTimeoutHandle);
      self._heartbeatTimeoutHandle = null;
    }
  },

  // The heartbeat interval timer is fired when we should send a ping.
  _heartbeatIntervalFired: function() {
    var self = this;
    self._heartbeatIntervalHandle = null;
    self._sendPing();
    // Wait for a pong.
    self._startHeartbeatTimeoutTimer();
  },

  // The heartbeat timeout timer is fired when we sent a ping, but we
  // timed out waiting for the pong.
  _heartbeatTimeoutFired: function() {
    var self = this;
    self._heartbeatTimeoutHandle = null;
    self._onTimeout();
  },

  pingReceived: function() {
    var self = this;
    // We know the connection is alive if we receive a ping, so we
    // don't need to send a ping ourselves.  Reset the interval timer.
    if (self._heartbeatIntervalHandle) {
      self._clearHeartbeatIntervalTimer();
      self._startHeartbeatIntervalTimer();
    }
  },

  pongReceived: function() {
    var self = this;

    // Receiving a pong means we won't timeout, so clear the timeout
    // timer and start the interval again.
    if (self._heartbeatTimeoutHandle) {
      self._clearHeartbeatTimeoutTimer();
      self._startHeartbeatIntervalTimer();
    }
  }
});



////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                //
// packages/livedata/stream_client_sockjs.js                                                                      //
//                                                                                                                //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// @param url {String} URL to Meteor app                                                                          // 1
//   "http://subdomain.meteor.com/" or "/" or                                                                     // 2
//   "ddp+sockjs://foo-**.meteor.com/sockjs"                                                                      // 3
LivedataTest.ClientStream = function(url, options) { // 4
  var self = this; // 5
  self.options = _.extend({ // 6
    retry: true // 7
  }, options); // 8
  self._initCommon(); // 9
  // 10
  //// Constants                                                                                                  // 11
  // 12
  // 13
  // how long between hearing heartbeat from the server until we declare                                          // 14
  // the connection dead. heartbeats come every 45s (stream_server.js)                                            // 15
  //                                                                                                              // 16
  // NOTE: this is a older timeout mechanism. We now send heartbeats at                                           // 17
  // the DDP level (https://github.com/meteor/meteor/pull/1865), and                                              // 18
  // expect those timeouts to kill a non-responsive connection before                                             // 19
  // this timeout fires. This is kept around for compatibility (when                                              // 20
  // talking to a server that doesn't support DDP heartbeats) and can be                                          // 21
  // removed later.                                                                                               // 22
  self.HEARTBEAT_TIMEOUT = 100 * 1000; // 23
  // 24
  self.rawUrl = url; // 25
  self.socket = null; // 26
  // 27
  self.heartbeatTimer = null; // 28                                                                                           // 36
  self._launchConnection(); // 37
}; // 38
// 39
_.extend(LivedataTest.ClientStream.prototype, { // 40
  // 41
  // data is a utf8 string. Data sent while not connected is dropped on                                           // 42
  // the floor, and it is up the user of this API to retransmit lost                                              // 43
  // messages on 'reset'                                                                                          // 44
  send: function(data) { // 45
    var self = this; // 46
    if (self.currentStatus.connected) { // 47
      self.socket.send(data); // 48
    } // 49
  }, // 50
  // 51
  // Changes where this connection points                                                                         // 52
  _changeUrl: function(url) { // 53
    var self = this; // 54
    self.rawUrl = url; // 55
  }, // 56
  // 57
  _connected: function() { // 58
    var self = this; // 59
    // 60
    if (self.connectionTimer) { // 61
      clearTimeout(self.connectionTimer); // 62
      self.connectionTimer = null; // 63
    } // 64
    // 65
    if (self.currentStatus.connected) { // 66
      // already connected. do nothing. this probably shouldn't happen.                                           // 67
      return; // 68
    } // 69
    // 70
    // update status                                                                                              // 71
    self.currentStatus.status = "connected"; // 72
    self.currentStatus.connected = true; // 73
    self.currentStatus.retryCount = 0; // 74
    self.statusChanged(); // 75
    // 76
    // fire resets. This must come after status change so that clients                                            // 77
    // can call send from within a reset callback.                                                                // 78
    _.each(self.eventCallbacks.reset, function(callback) {
      callback();
    }); // 79
    // 80
  }, // 81
  // 82
  _cleanup: function() { // 83
    var self = this; // 84
    // 85
    self._clearConnectionAndHeartbeatTimers(); // 86
    if (self.socket) { // 87
      self.socket.onmessage = self.socket.onclose // 88
      = self.socket.onerror = self.socket.onheartbeat = function() {}; // 89
      self.socket.close(); // 90
      self.socket = null; // 91
    } // 92
    // 93
    _.each(self.eventCallbacks.disconnect, function(callback) {
      callback();
    }); // 94
  }, // 95
  // 96
  _clearConnectionAndHeartbeatTimers: function() { // 97
    var self = this; // 98
    if (self.connectionTimer) { // 99
      clearTimeout(self.connectionTimer); // 100
      self.connectionTimer = null; // 101
    } // 102
    if (self.heartbeatTimer) { // 103
      clearTimeout(self.heartbeatTimer); // 104
      self.heartbeatTimer = null; // 105
    } // 106
  }, // 107
  // 108
  _heartbeat_timeout: function() { // 109
    var self = this; // 110
    Meteor._debug("Connection timeout. No sockjs heartbeat received."); // 111
    self._lostConnection(); // 112
  }, // 113
  // 114
  _heartbeat_received: function() { // 115
    var self = this; // 116
    // If we've already permanently shut down this stream, the timeout is                                         // 117
    // already cleared, and we don't need to set it again.                                                        // 118
    if (self._forcedToDisconnect) // 119
      return; // 120
    if (self.heartbeatTimer) // 121
      clearTimeout(self.heartbeatTimer); // 122
    self.heartbeatTimer = setTimeout( // 123
      _.bind(self._heartbeat_timeout, self), // 124
      self.HEARTBEAT_TIMEOUT); // 125
  }, // 126
  // 12                                                                                                            // 148                                                                                                           // 149
  _launchConnection: function() { // 150
    var self = this; // 151
    self._cleanup(); // cleanup the old socket, if there was one.                                                 // 152
    // 153
    /*
      var options = _.extend({ // 154
        protocols_whitelist: self._sockjsProtocolsWhitelist() // 155
      }, self.options._sockjsOptions); // 156
*/
    // 157
    // Convert raw URL to SockJS URL each time we open a connection, so that we                                   // 158
    // can connect to random hostnames and get around browser per-host                                            // 159
    // connection limits.     
    self.socket = WebSocket.createWS();

    var url = {
      protocol: self.rawUrl.use_ssl ? "wss://" : "ws://",
      host:self.rawUrl.host,
      port:self.rawUrl.port
    };
    self.socket.open(url.protocol + url.host + ':' + url.port + '/' + 'websocket');

    self.socket.addEventListener('open', function() {
      // just go ahead and open the connection on connect
      self._connected();
    });

    self.socket.addEventListener('message', function(data) {
      self._heartbeat_received(); // 166
      // 167
      if (self.currentStatus.connected) // 168
        _.each(self.eventCallbacks.message, function(callback) { // 169
        callback(data.data); // 170
      });
    });

    self.socket.addEventListener('error', function(error) {
      console.log("socket error: " + JSON.stringify(error));
      //self.socket.close();
      //Meteor._debug("stream error", _.toArray(arguments), (new Date()).toDateString());
    });

    self.socket.addEventListener('close', function(event) {
      console.log("socket close");
      self._lostConnection();
    });
    /*
      self.socket.onheartbeat = function() { // 182
        self._heartbeat_received(); // 183
      }; // 184*/
    // 185
    if (self.connectionTimer) // 186
      clearTimeout(self.connectionTimer); // 187
    self.connectionTimer = setTimeout( // 188
      _.bind(self._lostConnection, self), // 189
      self.CONNECT_TIMEOUT); // 190
  } // 191
}); // 192
// 193
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////



// @param url {String|Object} URL to Meteor app,
//   or an object as a test hook (see code)
// Options:
//   reloadWithOutstanding: is it OK to reload if there are outstanding methods?
//   headers: extra headers to send on the websockets connection, for
//     server-to-server DDP only
//   _sockjsOptions: Specifies options to pass through to the sockjs client
//   onDDPNegotiationVersionFailure: callback when version negotiation fails.
//
// XXX There should be a way to destroy a DDP connection, causing all
// outstanding method calls to fail.
//
// XXX Our current way of handling failure and reconnection is great
// for an app (where we want to tolerate being disconnected as an
// expect state, and keep trying forever to reconnect) but cumbersome
// for something like a command line tool that wants to make a
// connection, call a method, and print an error if connection
// fails. We should have better usability in the latter case (while
// still transparently reconnecting if it's just a transient failure
// or the server migrating us).
var Connection = function(url, options) {
  var self = this;
  options = _.extend({
    onConnected: function() {},
    onDDPVersionNegotiationFailure: function(description) {
      Meteor._debug(description);
    },
    heartbeatInterval: 35000,
    heartbeatTimeout: 15000,
    // These options are only for testing.
    reloadWithOutstanding: false,
    supportedDDPVersions: SUPPORTED_DDP_VERSIONS,
    retry: true,
    respondToPings: true
  }, options);

  // If set, called when we reconnect, queuing method calls _before_ the
  // existing outstanding ones. This is the only data member that is part of the
  // public API!
  self.onReconnect = null;

  // as a test hook, allow passing a stream instead of a url.

    self._stream = new LivedataTest.ClientStream(url, {
      retry: options.retry,
      headers: options.headers,
      _sockjsOptions: options._sockjsOptions,
      // To keep some tests quiet (because we don't have a real API for handling
      // client-stream-level errors).
      _dontPrintErrors: options._dontPrintErrors
    });

  self._lastSessionId = null;
  self._versionSuggestion = null; // The last proposed DDP version.
  self._version = null; // The DDP version agreed on by client and server.
  self._stores = {}; // name -> object with methods
  self._methodHandlers = {}; // name -> func
  self._nextMethodId = 1;
  self._supportedDDPVersions = options.supportedDDPVersions;

  self._heartbeatInterval = options.heartbeatInterval;
  self._heartbeatTimeout = options.heartbeatTimeout;

  // Tracks methods which the user has tried to call but which have not yet
  // called their user callback (ie, they are waiting on their result or for all
  // of their writes to be written to the local cache). Map from method ID to
  // MethodInvoker object.
  self._methodInvokers = {};

  // Tracks methods which the user has called but whose result messages have not
  // arrived yet.
  //
  // _outstandingMethodBlocks is an array of blocks of methods. Each block
  // represents a set of methods that can run at the same time. The first block
  // represents the methods which are currently in flight; subsequent blocks
  // must wait for previous blocks to be fully finished before they can be sent
  // to the server.
  //
  // Each block is an object with the following fields:
  // - methods: a list of MethodInvoker objects
  // - wait: a boolean; if true, this block had a single method invoked with
  //         the "wait" option
  //
  // There will never be adjacent blocks with wait=false, because the only thing
  // that makes methods need to be serialized is a wait method.
  //
  // Methods are removed from the first block when their "result" is
  // received. The entire first block is only removed when all of the in-flight
  // methods have received their results (so the "methods" list is empty) *AND*
  // all of the data written by those methods are visible in the local cache. So
  // it is possible for the first block's methods list to be empty, if we are
  // still waiting for some objects to quiesce.
  //
  // Example:
  //  _outstandingMethodBlocks = [
  //    {wait: false, methods: []},
  //    {wait: true, methods: [<MethodInvoker for 'login'>]},
  //    {wait: false, methods: [<MethodInvoker for 'foo'>,
  //                            <MethodInvoker for 'bar'>]}]
  // This means that there were some methods which were sent to the server and
  // which have returned their results, but some of the data written by
  // the methods may not be visible in the local cache. Once all that data is
  // visible, we will send a 'login' method. Once the login method has returned
  // and all the data is visible (including re-running subs if userId changes),
  // we will send the 'foo' and 'bar' methods in parallel.
  self._outstandingMethodBlocks = [];

  // method ID -> array of objects with keys 'collection' and 'id', listing
  // documents written by a given method's stub. keys are associated with
  // methods whose stub wrote at least one document, and whose data-done message
  // has not yet been received.
  self._documentsWrittenByStub = {};
  // collection -> IdMap of "server document" object. A "server document" has:
  // - "document": the version of the document according the
  //   server (ie, the snapshot before a stub wrote it, amended by any changes
  //   received from the server)
  //   It is undefined if we think the document does not exist
  // - "writtenByStubs": a set of method IDs whose stubs wrote to the document
  //   whose "data done" messages have not yet been processed
  self._serverDocuments = {};

  // Array of callbacks to be called after the next update of the local
  // cache. Used for:
  //  - Calling methodInvoker.dataVisible and sub ready callbacks after
  //    the relevant data is flushed.
  //  - Invoking the callbacks of "half-finished" methods after reconnect
  //    quiescence. Specifically, methods whose result was received over the old
  //    connection (so we don't re-send it) but whose data had not been made
  //    visible.
  self._afterUpdateCallbacks = [];

  // In two contexts, we buffer all incoming data messages and then process them
  // all at once in a single update:
  //   - During reconnect, we buffer all data messages until all subs that had
  //     been ready before reconnect are ready again, and all methods that are
  //     active have returned their "data done message"; then
  //   - During the execution of a "wait" method, we buffer all data messages
  //     until the wait method gets its "data done" message. (If the wait method
  //     occurs during reconnect, it doesn't get any special handling.)
  // all data messages are processed in one update.
  //
  // The following fields are used for this "quiescence" process.

  // This buffers the messages that aren't being processed yet.
  self._messagesBufferedUntilQuiescence = [];
  // Map from method ID -> true. Methods are removed from this when their
  // "data done" message is received, and we will not quiesce until it is
  // empty.
  self._methodsBlockingQuiescence = {};
  // map from sub ID -> true for subs that were ready (ie, called the sub
  // ready callback) before reconnect but haven't become ready again yet
  self._subsBeingRevived = {}; // map from sub._id -> true
  // if true, the next data update should reset all stores. (set during
  // reconnect.)
  self._resetStores = false;

  // name -> array of updates for (yet to be created) collections
  self._updatesForUnknownStores = {};
  // if we're blocking a migration, the retry func
  self._retryMigrate = null;

  // metadata for subscriptions.  Map from sub ID to object with keys:
  //   - id
  //   - name
  //   - params
  //   - inactive (if true, will be cleaned up if not reused in re-run)
  //   - ready (has the 'ready' message been received?)
  //   - readyCallback (an optional callback to call when ready)
  //   - errorCallback (an optional callback to call if the sub terminates with
  //                    an error)
  self._subscriptions = {};

  // Reactive userId.
  self._userId = null;
  self._userIdDeps = new Deps.Dependency;

  // Block auto-reload while we're waiting for method responses.
  if (Meteor.isClient && Package.reload && !options.reloadWithOutstanding) {
    Package.reload.Reload._onMigrate(function(retry) {
      if (!self._readyToMigrate()) {
        if (self._retryMigrate)
          throw new Error("Two migrations in progress?");
        self._retryMigrate = retry;
        return false;
      } else {
        return [true];
      }
    });
  }

  var onMessage = function(raw_msg) {
    try {
      var msg = parseDDP(raw_msg);
    } catch (e) {
      Meteor._debug("Exception while parsing DDP", e);
      return;
    }

    if (msg === null || !msg.msg) {
      // XXX COMPAT WITH 0.6.6. ignore the old welcome message for back
      // compat.  Remove this 'if' once the server stops sending welcome
      // messages (stream_server.js).
      if (!(msg && msg.server_id))
        Meteor._debug("discarding invalid livedata message", msg);
      return;
    }

    if (msg.msg === 'connected') {
      self._version = self._versionSuggestion;
      self._livedata_connected(msg);
      options.onConnected();
    } else if (msg.msg == 'failed') {
      if (_.contains(self._supportedDDPVersions, msg.version)) {
        self._versionSuggestion = msg.version;
        self._stream.reconnect({
          _force: true
        });
      } else {
        var description =
          "DDP version negotiation failed; server requested version " + msg.version;
        self._stream.disconnect({
          _permanent: true,
          _error: description
        });
        options.onDDPVersionNegotiationFailure(description);
      }
    } else if (msg.msg === 'ping') {
      if (options.respondToPings)
        self._send({
          msg: "pong",
          id: msg.id
        });
      if (self._heartbeat)
        self._heartbeat.pingReceived();
    } else if (msg.msg === 'pong') {
      if (self._heartbeat) {
        self._heartbeat.pongReceived();
      }
    } else if (_.include(['added', 'changed', 'removed', 'ready', 'updated'], msg.msg))
      self._livedata_data(msg);
    else if (msg.msg === 'nosub')
      self._livedata_nosub(msg);
    else if (msg.msg === 'result')
      self._livedata_result(msg);
    else if (msg.msg === 'error')
      self._livedata_error(msg);
    else
      Meteor._debug("discarding unknown livedata message type", msg);
  };

  var onReset = function() {
    // Send a connect message at the beginning of the stream.
    // NOTE: reset is called even on the first connection, so this is
    // the only place we send this message.
    var msg = {
      msg: 'connect'
    };
    if (self._lastSessionId)
      msg.session = self._lastSessionId;
    msg.version = self._versionSuggestion || self._supportedDDPVersions[0];
    self._versionSuggestion = msg.version;
    msg.support = self._supportedDDPVersions;
    self._send(msg);

    // Now, to minimize setup latency, go ahead and blast out all of
    // our pending methods ands subscriptions before we've even taken
    // the necessary RTT to know if we successfully reconnected. (1)
    // They're supposed to be idempotent; (2) even if we did
    // reconnect, we're not sure what messages might have gotten lost
    // (in either direction) since we were disconnected (TCP being
    // sloppy about that.)

    // If the current block of methods all got their results (but didn't all get
    // their data visible), discard the empty block now.
    if (!_.isEmpty(self._outstandingMethodBlocks) &&
      _.isEmpty(self._outstandingMethodBlocks[0].methods)) {
      self._outstandingMethodBlocks.shift();
    }

    // Mark all messages as unsent, they have not yet been sent on this
    // connection.
    _.each(self._methodInvokers, function(m) {
      m.sentMessage = false;
    });

    // If an `onReconnect` handler is set, call it first. Go through
    // some hoops to ensure that methods that are called from within
    // `onReconnect` get executed _before_ ones that were originally
    // outstanding (since `onReconnect` is used to re-establish auth
    // certificates)
    if (self.onReconnect)
      self._callOnReconnectAndSendAppropriateOutstandingMethods();
    else
      self._sendOutstandingMethods();

    // add new subscriptions at the end. this way they take effect after
    // the handlers and we don't see flicker.
    _.each(self._subscriptions, function(sub, id) {
      self._send({
        msg: 'sub',
        id: id,
        name: sub.name,
        params: sub.params
      });
    });
  };

  var onDisconnect = function() {
    if (self._heartbeat) {
      self._heartbeat.stop();
      self._heartbeat = null;
    }
  };
  self._stream.on('message', onMessage);
  self._stream.on('reset', onReset);
  self._stream.on('disconnect', onDisconnect);

};

// A MethodInvoker manages sending a method to the server and calling the user's
// callbacks. On construction, it registers itself in the connection's
// _methodInvokers map; it removes itself once the method is fully finished and
// the callback is invoked. This occurs when it has both received a result,
// and the data written by it is fully visible.
var MethodInvoker = function(options) {
  var self = this;

  // Public (within this file) fields.
  self.methodId = options.methodId;
  self.sentMessage = false;

  self._callback = options.callback;
  self._connection = options.connection;
  self._message = options.message;
  self._onResultReceived = options.onResultReceived || function() {};
  self._wait = options.wait;
  self._methodResult = null;
  self._dataVisible = false;

  // Register with the connection.
  self._connection._methodInvokers[self.methodId] = self;
};
_.extend(MethodInvoker.prototype, {
  // Sends the method message to the server. May be called additional times if
  // we lose the connection and reconnect before receiving a result.
  sendMessage: function() {
    var self = this;
    // This function is called before sending a method (including resending on
    // reconnect). We should only (re)send methods where we don't already have a
    // result!
    if (self.gotResult())
      throw new Error("sendingMethod is called on method with result");

    // If we're re-sending it, it doesn't matter if data was written the first
    // time.
    self._dataVisible = false;

    self.sentMessage = true;

    // If this is a wait method, make all data messages be buffered until it is
    // done.
    if (self._wait)
      self._connection._methodsBlockingQuiescence[self.methodId] = true;

    // Actually send the message.
    self._connection._send(self._message);
  },
  // Invoke the callback, if we have both a result and know that all data has
  // been written to the local cache.
  _maybeInvokeCallback: function() {
    var self = this;
    if (self._methodResult && self._dataVisible) {
      // Call the callback. (This won't throw: the callback was wrapped with
      // bindEnvironment.)
      self._callback(self._methodResult[0], self._methodResult[1]);

      // Forget about this method.
      delete self._connection._methodInvokers[self.methodId];

      // Let the connection know that this method is finished, so it can try to
      // move on to the next block of methods.
      self._connection._outstandingMethodFinished();
    }
  },
  // Call with the result of the method from the server. Only may be called
  // once; once it is called, you should not call sendMessage again.
  // If the user provided an onResultReceived callback, call it immediately.
  // Then invoke the main callback if data is also visible.
  receiveResult: function(err, result) {
    var self = this;
    if (self.gotResult())
      throw new Error("Methods should only receive results once");
    self._methodResult = [err, result];
    self._onResultReceived(err, result);
    self._maybeInvokeCallback();
  },
  // Call this when all data written by the method is visible. This means that
  // the method has returns its "data is done" message *AND* all server
  // documents that are buffered at that time have been written to the local
  // cache. Invokes the main callback if the result has been received.
  dataVisible: function() {
    var self = this;
    self._dataVisible = true;
    self._maybeInvokeCallback();
  },
  // True if receiveResult has been called.
  gotResult: function() {
    var self = this;
    return !!self._methodResult;
  }
});

_.extend(Connection.prototype, {
  // 'name' is the name of the data on the wire that should go in the
  // store. 'wrappedStore' should be an object with methods beginUpdate, update,
  // endUpdate, saveOriginals, retrieveOriginals. see Collection for an example.
  registerStore: function(name, wrappedStore) {
    var self = this;

    if (name in self._stores)
      return false;

    // Wrap the input object in an object which makes any store method not
    // implemented by 'store' into a no-op.
    var store = {};
    _.each(['update', 'beginUpdate', 'endUpdate', 'saveOriginals',
      'retrieveOriginals'
    ], function(method) {
      store[method] = function() {
        return (wrappedStore[method] ? wrappedStore[method].apply(wrappedStore, arguments) : undefined);
      };
    });

    self._stores[name] = store;

    var queued = self._updatesForUnknownStores[name];
    if (queued) {
      store.beginUpdate(queued.length, false);
      _.each(queued, function(msg) {
        store.update(msg);
      });
      store.endUpdate();
      delete self._updatesForUnknownStores[name];
    }

    return true;
  },

  subscribe: function(name /* .. [arguments] .. (callback|callbacks) */ ) {
    var self = this;

    var params = Array.prototype.slice.call(arguments, 1);
    var callbacks = {};
    if (params.length) {
      var lastParam = params[params.length - 1];

      if (typeof lastParam === "function") {
        callbacks.onReady = params.pop();

      } else if (lastParam && (typeof lastParam.onReady === "function" ||
        typeof lastParam.onError === "function")) {
        callbacks = params.pop();
      }
    }

    // Is there an existing sub with the same name and param, run in an
    // invalidated Computation? This will happen if we are rerunning an
    // existing computation.
    //
    // For example, consider a rerun of:
    //
    //     Deps.autorun(function () {
    //       Meteor.subscribe("foo", Session.get("foo"));
    //       Meteor.subscribe("bar", Session.get("bar"));
    //     });
    //
    // If "foo" has changed but "bar" has not, we will match the "bar"
    // subcribe to an existing inactive subscription in order to not
    // unsub and resub the subscription unnecessarily.
    //
    // We only look for one such sub; if there are N apparently-identical subs
    // being invalidated, we will require N matching subscribe calls to keep
    // them all active.
    var existing = _.find(self._subscriptions, function(sub) {
      return sub.inactive && sub.name === name &&
        EJSON.equals(sub.params, params);
    });

    var id;
    if (existing) {
      id = existing.id;
      existing.inactive = false; // reactivate

      if (callbacks.onReady) {
        // If the sub is not already ready, replace any ready callback with the
        // one provided now. (It's not really clear what users would expect for
        // an onReady callback inside an autorun; the semantics we provide is
        // that at the time the sub first becomes ready, we call the last
        // onReady callback provided, if any.)
        if (!existing.ready)
          existing.readyCallback = callbacks.onReady;
      }
      if (callbacks.onError) {
        // Replace existing callback if any, so that errors aren't
        // double-reported.
        existing.errorCallback = callbacks.onError;
      }
    } else {
      // New sub! Generate an id, save it locally, and send message.
      id = Random.id();
      self._subscriptions[id] = {
        id: id,
        name: name,
        params: EJSON.clone(params),
        inactive: false,
        ready: false,
        readyDeps: new Deps.Dependency,
        readyCallback: callbacks.onReady,
        errorCallback: callbacks.onError,
        connection: self,
        remove: function() {
          delete this.connection._subscriptions[this.id];
          this.ready && this.readyDeps.changed();
        },
        stop: function() {
          this.connection._send({
            msg: 'unsub',
            id: id
          });
          this.remove();
        }
      };
      self._send({
        msg: 'sub',
        id: id,
        name: name,
        params: params
      });
    }

    // return a handle to the application.
    var handle = {
      stop: function() {
        if (!_.has(self._subscriptions, id))
          return;

        self._subscriptions[id].stop();
      },
      ready: function() {
        // return false if we've unsubscribed.
        if (!_.has(self._subscriptions, id))
          return false;
        var record = self._subscriptions[id];
        record.readyDeps.depend();
        return record.ready;
      }
    };

    if (Deps.active) {
      // We're in a reactive computation, so we'd like to unsubscribe when the
      // computation is invalidated... but not if the rerun just re-subscribes
      // to the same subscription!  When a rerun happens, we use onInvalidate
      // as a change to mark the subscription "inactive" so that it can
      // be reused from the rerun.  If it isn't reused, it's killed from
      // an afterFlush.
      Deps.onInvalidate(function(c) {
        if (_.has(self._subscriptions, id))
          self._subscriptions[id].inactive = true;

        Deps.afterFlush(function() {
          if (_.has(self._subscriptions, id) &&
            self._subscriptions[id].inactive)
            handle.stop();
        });
      });
    }

    return handle;
  },

  // options:
  // - onLateError {Function(error)} called if an error was received after the ready event.
  //     (errors received before ready cause an error to be thrown)
  _subscribeAndWait: function(name, args, options) {
    var self = this;
    var f = new Future();
    var ready = false;
    var handle;
    args = args || [];
    args.push({
      onReady: function() {
        ready = true;
        f['return']();
      },
      onError: function(e) {
        if (!ready)
          f['throw'](e);
        else
          options && options.onLateError && options.onLateError(e);
      }
    });

    handle = self.subscribe.apply(self, [name].concat(args));
    f.wait();
    return handle;
  },

  methods: function(methods) {
    var self = this;
    _.each(methods, function(func, name) {
      if (self._methodHandlers[name])
        throw new Error("A method named '" + name + "' is already defined");
      self._methodHandlers[name] = func;
    });
  },

  call: function(name /* .. [arguments] .. callback */ ) {
    // if it's a function, the last argument is the result callback,
    // not a parameter to the remote method.
    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length && typeof args[args.length - 1] === "function")
      var callback = args.pop();
    return this.apply(name, args, callback);
  },

  // @param options {Optional Object}
  //   wait: Boolean - Should we wait to call this until all current methods
  //                   are fully finished, and block subsequent method calls
  //                   until this method is fully finished?
  //                   (does not affect methods called from within this method)
  //   onResultReceived: Function - a callback to call as soon as the method
  //                                result is received. the data written by
  //                                the method may not yet be in the cache!
  //   returnStubValue: Boolean - If true then in cases where we would have
  //                              otherwise discarded the stub's return value
  //                              and returned undefined, instead we go ahead
  //                              and return it.  Specifically, this is any
  //                              time other than when (a) we are already
  //                              inside a stub or (b) we are in Node and no
  //                              callback was provided.  Currently we require
  //                              this flag to be explicitly passed to reduce
  //                              the likelihood that stub return values will
  //                              be confused with server return values; we
  //                              may improve this in future.
  // @param callback {Optional Function}
  apply: function(name, args, options, callback) {
    var self = this;

    // We were passed 3 arguments. They may be either (name, args, options)
    // or (name, args, callback)
    if (!callback && typeof options === 'function') {
      callback = options;
      options = {};
    }
    options = options || {};

    if (callback) {
      // XXX would it be better form to do the binding in stream.on,
      // or caller, instead of here?
      // XXX improve error message (and how we report it)
      callback = Meteor.bindEnvironment(
        callback,
        "delivering result of invoking '" + name + "'"
      );
    }

    // Keep our args safe from mutation (eg if we don't send the message for a
    // while because of a wait method).
    args = EJSON.clone(args);

    // Lazily allocate method ID once we know that it'll be needed.
    var methodId = (function() {
      var id;
      return function() {
        if (id === undefined)
          id = '' + (self._nextMethodId++);
        return id;
      };
    })();

    var enclosing = DDP._CurrentInvocation.get();
    var alreadyInSimulation = enclosing && enclosing.isSimulation;

    // Lazily generate a randomSeed, only if it is requested by the stub.
    // The random streams only have utility if they're used on both the client
    // and the server; if the client doesn't generate any 'random' values
    // then we don't expect the server to generate any either.
    // Less commonly, the server may perform different actions from the client,
    // and may in fact generate values where the client did not, but we don't
    // have any client-side values to match, so even here we may as well just
    // use a random seed on the server.  In that case, we don't pass the
    // randomSeed to save bandwidth, and we don't even generate it to save a
    // bit of CPU and to avoid consuming entropy.
    var randomSeed = null;
    var randomSeedGenerator = function() {
      if (randomSeed === null) {
        randomSeed = makeRpcSeed(enclosing, name);
      }
      return randomSeed;
    };

    // Run the stub, if we have one. The stub is supposed to make some
    // temporary writes to the database to give the user a smooth experience
    // until the actual result of executing the method comes back from the
    // server (whereupon the temporary writes to the database will be reversed
    // during the beginUpdate/endUpdate process.)
    //
    // Normally, we ignore the return value of the stub (even if it is an
    // exception), in favor of the real return value from the server. The
    // exception is if the *caller* is a stub. In that case, we're not going
    // to do a RPC, so we use the return value of the stub as our return
    // value.

    var stub = self._methodHandlers[name];
    if (stub) {
      var setUserId = function(userId) {
        self.setUserId(userId);
      };

      var invocation = new MethodInvocation({
        isSimulation: true,
        userId: self.userId(),
        setUserId: setUserId,
        randomSeed: function() {
          return randomSeedGenerator();
        }
      });

      if (!alreadyInSimulation)
        self._saveOriginals();

      try {
        // Note that unlike in the corresponding server code, we never audit
        // that stubs check() their arguments.
        var stubReturnValue = DDP._CurrentInvocation.withValue(invocation, function() {
            return stub.apply(invocation, EJSON.clone(args));
        });
      } catch (e) {
        var exception = e;
      }

      if (!alreadyInSimulation)
        self._retrieveAndStoreOriginals(methodId());
    }

    // If we're in a simulation, stop and return the result we have,
    // rather than going on to do an RPC. If there was no stub,
    // we'll end up returning undefined.
    if (alreadyInSimulation) {
      if (callback) {
        callback(exception, stubReturnValue);
        return undefined;
      }
      if (exception)
        throw exception;
      return stubReturnValue;
    }

    // If an exception occurred in a stub, and we're ignoring it
    // because we're doing an RPC and want to use what the server
    // returns instead, log it so the developer knows.
    //
    // Tests can set the 'expected' flag on an exception so it won't
    // go to log.
    if (exception && !exception.expected) {
      Meteor._debug("Exception while simulating the effect of invoking '" +
        name + "'", exception, exception.stack);
    }


    // At this point we're definitely doing an RPC, and we're going to
    // return the value of the RPC to the caller.

    // If the caller didn't give a callback, decide what to do.
    if (!callback) {
      if (Meteor.isClient) {
        // On the client, we don't have fibers, so we can't block. The
        // only thing we can do is to return undefined and discard the
        // result of the RPC. If an error occurred then print the error
        // to the console.
        callback = function(err) {
          err && Meteor._debug("Error invoking Method '" + name + "':",
            err.message);
        };
      } else {
        // On the server, make the function synchronous. Throw on
        // errors, return on success.
        var future = new Future;
        callback = future.resolver();
      }
    }
    // Send the RPC. Note that on the client, it is important that the
    // stub have finished before we send the RPC, so that we know we have
    // a complete list of which local documents the stub wrote.
    var message = {
      msg: 'method',
      method: name,
      params: args,
      id: methodId()
    };

    // Send the randomSeed only if we used it
    if (randomSeed !== null) {
      message.randomSeed = randomSeed;
    }

    var methodInvoker = new MethodInvoker({
      methodId: methodId(),
      callback: callback,
      connection: self,
      onResultReceived: options.onResultReceived,
      wait: !!options.wait,
      message: message
    });

    if (options.wait) {
      // It's a wait method! Wait methods go in their own block.
      self._outstandingMethodBlocks.push({
        wait: true,
        methods: [methodInvoker]
      });
    } else {
      // Not a wait method. Start a new block if the previous block was a wait
      // block, and add it to the last block of methods.
      if (_.isEmpty(self._outstandingMethodBlocks) ||
        _.last(self._outstandingMethodBlocks).wait)
        self._outstandingMethodBlocks.push({
          wait: false,
          methods: []
        });
      _.last(self._outstandingMethodBlocks).methods.push(methodInvoker);
    }

    // If we added it to the first block, send it out now.
    if (self._outstandingMethodBlocks.length === 1)
      methodInvoker.sendMessage();

    // If we're using the default callback on the server,
    // block waiting for the result.
    if (future) {
      return future.wait();
    }
    return options.returnStubValue ? stubReturnValue : undefined;
  },

  // Before calling a method stub, prepare all stores to track changes and allow
  // _retrieveAndStoreOriginals to get the original versions of changed
  // documents.
  _saveOriginals: function() {
    var self = this;
    _.each(self._stores, function(s) {
      s.saveOriginals();
    });
  },
  // Retrieves the original versions of all documents modified by the stub for
  // method 'methodId' from all stores and saves them to _serverDocuments (keyed
  // by document) and _documentsWrittenByStub (keyed by method ID).
  _retrieveAndStoreOriginals: function(methodId) {
    var self = this;
    if (self._documentsWrittenByStub[methodId])
      throw new Error("Duplicate methodId in _retrieveAndStoreOriginals");

    var docsWritten = [];
    _.each(self._stores, function(s, collection) {
      var originals = s.retrieveOriginals();
      // not all stores define retrieveOriginals
      if (!originals)
        return;
      originals.forEach(function(doc, id) {
        docsWritten.push({
          collection: collection,
          id: id
        });
        if (!_.has(self._serverDocuments, collection))
          self._serverDocuments[collection] = new LocalCollection._IdMap;
        var serverDoc = self._serverDocuments[collection].setDefault(id, {});
        if (serverDoc.writtenByStubs) {
          // We're not the first stub to write this doc. Just add our method ID
          // to the record.
          serverDoc.writtenByStubs[methodId] = true;
        } else {
          // First stub! Save the original value and our method ID.
          serverDoc.document = doc;
          serverDoc.flushCallbacks = [];
          serverDoc.writtenByStubs = {};
          serverDoc.writtenByStubs[methodId] = true;
        }
      });
    });
    if (!_.isEmpty(docsWritten)) {
      self._documentsWrittenByStub[methodId] = docsWritten;
    }
  },

  // This is very much a private function we use to make the tests
  // take up fewer server resources after they complete.
  _unsubscribeAll: function() {
    var self = this;
    _.each(_.clone(self._subscriptions), function(sub, id) {
      // Avoid killing the autoupdate subscription so that developers
      // still get hot code pushes when writing tests.
      //
      // XXX it's a hack to encode knowledge about autoupdate here,
      // but it doesn't seem worth it yet to have a special API for
      // subscriptions to preserve after unit tests.
      if (sub.name !== 'meteor_autoupdate_clientVersions') {
        self._subscriptions[id].stop();
      }
    });
  },

  // Sends the DDP stringification of the given message object
  _send: function(obj) {
    var self = this;
    self._stream.send(stringifyDDP(obj));
  },

  // We detected via DDP-level heartbeats that we've lost the
  // connection.  Unlike `disconnect` or `close`, a lost connection
  // will be automatically retried.
  _lostConnection: function() {
    var self = this;
    self._stream._lostConnection();
  },

  status: function( /*passthrough args*/ ) {
    var self = this;
    return self._stream.status.apply(self._stream, arguments);
  },

  reconnect: function( /*passthrough args*/ ) {
    var self = this;
    return self._stream.reconnect.apply(self._stream, arguments);
  },

  disconnect: function( /*passthrough args*/ ) {
    var self = this;
    return self._stream.disconnect.apply(self._stream, arguments);
  },

  close: function() {
    var self = this;
    return self._stream.disconnect({
      _permanent: true
    });
  },

  ///
  /// Reactive user system
  ///
  userId: function() {
    var self = this;
    if (self._userIdDeps)
      self._userIdDeps.depend();
    return self._userId;
  },

  setUserId: function(userId) {
    var self = this;
    // Avoid invalidating dependents if setUserId is called with current value.
    if (self._userId === userId)
      return;
    self._userId = userId;
    if (self._userIdDeps)
      self._userIdDeps.changed();
  },

  // Returns true if we are in a state after reconnect of waiting for subs to be
  // revived or early methods to finish their data, or we are waiting for a
  // "wait" method to finish.
  _waitingForQuiescence: function() {
    var self = this;
    return (!_.isEmpty(self._subsBeingRevived) ||
      !_.isEmpty(self._methodsBlockingQuiescence));
  },

  // Returns true if any method whose message has been sent to the server has
  // not yet invoked its user callback.
  _anyMethodsAreOutstanding: function() {
    var self = this;
    return _.any(_.pluck(self._methodInvokers, 'sentMessage'));
  },

  _livedata_connected: function(msg) {
    var self = this;

    if (self._version !== 'pre1' && self._heartbeatInterval !== 0) {
      self._heartbeat = new Heartbeat({
        heartbeatInterval: self._heartbeatInterval,
        heartbeatTimeout: self._heartbeatTimeout,
        onTimeout: function() {
          if (Meteor.isClient && !self._stream._isStub) {
            // only print on the client. this message is useful on the
            // browser console to see that we've lost connection. on the
            // server (eg when doing server-to-server DDP), it gets
            // kinda annoying. also this matches the behavior with
            // sockjs timeouts.
            Meteor._debug("Connection timeout. No DDP heartbeat received.");
          }
          self._lostConnection();
        },
        sendPing: function() {
          self._send({
            msg: 'ping'
          });
        }
      });
      self._heartbeat.start();
    }

    // If this is a reconnect, we'll have to reset all stores.
    if (self._lastSessionId)
      self._resetStores = true;

    if (typeof(msg.session) === "string") {
      var reconnectedToPreviousSession = (self._lastSessionId === msg.session);
      self._lastSessionId = msg.session;
    }

    if (reconnectedToPreviousSession) {
      // Successful reconnection -- pick up where we left off.  Note that right
      // now, this never happens: the server never connects us to a previous
      // session, because DDP doesn't provide enough data for the server to know
      // what messages the client has processed. We need to improve DDP to make
      // this possible, at which point we'll probably need more code here.
      return;
    }

    // Server doesn't have our data any more. Re-sync a new session.

    // Forget about messages we were buffering for unknown collections. They'll
    // be resent if still relevant.
    self._updatesForUnknownStores = {};

    if (self._resetStores) {
      // Forget about the effects of stubs. We'll be resetting all collections
      // anyway.
      self._documentsWrittenByStub = {};
      self._serverDocuments = {};
    }

    // Clear _afterUpdateCallbacks.
    self._afterUpdateCallbacks = [];

    // Mark all named subscriptions which are ready (ie, we already called the
    // ready callback) as needing to be revived.
    // XXX We should also block reconnect quiescence until unnamed subscriptions
    //     (eg, autopublish) are done re-publishing to avoid flicker!
    self._subsBeingRevived = {};
    _.each(self._subscriptions, function(sub, id) {
      if (sub.ready)
        self._subsBeingRevived[id] = true;
    });

    // Arrange for "half-finished" methods to have their callbacks run, and
    // track methods that were sent on this connection so that we don't
    // quiesce until they are all done.
    //
    // Start by clearing _methodsBlockingQuiescence: methods sent before
    // reconnect don't matter, and any "wait" methods sent on the new connection
    // that we drop here will be restored by the loop below.
    self._methodsBlockingQuiescence = {};
    if (self._resetStores) {
      _.each(self._methodInvokers, function(invoker) {
        if (invoker.gotResult()) {
          // This method already got its result, but it didn't call its callback
          // because its data didn't become visible. We did not resend the
          // method RPC. We'll call its callback when we get a full quiesce,
          // since that's as close as we'll get to "data must be visible".
          self._afterUpdateCallbacks.push(_.bind(invoker.dataVisible, invoker));
        } else if (invoker.sentMessage) {
          // This method has been sent on this connection (maybe as a resend
          // from the last connection, maybe from onReconnect, maybe just very
          // quickly before processing the connected message).
          //
          // We don't need to do anything special to ensure its callbacks get
          // called, but we'll count it as a method which is preventing
          // reconnect quiescence. (eg, it might be a login method that was run
          // from onReconnect, and we don't want to see flicker by seeing a
          // logged-out state.)
          self._methodsBlockingQuiescence[invoker.methodId] = true;
        }
      });
    }

    self._messagesBufferedUntilQuiescence = [];

    // If we're not waiting on any methods or subs, we can reset the stores and
    // call the callbacks immediately.
    if (!self._waitingForQuiescence()) {
      if (self._resetStores) {
        _.each(self._stores, function(s) {
          s.beginUpdate(0, true);
          s.endUpdate();
        });
        self._resetStores = false;
      }
      self._runAfterUpdateCallbacks();
    }
  },


  _processOneDataMessage: function(msg, updates) {
    var self = this;
    // Using underscore here so as not to need to capitalize.
    self['_process_' + msg.msg](msg, updates);
  },


  _livedata_data: function(msg) {
    var self = this;

    // collection name -> array of messages
    var updates = {};

    if (self._waitingForQuiescence()) {
      self._messagesBufferedUntilQuiescence.push(msg);

      if (msg.msg === "nosub")
        delete self._subsBeingRevived[msg.id];

      _.each(msg.subs || [], function(subId) {
        delete self._subsBeingRevived[subId];
      });
      _.each(msg.methods || [], function(methodId) {
        delete self._methodsBlockingQuiescence[methodId];
      });

      if (self._waitingForQuiescence())
        return;

      // No methods or subs are blocking quiescence!
      // We'll now process and all of our buffered messages, reset all stores,
      // and apply them all at once.
      _.each(self._messagesBufferedUntilQuiescence, function(bufferedMsg) {
        self._processOneDataMessage(bufferedMsg, updates);
      });
      self._messagesBufferedUntilQuiescence = [];
    } else {
      self._processOneDataMessage(msg, updates);
    }

    if (self._resetStores || !_.isEmpty(updates)) {
      // Begin a transactional update of each store.
      _.each(self._stores, function(s, storeName) {
        s.beginUpdate(_.has(updates, storeName) ? updates[storeName].length : 0,
          self._resetStores);
      });
      self._resetStores = false;

      _.each(updates, function(updateMessages, storeName) {
        var store = self._stores[storeName];
        if (store) {
          _.each(updateMessages, function(updateMessage) {
            store.update(updateMessage);
          });
        } else {
          // Nobody's listening for this data. Queue it up until
          // someone wants it.
          // XXX memory use will grow without bound if you forget to
          // create a collection or just don't care about it... going
          // to have to do something about that.
          if (!_.has(self._updatesForUnknownStores, storeName))
            self._updatesForUnknownStores[storeName] = [];
          Array.prototype.push.apply(self._updatesForUnknownStores[storeName],
            updateMessages);
        }
      });

      // End update transaction.
      _.each(self._stores, function(s) {
        s.endUpdate();
      });
    }

    self._runAfterUpdateCallbacks();
  },

  // Call any callbacks deferred with _runWhenAllServerDocsAreFlushed whose
  // relevant docs have been flushed, as well as dataVisible callbacks at
  // reconnect-quiescence time.
  _runAfterUpdateCallbacks: function() {
    var self = this;
    var callbacks = self._afterUpdateCallbacks;
    self._afterUpdateCallbacks = [];
    _.each(callbacks, function(c) {
      c();
    });
  },

  _pushUpdate: function(updates, collection, msg) {
    var self = this;
    if (!_.has(updates, collection)) {
      updates[collection] = [];
    }
    updates[collection].push(msg);
  },

  _getServerDoc: function(collection, id) {
    var self = this;
    if (!_.has(self._serverDocuments, collection))
      return null;
    var serverDocsForCollection = self._serverDocuments[collection];
    return serverDocsForCollection.get(id) || null;
  },

  _process_added: function(msg, updates) {
    var self = this;
    var id = LocalCollection._idParse(msg.id);
    var serverDoc = self._getServerDoc(msg.collection, id);
    if (serverDoc) {
      // Some outstanding stub wrote here.
      if (serverDoc.document !== undefined)
        throw new Error("Server sent add for existing id: " + msg.id);
      serverDoc.document = msg.fields || {};
      serverDoc.document._id = id;
    } else {
      self._pushUpdate(updates, msg.collection, msg);
    }
  },

  _process_changed: function(msg, updates) {
    var self = this;
    var serverDoc = self._getServerDoc(
      msg.collection, LocalCollection._idParse(msg.id));
    if (serverDoc) {
      if (serverDoc.document === undefined)
        throw new Error("Server sent changed for nonexisting id: " + msg.id);
      LocalCollection._applyChanges(serverDoc.document, msg.fields);
    } else {
      self._pushUpdate(updates, msg.collection, msg);
    }
  },

  _process_removed: function(msg, updates) {
    var self = this;
    var serverDoc = self._getServerDoc(
      msg.collection, LocalCollection._idParse(msg.id));
    if (serverDoc) {
      // Some outstanding stub wrote here.
      if (serverDoc.document === undefined)
        throw new Error("Server sent removed for nonexisting id:" + msg.id);
      serverDoc.document = undefined;
    } else {
      self._pushUpdate(updates, msg.collection, {
        msg: 'removed',
        collection: msg.collection,
        id: msg.id
      });
    }
  },

  _process_updated: function(msg, updates) {
    var self = this;
    // Process "method done" messages.
    _.each(msg.methods, function(methodId) {
      _.each(self._documentsWrittenByStub[methodId], function(written) {
        var serverDoc = self._getServerDoc(written.collection, written.id);
        if (!serverDoc)
          throw new Error("Lost serverDoc for " + JSON.stringify(written));
        if (!serverDoc.writtenByStubs[methodId])
          throw new Error("Doc " + JSON.stringify(written) +
            " not written by  method " + methodId);
        delete serverDoc.writtenByStubs[methodId];
        if (_.isEmpty(serverDoc.writtenByStubs)) {
          // All methods whose stubs wrote this method have completed! We can
          // now copy the saved document to the database (reverting the stub's
          // change if the server did not write to this object, or applying the
          // server's writes if it did).

          // This is a fake ddp 'replace' message.  It's just for talking
          // between livedata connections and minimongo.  (We have to stringify
          // the ID because it's supposed to look like a wire message.)
          self._pushUpdate(updates, written.collection, {
            msg: 'replace',
            id: LocalCollection._idStringify(written.id),
            replace: serverDoc.document
          });
          // Call all flush callbacks.
          _.each(serverDoc.flushCallbacks, function(c) {
            c();
          });

          // Delete this completed serverDocument. Don't bother to GC empty
          // IdMaps inside self._serverDocuments, since there probably aren't
          // many collections and they'll be written repeatedly.
          self._serverDocuments[written.collection].remove(written.id);
        }
      });
      delete self._documentsWrittenByStub[methodId];

      // We want to call the data-written callback, but we can't do so until all
      // currently buffered messages are flushed.
      var callbackInvoker = self._methodInvokers[methodId];
      if (!callbackInvoker)
        throw new Error("No callback invoker for method " + methodId);
      self._runWhenAllServerDocsAreFlushed(
        _.bind(callbackInvoker.dataVisible, callbackInvoker));
    });
  },

  _process_ready: function(msg, updates) {
    var self = this;
    // Process "sub ready" messages. "sub ready" messages don't take effect
    // until all current server documents have been flushed to the local
    // database. We can use a write fence to implement this.
    _.each(msg.subs, function(subId) {
      self._runWhenAllServerDocsAreFlushed(function() {
        var subRecord = self._subscriptions[subId];
        // Did we already unsubscribe?
        if (!subRecord)
          return;
        // Did we already receive a ready message? (Oops!)
        if (subRecord.ready)
          return;
        subRecord.readyCallback && subRecord.readyCallback();
        subRecord.ready = true;
        subRecord.readyDeps.changed();
      });
    });
  },

  // Ensures that "f" will be called after all documents currently in
  // _serverDocuments have been written to the local cache. f will not be called
  // if the connection is lost before then!
  _runWhenAllServerDocsAreFlushed: function(f) {
    var self = this;
    var runFAfterUpdates = function() {
      self._afterUpdateCallbacks.push(f);
    };
    var unflushedServerDocCount = 0;
    var onServerDocFlush = function() {
      --unflushedServerDocCount;
      if (unflushedServerDocCount === 0) {
        // This was the last doc to flush! Arrange to run f after the updates
        // have been applied.
        runFAfterUpdates();
      }
    };
    _.each(self._serverDocuments, function(collectionDocs) {
      collectionDocs.forEach(function(serverDoc) {
        var writtenByStubForAMethodWithSentMessage = _.any(
          serverDoc.writtenByStubs, function(dummy, methodId) {
            var invoker = self._methodInvokers[methodId];
            return invoker && invoker.sentMessage;
          });
        if (writtenByStubForAMethodWithSentMessage) {
          ++unflushedServerDocCount;
          serverDoc.flushCallbacks.push(onServerDocFlush);
        }
      });
    });
    if (unflushedServerDocCount === 0) {
      // There aren't any buffered docs --- we can call f as soon as the current
      // round of updates is applied!
      runFAfterUpdates();
    }
  },

  _livedata_nosub: function(msg) {
    var self = this;

    // First pass it through _livedata_data, which only uses it to help get
    // towards quiescence.
    self._livedata_data(msg);

    // Do the rest of our processing immediately, with no
    // buffering-until-quiescence.

    // we weren't subbed anyway, or we initiated the unsub.
    if (!_.has(self._subscriptions, msg.id))
      return;
    var errorCallback = self._subscriptions[msg.id].errorCallback;
    self._subscriptions[msg.id].remove();
    if (errorCallback && msg.error) {
      errorCallback(new Meteor.Error(
        msg.error.error, msg.error.reason, msg.error.details));
    }
  },

  _process_nosub: function() {
    // This is called as part of the "buffer until quiescence" process, but
    // nosub's effect is always immediate. It only goes in the buffer at all
    // because it's possible for a nosub to be the thing that triggers
    // quiescence, if we were waiting for a sub to be revived and it dies
    // instead.
  },

  _livedata_result: function(msg) {
    // id, result or error. error has error (code), reason, details

    var self = this;

    // find the outstanding request
    // should be O(1) in nearly all realistic use cases
    if (_.isEmpty(self._outstandingMethodBlocks)) {
      Meteor._debug("Received method result but no methods outstanding");
      return;
    }
    var currentMethodBlock = self._outstandingMethodBlocks[0].methods;
    var m;
    for (var i = 0; i < currentMethodBlock.length; i++) {
      m = currentMethodBlock[i];
      if (m.methodId === msg.id)
        break;
    }

    if (!m) {
      Meteor._debug("Can't match method response to original method call", msg);
      return;
    }

    // Remove from current method block. This may leave the block empty, but we
    // don't move on to the next block until the callback has been delivered, in
    // _outstandingMethodFinished.
    currentMethodBlock.splice(i, 1);

    if (_.has(msg, 'error')) {
      m.receiveResult(new Meteor.Error(
        msg.error.error, msg.error.reason,
        msg.error.details));
    } else {
      // msg.result may be undefined if the method didn't return a
      // value
      m.receiveResult(undefined, msg.result);
    }
  },

  // Called by MethodInvoker after a method's callback is invoked.  If this was
  // the last outstanding method in the current block, runs the next block. If
  // there are no more methods, consider accepting a hot code push.
  _outstandingMethodFinished: function() {
    var self = this;
    if (self._anyMethodsAreOutstanding())
      return;

    // No methods are outstanding. This should mean that the first block of
    // methods is empty. (Or it might not exist, if this was a method that
    // half-finished before disconnect/reconnect.)
    if (!_.isEmpty(self._outstandingMethodBlocks)) {
      var firstBlock = self._outstandingMethodBlocks.shift();
      if (!_.isEmpty(firstBlock.methods))
        throw new Error("No methods outstanding but nonempty block: " +
          JSON.stringify(firstBlock));

      // Send the outstanding methods now in the first block.
      if (!_.isEmpty(self._outstandingMethodBlocks))
        self._sendOutstandingMethods();
    }

    // Maybe accept a hot code push.
    self._maybeMigrate();
  },

  // Sends messages for all the methods in the first block in
  // _outstandingMethodBlocks.
  _sendOutstandingMethods: function() {
    var self = this;
    if (_.isEmpty(self._outstandingMethodBlocks))
      return;
    _.each(self._outstandingMethodBlocks[0].methods, function(m) {
      m.sendMessage();
    });
  },

  _livedata_error: function(msg) {
    Meteor._debug("Received error from server: ", msg.reason);
    if (msg.offendingMessage)
      Meteor._debug("For: ", msg.offendingMessage);
  },

  _callOnReconnectAndSendAppropriateOutstandingMethods: function() {
    var self = this;
    var oldOutstandingMethodBlocks = self._outstandingMethodBlocks;
    self._outstandingMethodBlocks = [];

    self.onReconnect();

    if (_.isEmpty(oldOutstandingMethodBlocks))
      return;

    // We have at least one block worth of old outstanding methods to try
    // again. First: did onReconnect actually send anything? If not, we just
    // restore all outstanding methods and run the first block.
    if (_.isEmpty(self._outstandingMethodBlocks)) {
      self._outstandingMethodBlocks = oldOutstandingMethodBlocks;
      self._sendOutstandingMethods();
      return;
    }

    // OK, there are blocks on both sides. Special case: merge the last block of
    // the reconnect methods with the first block of the original methods, if
    // neither of them are "wait" blocks.
    if (!_.last(self._outstandingMethodBlocks).wait &&
      !oldOutstandingMethodBlocks[0].wait) {
      _.each(oldOutstandingMethodBlocks[0].methods, function(m) {
        _.last(self._outstandingMethodBlocks).methods.push(m);

        // If this "last block" is also the first block, send the message.
        if (self._outstandingMethodBlocks.length === 1)
          m.sendMessage();
      });

      oldOutstandingMethodBlocks.shift();
    }

    // Now add the rest of the original blocks on.
    _.each(oldOutstandingMethodBlocks, function(block) {
      self._outstandingMethodBlocks.push(block);
    });
  },

  // We can accept a hot code push if there are no methods in flight.
  _readyToMigrate: function() {
    var self = this;
    return _.isEmpty(self._methodInvokers);
  },

  // If we were blocking a migration, see if it's now possible to continue.
  // Call whenever the set of outstanding/blocked methods shrinks.
  _maybeMigrate: function() {
    var self = this;
    if (self._retryMigrate && self._readyToMigrate()) {
      self._retryMigrate();
      self._retryMigrate = null;
    }
  }
});


// @param url {String} URL to Meteor app,
//     e.g.:
//     "subdomain.meteor.com",
//     "http://subdomain.meteor.com",
//     "/",
//     "ddp+sockjs://ddp--****-foo.meteor.com/sockjs"
//
DDP.connect = function(url, options) {
  var ret = new Connection(url, options);
  allConnections.push(ret); // hack. see below.
  return ret;
};

// Hack for `spiderable` package: a way to see if the page is done
// loading all the data it needs.
//
allConnections = [];
DDP._allSubscriptionsReady = function() {
  return _.all(allConnections, function(conn) {
    return _.all(conn._subscriptions, function(sub) {
      return sub.ready;
    });
  });
};

// XXX from Underscore.String (http://epeli.github.com/underscore.string/)
var startsWith = function(str, starts) {
  return str.length >= starts.length &&
    str.substring(0, starts.length) === starts;
};
var endsWith = function(str, ends) {
  return str.length >= ends.length &&
    str.substring(str.length - ends.length) === ends;
};



_.extend(LivedataTest.ClientStream.prototype, {

  // Register for callbacks.
  on: function(name, callback) {
    var self = this;

    if (name !== 'message' && name !== 'reset' && name !== 'disconnect')
      throw new Error("unknown event type: " + name);

    if (!self.eventCallbacks[name])
      self.eventCallbacks[name] = [];
    self.eventCallbacks[name].push(callback);
  },


  _initCommon: function() {
    var self = this;
    //// Constants

    // how long to wait until we declare the connection attempt
    // failed.
    self.CONNECT_TIMEOUT = 10000;

    self.eventCallbacks = {}; // name -> [callback]

    self._forcedToDisconnect = false;

    //// Reactive status
    self.currentStatus = {
      status: "connecting",
      connected: false,
      retryCount: 0
    };


    self.statusListeners = typeof Deps !== 'undefined' && new Deps.Dependency;
    self.statusChanged = function() {
      if (self.statusListeners)
        self.statusListeners.changed();
    };

    //// Retry logic
    self._retry = new Retry;
    self.connectionTimer = null;

  },

  // Trigger a reconnect.
  reconnect: function(options) {
    var self = this;
    options = options || {};

    if (options.url) {
      self._changeUrl(options.url);
    }

    if (options._sockjsOptions) {
      self.options._sockjsOptions = options._sockjsOptions;
    }

    if (self.currentStatus.connected) {
      if (options._force || options.url) {
        // force reconnect.
        self._lostConnection();
      } // else, noop.
      return;
    }

    // if we're mid-connection, stop it.
    if (self.currentStatus.status === "connecting") {
      self._lostConnection();
    }

    self._retry.clear();
    self.currentStatus.retryCount -= 1; // don't count manual retries
    self._retryNow();
  },

  disconnect: function(options) {
    var self = this;
    options = options || {};

    // Failed is permanent. If we're failed, don't let people go back
    // online by calling 'disconnect' then 'reconnect'.
    if (self._forcedToDisconnect)
      return;

    // If _permanent is set, permanently disconnect a stream. Once a stream
    // is forced to disconnect, it can never reconnect. This is for
    // error cases such as ddp version mismatch, where trying again
    // won't fix the problem.
    if (options._permanent) {
      self._forcedToDisconnect = true;
    }

    self._cleanup();
    self._retry.clear();

    self.currentStatus = {
      status: (options._permanent ? "failed" : "offline"),
      connected: false,
      retryCount: 0
    };

    if (options._permanent && options._error)
      self.currentStatus.reason = options._error;

    self.statusChanged();
  },

  _lostConnection: function() {
    var self = this;

    self._cleanup();
    self._retryLater(); // sets status. no need to do it here.
  },

  // fired when we detect that we've gone online. try to reconnect
  // immediately.
  _online: function() {
    // if we've requested to be offline by disconnecting, don't reconnect.
    if (this.currentStatus.status != "offline")
      this.reconnect();
  },

  _retryLater: function() {
    var self = this;

    var timeout = 0;
    if (self.options.retry) {
      timeout = self._retry.retryLater(
        self.currentStatus.retryCount,
        _.bind(self._retryNow, self)
      );
    }

    self.currentStatus.status = "waiting";
    self.currentStatus.connected = false;
    self.currentStatus.retryTime = (new Date()).getTime() + timeout;
    self.statusChanged();
  },

  _retryNow: function() {
    var self = this;

    if (self._forcedToDisconnect)
      return;

    self.currentStatus.retryCount += 1;
    self.currentStatus.status = "connecting";
    self.currentStatus.connected = false;
    delete self.currentStatus.retryTime;
    self.statusChanged();

    self._launchConnection();
  },


  // Get current status. Reactive.
  status: function() {
    var self = this;
    if (self.statusListeners)
      self.statusListeners.depend();
    return self.currentStatus;
  }
});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                //
// packages/livedata/random_stream.js                                                                             //
//                                                                                                                //
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//
// RandomStream allows for generation of pseudo-random values, from a seed.                                       // 1
//                                                                                                                // 2
// We use this for consistent 'random' numbers across the client and server.                                      // 3
// We want to generate probably-unique IDs on the client, and we ideally want                                     // 4
// the server to generate the same IDs when it executes the method.                                               // 5
//                                                                                                                // 6
// For generated values to be the same, we must seed ourselves the same way,                                      // 7
// and we must keep track of the current state of our pseudo-random generators.                                   // 8
// We call this state the scope. By default, we use the current DDP method                                        // 9
// invocation as our scope.  DDP now allows the client to specify a randomSeed.                                   // 10
// If a randomSeed is provided it will be used to seed our random sequences.                                      // 11
// In this way, client and server method calls will generate the same values.                                     // 12
//                                                                                                                // 13
// We expose multiple named streams; each stream is independent                                                   // 14
// and is seeded differently (but predictably from the name).                                                     // 15
// By using multiple streams, we support reordering of requests,                                                  // 16
// as long as they occur on different streams.                                                                    // 17
//                                                                                                                // 18
// @param options {Optional Object}                                                                               // 19
//   seed: Array or value - Seed value(s) for the generator.                                                      // 20
//                          If an array, will be used as-is                                                       // 21
//                          If a value, will be converted to a single-value array                                 // 22
//                          If omitted, a random array will be used as the seed.                                  // 23
RandomStream = function(options) { // 24
  var self = this; // 25
  // 26
  this.seed = [].concat(options.seed || randomToken()); // 27
  // 28
  this.sequences = {}; // 29
}; // 30
// 31
// Returns a random string of sufficient length for a random seed.                                                // 32
// This is a placeholder function; a similar function is planned                                                  // 33
// for Random itself; when that is added we should remove this function,                                          // 34
// and call Random's randomToken instead.                                                                         // 35
function randomToken() { // 36
  return Random.hexString(20); // 37
}; // 38
// 39
// Returns the random stream with the specified name, in the specified scope.                                     // 40
// If scope is null (or otherwise falsey) then we will use Random, which will                                     // 41
// give us as random numbers as possible, but won't produce the same                                              // 42
// values across client and server.                                                                               // 43
// However, scope will normally be the current DDP method invocation, so                                          // 44
// we'll use the stream with the specified name, and we should get consistent                                     // 45
// values on the client and server sides of a method call.                                                        // 46
RandomStream.get = function(scope, name) { // 47
  if (!name) { // 48
    name = "default"; // 49
  } // 50
  if (!scope) { // 51
    // There was no scope passed in;                                                                              // 52
    // the sequence won't actually be reproducible.                                                               // 53
    return Random; // 54
  } // 55
  var randomStream = scope.randomStream; // 56
  if (!randomStream) { // 57
    scope.randomStream = randomStream = new RandomStream({ // 58
      seed: scope.randomSeed // 59
    }); // 60
  } // 61
  return randomStream._sequence(name); // 62
}; // 63
// 64
// Returns the named sequence of pseudo-random values.                                                            // 65
// The scope will be DDP._CurrentInvocation.get(), so the stream will produce                                     // 66
// consistent values for method calls on the client and server.                                                   // 67
DDP.randomStream = function(name) { // 68
  var scope = DDP._CurrentInvocation.get(); // 69
  return RandomStream.get(scope, name); // 70
}; // 71
// 72
// Creates a randomSeed for passing to a method call.                                                             // 73
// Note that we take enclosing as an argument,                                                                    // 74
// though we expect it to be DDP._CurrentInvocation.get()                                                         // 75
// However, we often evaluate makeRpcSeed lazily, and thus the relevant                                           // 76
// invocation may not be the one currently in scope.                                                              // 77
// If enclosing is null, we'll use Random and values won't be repeatable.                                         // 78
makeRpcSeed = function(enclosing, methodName) { // 79
  var stream = RandomStream.get(enclosing, '/rpc/' + methodName); // 80
  return stream.hexString(20); // 81
}; // 82
// 83
_.extend(RandomStream.prototype, { // 84
  // Get a random sequence with the specified name, creating it if does not exist.                                // 85
  // New sequences are seeded with the seed concatenated with the name.                                           // 86
  // By passing a seed into Random.create, we use the Alea generator.                                             // 87
  _sequence: function(name) { // 88
    var self = this; // 89
    // 90
    var sequence = self.sequences[name] || null; // 91
    if (sequence === null) { // 92
      var sequenceSeed = self.seed.concat(name); // 93
      for (var i = 0; i < sequenceSeed.length; i++) { // 94
        if (_.isFunction(sequenceSeed[i])) { // 95
          sequenceSeed[i] = sequenceSeed[i](); // 96
        } // 97
      } // 98
      self.sequences[name] = sequence = Random.createWithSeeds.apply(null, sequenceSeed); // 99
    } // 100
    return sequence; // 101
  } // 102
}); // 103
// 104
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////



module.exports = {
  DDP: DDP
}