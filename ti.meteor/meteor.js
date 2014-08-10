var packageDir = "ti.meteor/packages/";

_ = typeof Alloy != "undefined" ? require("alloy/underscore")._ : require(packageDir + 'underscore');
Meteor = require(packageDir + 'meteor').Meteor;
var Accounts = {},
	OS_ANDROID = OS_ANDROID || Ti.Platform.osname == "android",
	OS_IOS = OS_IOS || !OS_ANDROID,
	Session = require(packageDir + 'reactive-dict').ReactiveDict;

require(packageDir + 'dynamics_browser');
require(packageDir + 'errors');


// Setup the Package Namespace
// Fake some namespaces, to avoid errors

var Package = {
	json: {
		JSON: JSON
	},
	logging: {
		Log: function(str) {
			console.log("Meteor Log: " + str);
		}
	},
};

var basePackages = ["ejson", "meteor", "id-map", "ordered-dict", "deps", "check", "random", "geojson-utils", "retry"];
_.each(basePackages, function(key) {
	Package[key] = require(packageDir + key);
});

// Complete the Package namespace
// finally require the other packages in the right order

var init = function(options) {

	Package.minimongo = require(packageDir + 'minimongo');
	Package.livedata = require(packageDir + 'livedata-connection');

	var initPackages = ["mongo-livedata", "client_convenience", "accounts_common", "accounts_client", "ti_app_properties_token", "password_client"];
	_.each(initPackages, function(key) {
		key == "client_convenience" ? require(packageDir + key)(options) : require(packageDir + key);
	});
};

module.exports = {
	Meteor: Meteor,
	Package: Package,
	Accounts: Accounts,
	_: _,
	Deps: Package.deps.Deps,
	Session: new Session(),
	init: init,
};