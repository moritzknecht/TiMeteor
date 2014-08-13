MeteorDeveloperAccounts = {};

MeteorDeveloperAccounts._server = "https://www.meteor.com";

// Options are:
//  - developerAccountsServer: defaults to "https://www.meteor.com"
MeteorDeveloperAccounts._config = function (options) {
  if (options.developerAccountsServer) {
    MeteorDeveloperAccounts._server = options.developerAccountsServer;
  }
};

var requestCredential = function (options, credentialRequestCompleteCallback) {
  // support a callback without options
  if (! credentialRequestCompleteCallback && typeof options === "function") {
    credentialRequestCompleteCallback = options;
    options = null;
  }

  var config = {
    clienId:""
  };

  var credentialToken = Random.secret();

  var loginUrl =
        MeteorDeveloperAccounts._server +
        "/oauth2/authorize?" +
        "state=" + credentialToken +
        "&response_type=code&" +
        "client_id=" + config.clientId;

  if (options && options.userEmail)
    loginUrl += '&user_email=' + encodeURIComponent(options.userEmail);

  loginUrl += "&redirect_uri=" + Meteor.absoluteUrl("_oauth/meteor-developer?close");

  OAuth.showPopup(
    loginUrl,
    _.bind(credentialRequestCompleteCallback, null, credentialToken),
    {
      width: 470,
      height: 420
    }
  );
};

MeteorDeveloperAccounts.requestCredential = requestCredential;


Accounts.oauth.registerService("meteor-developer");

if (Meteor.isClient) {
  Meteor.loginWithMeteorDeveloperAccount = function (options, callback) {
    // support a callback without options
    if (! callback && typeof options === "function") {
      callback = options;
      options = null;
    }

    var credentialRequestCompleteCallback =
          Accounts.oauth.credentialRequestCompleteHandler(callback);
    MeteorDeveloperAccounts.requestCredential(options, credentialRequestCompleteCallback);
  };
} else {
  Accounts.addAutopublishFields({
    // publish all fields including access token, which can legitimately be used
    // from the client (if transmitted over ssl or on localhost).
    forLoggedInUser: ['services.meteor-developer'],
    forOtherUsers: [
      'services.meteor-developer.username',
      'services.meteor-developer.profile',
      'services.meteor-developer.id'
    ]
  });
}