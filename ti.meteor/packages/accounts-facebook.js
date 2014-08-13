Accounts.oauth.registerService('facebook');

Facebook = {};

Facebook.requestCredential = function (options, credentialRequestCompleteCallback) {
  // support both (options, callback) and (callback).
  if (!credentialRequestCompleteCallback && typeof options === 'function') {
    credentialRequestCompleteCallback = options;
    options = {};
  }

  var config = ServiceConfiguration.configurations.findOne({service: 'facebook'});
  if (!config) {
    credentialRequestCompleteCallback && credentialRequestCompleteCallback(
      new ServiceConfiguration.ConfigError());
    return;
  }

  var credentialToken = Random.secret();
  var display = 'touch';

  var scope = "email";
  if (options && options.requestPermissions)
    scope = options.requestPermissions.join(',');

  var loginUrl =
        'https://www.facebook.com/dialog/oauth?client_id=' + config.clientId +
        '&redirect_uri=' + Meteor.absoluteUrl('_oauth/facebook?close') +
        '&display=' + display + '&scope=' + scope + '&state=' + credentialToken;

  OAuth.showPopup(
    loginUrl,
    _.bind(credentialRequestCompleteCallback, null, credentialToken)
  );
};

Meteor.loginWithFacebook = function(options, callback) {
  // support a callback without options
  if (!callback && typeof options === "function") {
    callback = options;
    options = null;
  }

  var credentialRequestCompleteCallback = Accounts.oauth.credentialRequestCompleteHandler(callback);
  Facebook.requestCredential(options, credentialRequestCompleteCallback);
};