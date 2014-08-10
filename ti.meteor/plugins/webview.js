var WebView = {};

WebView.importToken = function(webView) {
	if (Meteor.userId()) {
		var payload = 'try {' +
			'localStorage.setItem("Meteor.userId","' + Accounts._storedUserId() + '");' +
			'localStorage.setItem("Meteor.loginToken","' + Accounts._storedLoginToken() + '");' +
			'localStorage.setItem("Meteor.loginTokenExpires","' + Accounts._storedLoginTokenExpires() + '");' +
			'} catch(e) { alert(e)}';
		webView.evalJS(payload);
		webView.reload();
	} else {
		console.log("TiMeteor.WebView.importToken(): User is not logged in");
	}
}

WebView.exportToken = function(webView) {
	return token = {
		userId: webView.evalJS('localStorage.getItem("Meteor.userId")'),
		loginToken: webView.evalJS('localStorage.getItem("Meteor.loginToken")'),
		loginTokenExpires: webView.evalJS('localStorage.getItem("Meteor.loginTokenExpires")')
	};
}

WebView.removeToken = function(webView) {
	var payload = 'try {' +
		'localStorage.removeItem("Meteor.userId");' +
		'localStorage.removeItem("Meteor.loginToken");' +
		'localStorage.removeItem("Meteor.loginTokenExpires");' +
		'} catch(e) { alert(e)}';
	webView.evalJS(payload);
};

module.exports = WebView;