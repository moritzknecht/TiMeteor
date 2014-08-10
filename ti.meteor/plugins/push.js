var Push = {},
	OS_ANDROID = OS_ANDROID || Ti.Platform.osname == "android",
	OS_IOS = OS_IOS || !OS_ANDROID;

Push.received = function() {};

Push.unregisterDevice = function() {
	OS_IOS ? Ti.Network.unregisterForPushNotifications() : require('net.iamyellow.gcmjs').unregister();
};

Push.registerDevice = function(callback) {
	callback = callback || function() {};

	function deviceTokenSuccess(e) {
		Ti.App.Properties.setString("deviceToken", e.deviceToken);
		if (Meteor && Meteor.userId()) {
			Meteor.call("registerToken", {
				platform: OS_IOS ? "ios": "android",
				deviceToken: e.deviceToken
			}, function(error, data) {
				callback(error || data);
			});
		}
		callback(e);
	}

	if (OS_IOS) {

		Ti.Network.registerForPushNotifications({
			types: [
				Ti.Network.NOTIFICATION_TYPE_BADGE,
				Ti.Network.NOTIFICATION_TYPE_ALERT,
				Ti.Network.NOTIFICATION_TYPE_SOUND
			],
			success: deviceTokenSuccess,
			error: callback,
			callback: Push.received
		});

	} else {
		var gcm = require('net.iamyellow.gcmjs')

		var pendingData = gcm.data;
		if (pendingData && pendingData !== null) {
			Ti.API.info('******* data (started) ' + JSON.stringify(pendingData));
		}

		gcm.registerForPushNotifications({
			success: deviceTokenSuccess,
			error: callback,
			callback: Push.received,
			unregister: callback,
			data: callback,
		});
	}
};

module.exports = Push;