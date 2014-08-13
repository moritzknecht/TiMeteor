// credentialToken -> credentialSecret. You must provide both the
// credentialToken and the credentialSecret to retrieve an access token from
// the _pendingCredentials collection.
var credentialSecrets = {};

OAuth = {
  popup:null,
  webView:null,
  _localStorageTokenPrefix:"Meteor.oauth."
};


// Open a popup window, centered on the screen, and call a callback when it
// closes.
//
// @param url {String} url to show
// @param callback {Function} Callback function to call on completion. Takes no
//   arguments.
// @param dimensions {optional Object(width, height)} The dimensions of
//   the popup. If not passed defaults to something sane.
OAuth.showPopup = function (url, callback, dimensions) {
  // default dimensions that worked well for facebook and google
  console.log("url: "+url);
  if (Ti.Platform.osname == "android") {
      var win = Ti.UI.createView();
       var popup = Ti.UI.createWindow({title:"Login", modal:true});
       popup.add(win);
  } else {
    var win = Ti.UI.createWindow({title:"Login", modal:true});
    var backButton = Ti.UI.createButton({ systemButton: Ti.UI.iPhone.SystemButton.CANCEL });
    backButton.addEventListener('click', function() {
      OAuth.popup.close();
    });
    win.setRightNavButton(backButton);
    var popup = Ti.UI.iOS.createNavigationWindow({window:win, modal:true});
  }
  
  var webView = Ti.UI.createWebView({url:url});
  OAuth.popup = popup;
  OAuth.webView = webView;
  webView.addEventListener('load', function(e) {
    console.log("OAuth.webView.load: "+JSON.stringify(e));
    callback();
  });

  win.add(webView);
  popup.open();

/*
  openCenteredPopup(
    url,
    (dimensions && dimensions.width) || 650,
    (dimensions && dimensions.height) || 331
  );*/
/*
  var checkPopupOpen = setInterval(function() {
    try {
      // Fix for #328 - added a second test criteria (popup.closed === undefined)
      // to humour this Android quirk:
      // http://code.google.com/p/android/issues/detail?id=21061
      var popupClosed = popup.closed || popup.closed === undefined;
    } catch (e) {
      // For some unknown reason, IE9 (and others?) sometimes (when
      // the popup closes too quickly?) throws "SCRIPT16386: No such
      // interface supported" when trying to read 'popup.closed'. Try
      // again in 100ms.
      return;
    }

    if (popupClosed) {
      clearInterval(checkPopupOpen);
      callback();
    }
  }, 100);*/
};


// XXX COMPAT WITH 0.7.0.1
// Private interface but probably used by many oauth clients in atmosphere.
OAuth.initiateLogin = function (credentialToken, url, callback, dimensions) {
  OAuth.showPopup(
    url,
    _.bind(callback, null, credentialToken),
    dimensions
  );
};

// Called by the popup when the OAuth flow is completed, right before
// the popup closes.
OAuth._handleCredentialSecret = function (credentialToken, secret) {
  check(credentialToken, String);
  check(secret, String);
  if (! _.has(credentialSecrets,credentialToken)) {
    credentialSecrets[credentialToken] = secret;
  } else {
    throw new Error("Duplicate credential token from OAuth login");
  }
};

// Used by accounts-oauth, which needs both a credentialToken and the
// corresponding to credential secret to call the `login` method over DDP.
OAuth._retrieveCredentialSecret = function (credentialToken) {
  console.log("_retrieveCredentialSecret: ");
  // First check the secrets collected by OAuth._handleCredentialSecret,
  // then check localStorage. This matches what we do in
  // end_of_login_response.html.
  var secret = credentialSecrets[credentialToken];
  if (! secret) {
    var localStorageKey = OAuth._localStorageTokenPrefix +
          credentialToken;
    console.log("localStorageKey: "+localStorageKey);
    //secret = Meteor._localStorage.getItem(localStorageKey);
    secret = OAuth.webView.evalJS('credentialSecret');
    var secret2 = Ti.Network.getHTTPCookiesForDomain("http://192.168.0.70/");
    console.log("secret2:"+secret2);


    console.log("secret: "+JSON.stringify(secret));
    OAuth.webView.evalJS('localStorage.removeItem("'+localStorageKey+'")');
  } else {
    delete credentialSecrets[credentialToken];
  }
  if (secret !== "") {
      Ti.Network.removeAllHTTPCookies();
      if (Ti.Platform.osname == "android") {
        Ti.Network.removeAllSystemCookies();
      }
      //OAuth.popup.remove(OAuth.popup.children[0]);
      OAuth.popup.close();
      OAuth.popup = null;
  }
  return secret;
};