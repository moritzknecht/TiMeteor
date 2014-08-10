// Meteor.refresh can be called on the client (if you're in common code) but it
// only has an effect on the server.

module.exports = function(options) {

  Meteor.refresh = function(notification) {};

  var retry = new Retry();

  var onDDPVersionNegotiationFailure = function(description) {
    Meteor._debug(description);
    if (Package.reload) {
      var migrationData = Package.reload.Reload._migrationData('livedata') || {};
      var failures = migrationData.DDPVersionNegotiationFailures || 0;
      ++failures;
      Package.reload.Reload._onMigrate('livedata', function() {
        return [true, {
          DDPVersionNegotiationFailures: failures
        }];
      });
      retry.retryLater(failures, function() {
        Package.reload.Reload._reload();
      });
    }
  };

  Meteor.connection = DDP.connect(options, {
      onDDPVersionNegotiationFailure: onDDPVersionNegotiationFailure
    });

  // Proxy the public methods of Meteor.connection so they can
  // be called directly on Meteor.
  _.each(['subscribe', 'methods', 'call', 'apply', 'status', 'reconnect', 'disconnect'],
    function(name) {
      Meteor[name] = _.bind(Meteor.connection[name], Meteor.connection);
    });

  Meteor.default_connection = Meteor.connection;
  Meteor.connect = DDP.connect;

}